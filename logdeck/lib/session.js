import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { RingBuffer } from './logbuffer.js';
import { LineSplitter } from './linesplitter.js';
import { FileTail, readTailLines } from './filetail.js';
import { ensureDir, sleep, killTree, timestampLocal } from './util.js';

const DEFAULT_BUFFER_LINES = 4000;

export class Session {
  constructor(manager, cfg) {
    this.manager = manager;
    this.cfg = cfg;
    this.id = cfg.id;
    this.name = cfg.name || cfg.id;
    this.type = cfg.type === 'file' ? 'file' : 'process';
    this.buffer = new RingBuffer(Number(cfg.bufferLines) || DEFAULT_BUFFER_LINES);
    this.seq = 0;
    this.pending = { stdout: 0, stderr: 0, file: 0 };
    this.status = 'stopped';
    this.pid = null;
    this.exitCode = null;
    this.signal = null;
    this.startedAt = null;
    this.endedAt = null;
    this.lastLineAt = null;
    this.restarts = 0;
    this.stopRequested = false;
    this.child = null;
    this.logStream = null;
    this.logBytes = 0;
    this.splitters = {};
    this.decoders = {};
    this.tail = null;
    this.health = null;
    this._exited = true;
    this._restartTimer = null;
    this._singleHealthTimer = null;
  }

  get logFile() {
    return path.join(this.manager.logsDir, this.id + '.log');
  }

  async init() {
    if (this.type === 'process') {
      await this.loadProcessHistory();
    } else {
      await this.loadFileSessionHistory();
    }
    await this.refreshLogBytes();
  }

  async loadProcessHistory() {
    try {
      const limit = Math.max(50, Number(this.cfg.historyLines) || 300);
      const hist = await readTailLines(this.logFile, limit);
      for (const line of hist.lines) {
        this.buffer.push({ seq: ++this.seq, ts: Date.now(), stream: 'history', text: line });
      }
    } catch {
      /* no log yet */
    }
  }

  async loadFileSessionHistory() {
    try {
      const target = this.cfg.path ? path.resolve(this.manager.root, this.cfg.path) : '';
      if (!target) return;
      const limit = Math.max(50, Number(this.cfg.historyLines) || 300);
      const hist = await readTailLines(target, limit);
      for (const line of hist.lines) {
        this.buffer.push({ seq: ++this.seq, ts: Date.now(), stream: 'file', text: line });
      }
    } catch {
      /* file may not exist yet */
    }
  }

  async refreshLogBytes() {
    try {
      const st = await fsp.stat(this.logFile);
      this.logBytes = st.size;
    } catch {
      this.logBytes = 0;
    }
  }

  makeSplitters(streams) {
    const make = () =>
      new LineSplitter(
        (line, stream) => this.onLineComplete(line, stream),
        (partial, stream) => this.onPartial(partial, stream)
      );
    this.splitters = {};
    for (const key of streams) this.splitters[key] = make();
    this.decoders = {};
  }

  buildEnv(cwd) {
    const env = { ...process.env };
    const custom = this.cfg.env && typeof this.cfg.env === 'object' ? this.cfg.env : {};
    for (const key of Object.keys(custom)) env[key] = String(custom[key]);
    const prepend = Array.isArray(this.cfg.pathPrepend) ? this.cfg.pathPrepend : [];
    if (prepend.length) {
      const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') || 'PATH';
      const parts = prepend
        .filter(Boolean)
        .map((item) => (path.isAbsolute(item) ? item : path.join(cwd, item)));
      env[pathKey] = parts.join(path.delimiter) + path.delimiter + (env[pathKey] || '');
    }
    return env;
  }

  async rotateLogIfNeeded() {
    const maxMb = Number(this.manager.config.maxLogMb) || 20;
    try {
      const st = await fsp.stat(this.logFile);
      if (st.size > maxMb * 1024 * 1024) {
        const backup = this.logFile + '.1';
        try {
          await fsp.rm(backup, { force: true });
        } catch {
          /* ignore */
        }
        await fsp.rename(this.logFile, backup);
      }
    } catch {
      /* no file */
    }
  }

  async openLog(reason) {
    try {
      ensureDir(path.dirname(this.logFile));
      await this.rotateLogIfNeeded();
      this.logStream = fs.createWriteStream(this.logFile, { flags: 'a' });
      this.logStream.on('error', () => {});
      const header =
        '\n===== [LogDeck] ' +
        new Date().toLocaleString('zh-CN', { hour12: false }) +
        (reason ? ' ' + reason : '') +
        ' =====\n';
      this.logStream.write(header);
      await this.refreshLogBytes();
    } catch {
      this.logStream = null;
    }
  }

  closeLog() {
    if (!this.logStream) return;
    try {
      this.logStream.end();
    } catch {
      /* ignore */
    }
    this.logStream = null;
  }

  buildParsers() {
    this.makeSplitters(['stdout', 'stderr']);
  }

  handleChunk(buf, stream) {
    let decoder = this.decoders[stream];
    if (!decoder) {
      const encoding = this.cfg.encoding === 'gbk' ? 'gb18030' : 'utf-8';
      decoder = new TextDecoder(encoding);
      this.decoders[stream] = decoder;
    }
    let text = '';
    try {
      text = decoder.decode(buf, { stream: true });
    } catch {
      text = buf.toString('utf8');
    }
    if (!text) return;
    if (this.logStream) {
      try {
        this.logStream.write(text);
        this.logBytes += Buffer.byteLength(text);
      } catch {
        /* ignore */
      }
    }
    this.lastLineAt = Date.now();
    const splitter = this.splitters[stream];
    if (splitter) splitter.feed(text, stream);
  }

  emitLine(seq, text, stream, replace) {
    const item = { seq, ts: Date.now(), stream, text };
    if (replace) this.buffer.replaceBySeq(seq, item);
    else this.buffer.push(item);
    this.lastLineAt = item.ts;
    this.manager.onLine(this, item);
  }

  onPartial(text, stream) {
    const pending = this.pending[stream];
    if (pending) {
      this.emitLine(pending, text, stream, true);
    } else {
      const seq = ++this.seq;
      this.pending[stream] = seq;
      this.emitLine(seq, text, stream, false);
    }
  }

  onLineComplete(text, stream) {
    const pending = this.pending[stream];
    if (pending) {
      this.pending[stream] = 0;
      this.emitLine(pending, text, stream, true);
    } else {
      this.emitLine(++this.seq, text, stream, false);
    }
  }

  flushAllPending() {
    for (const stream of Object.keys(this.splitters)) {
      const splitter = this.splitters[stream];
      if (splitter) splitter.flush(stream);
    }
  }

  system(text) {
    this.flushAllPending();
    const seq = ++this.seq;
    const item = { seq, ts: Date.now(), stream: 'system', text: '[LogDeck] ' + text };
    this.buffer.push(item);
    this.lastLineAt = item.ts;
    this.manager.onLine(this, item);
    if (this.logStream) {
      try {
        this.logStream.write('\n[LogDeck ' + timestampLocal(item.ts) + '] ' + text + '\n');
      } catch {
        /* ignore */
      }
    }
    return item;
  }

  async start() {
    if (this.status === 'running' || this.status === 'starting' || this.status === 'stopping') {
      throw new Error('会话已经在运行或正在切换状态');
    }
    this.manager.clearRestart(this);
    this.manager.clearSingleHealth(this);
    if (this.type === 'file') return this.startFile();
    return this.startProcess();
  }

  async startProcess() {
    const command = String(this.cfg.command || '').trim();
    if (!command) throw new Error('命令不能为空');
    const cwd = this.cfg.cwd ? path.resolve(this.manager.root, this.cfg.cwd) : this.manager.root;
    if (!fs.existsSync(cwd)) throw new Error('工作目录不存在: ' + cwd);
    this.stopRequested = false;
    this._exited = false;
    this.status = 'starting';
    this.exitCode = null;
    this.signal = null;
    this.endedAt = null;
    this.startedAt = Date.now();
    this.pending = { stdout: 0, stderr: 0, file: 0 };
    this.buildParsers();
    await this.openLog('启动');
    this.system('启动: ' + command + '  (cwd: ' + cwd + ')');
    let child;
    try {
      child = spawn(command, {
        cwd,
        env: this.buildEnv(cwd),
        shell: true,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.status = 'error';
      this.system('启动失败: ' + (err && err.message ? err.message : String(err)));
      this.manager.broadcastSession(this);
      throw err;
    }
    this.child = child;
    this.pid = child.pid || null;
    this.status = 'running';
    this.lastLineAt = Date.now();
    this.manager.broadcastSession(this);
    this.manager.saveRuntime();
    child.stdout.on('data', (buf) => this.handleChunk(buf, 'stdout'));
    child.stderr.on('data', (buf) => this.handleChunk(buf, 'stderr'));
    child.on('error', (err) => {
      this.system('进程错误: ' + (err && err.message ? err.message : String(err)));
      if (this.child) this.finalizeExit(1, null);
    });
    child.on('exit', (code, signal) => this.finalizeExit(code, signal));
    this.manager.scheduleHealthCheck(this, 2500);
    return this;
  }

  async startFile() {
    const target = this.cfg.path ? path.resolve(this.manager.root, this.cfg.path) : '';
    if (!target) throw new Error('日志文件路径不能为空');
    let st = null;
    try {
      st = await fsp.stat(target);
    } catch {
      st = null;
    }
    this.stopRequested = false;
    this._exited = false;
    this.status = 'starting';
    this.startedAt = Date.now();
    this.endedAt = null;
    this.exitCode = null;
    this.signal = null;
    this.buffer.clear();
    this.seq = 0;
    this.pending = { stdout: 0, stderr: 0, file: 0 };
    this.makeSplitters(['file']);
    this.manager.broadcastSession(this);
    const fromBeginning = !!this.cfg.fromBeginning;
    const limit = Math.max(50, Number(this.cfg.historyLines) || 300);
    let hist = { lines: [], size: 0 };
    if (st) {
      if (fromBeginning) {
        hist = { lines: [], size: st.size };
      } else {
        try {
          hist = await readTailLines(target, limit);
        } catch {
          hist = { lines: [], size: st.size };
        }
      }
      for (const line of hist.lines) {
        this.emitLine(++this.seq, line, 'file', false);
      }
    }
    if (st) {
      this.system('开始跟踪文件: ' + target + (fromBeginning ? ' (从头)' : ' (从末尾)'));
    } else {
      this.system('暂时读不到日志文件，会在它出现后自动开始跟踪: ' + target);
    }
    this.tail = new FileTail(target, {
      pollMs: 500,
      onChunk: (text) => this.feedFileText(text),
      onError: (err) => {
        if (this.status !== 'running') return;
        const now = Date.now();
        if (!this._fileErrorAt || now - this._fileErrorAt > 30000) {
          this._fileErrorAt = now;
          this.system('读取日志文件失败: ' + (err && err.message ? err.message : String(err)));
        }
      },
      onRotate: () => this.system('日志文件被截断或轮转，已从头继续跟踪'),
    });
    await this.tail.start(st ? (fromBeginning ? 0 : hist.size) : null);
    this.status = 'running';
    this.lastLineAt = Date.now();
    this.manager.broadcastSession(this);
    this.manager.saveRuntime();
    return this;
  }

  feedFileText(text) {
    this.lastLineAt = Date.now();
    this._fileErrorAt = 0;
    const splitter = this.splitters.file;
    if (splitter) splitter.feed(text, 'file');
  }

  shouldRestart() {
    if (this.type === 'file') return false;
    const policy = this.cfg.restartPolicy || 'on-failure';
    if (policy === 'never') return false;
    if (policy === 'on-failure' && this.exitCode === 0) return false;
    const max = Number(this.cfg.maxRestarts);
    const limit = Number.isFinite(max) ? max : 10;
    return this.restarts < limit;
  }

  finalizeExit(code, signal) {
    if (this._exited) return;
    this._exited = true;
    this.flushAllPending();
    for (const key of Object.keys(this.decoders)) {
      try {
        const rest = this.decoders[key].decode();
        if (rest) {
          const splitter = this.splitters[key];
          if (splitter) splitter.feed(rest, key);
        }
      } catch {
        /* ignore */
      }
    }
    this.flushAllPending();
    const wasStopping = this.stopRequested;
    this.child = null;
    this.pid = null;
    this.exitCode = typeof code === 'number' ? code : null;
    this.signal = signal || null;
    this.endedAt = Date.now();
    if (this.startedAt && Date.now() - this.startedAt > 60000) this.restarts = 0;
    this.status = wasStopping ? 'stopped' : this.exitCode === 0 ? 'exited' : 'crashed';
    this.health = null;
    this.system(
      '进程退出' +
        (this.exitCode !== null ? ' code=' + this.exitCode : '') +
        (this.signal ? ' signal=' + this.signal : '') +
        (wasStopping ? '（手动停止）' : '')
    );
    this.closeLog();
    this.manager.broadcastSession(this);
    this.manager.saveRuntime();
    if (!wasStopping && this.shouldRestart()) this.manager.scheduleRestart(this);
  }

  async stop() {
    this.manager.clearRestart(this);
    this.manager.clearSingleHealth(this);
    if (this.type === 'file') {
      this.stopFile();
      return this;
    }
    if (!this.child) {
      if (this.status !== 'stopped') {
        this.status = 'stopped';
        this.manager.broadcastSession(this);
      }
      return this;
    }
    this.stopRequested = true;
    this.status = 'stopping';
    this.manager.broadcastSession(this);
    const pid = this.pid;
    try {
      await killTree(pid, false);
    } catch {
      /* ignore */
    }
    await sleep(900);
    if (this.child) {
      try {
        await killTree(pid, true);
      } catch {
        /* ignore */
      }
    }
    await sleep(400);
    if (this.child) this.finalizeExit(null, 'SIGKILL');
    await sleep(100);
    if (this.status === 'stopping') {
      this.status = 'stopped';
      this.manager.broadcastSession(this);
    }
    this.manager.saveRuntime();
    return this;
  }

  stopFile() {
    this.manager.clearRestart(this);
    if (this.tail) {
      this.tail.stop();
      this.tail = null;
    }
    this.flushAllPending();
    this.stopRequested = true;
    this.status = 'stopped';
    this.endedAt = Date.now();
    this.health = null;
    this.system('停止跟踪文件');
    this.manager.broadcastSession(this);
    this.manager.saveRuntime();
  }

  async restart() {
    await this.stop();
    await sleep(500);
    return this.start();
  }

  async clear() {
    this.flushAllPending();
    this.buffer.clear();
    this.seq = 0;
    this.pending = { stdout: 0, stderr: 0, file: 0 };
    for (const key of Object.keys(this.splitters)) {
      if (this.splitters[key]) this.splitters[key].reset();
    }
    if (this.type === 'process') {
      if (this.logStream) {
        this.closeLog();
        try {
          await fsp.truncate(this.logFile, 0);
        } catch {
          /* ignore */
        }
        await this.openLog('清空日志');
      } else {
        try {
          await fsp.truncate(this.logFile, 0);
        } catch {
          /* ignore */
        }
      }
    }
    this.logBytes = 0;
    this.lastLineAt = Date.now();
    this.manager.broadcastReset(this);
    this.manager.broadcastSession(this);
    return this;
  }

  async sendInput(text, enter = true) {
    if (this.type === 'file') throw new Error('文件跟踪会话不接受输入');
    if (!this.child || !this.child.stdin || !this.child.stdin.writable) {
      throw new Error('会话未运行，无法发送输入');
    }
    const value = text === undefined || text === null ? '' : String(text);
    this.child.stdin.write(value + (enter ? '\n' : ''));
    this.system('输入 > ' + value);
    return true;
  }

  publicInfo() {
    const cfg = this.cfg;
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      status: this.status,
      pid: this.pid,
      command: cfg.command || '',
      cwd: cfg.cwd || '',
      path: cfg.path || '',
      tags: Array.isArray(cfg.tags) ? cfg.tags : [],
      color: cfg.color || '',
      autostart: !!cfg.autostart,
      restartPolicy: cfg.restartPolicy || 'never',
      maxRestarts: cfg.maxRestarts,
      healthCheck: cfg.healthCheck || null,
      health: this.health || null,
      createdAt: cfg.createdAt || null,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      exitCode: this.exitCode,
      signal: this.signal,
      restarts: this.restarts,
      logFile: this.type === 'process' ? this.logFile : cfg.path || '',
      logBytes: this.logBytes,
      lastLineAt: this.lastLineAt,
      lines: this.buffer.size,
      seq: this.seq,
      bufferLines: cfg.bufferLines || DEFAULT_BUFFER_LINES,
      takeoverPatterns: Array.isArray(cfg.takeoverPatterns) ? cfg.takeoverPatterns : [],
    };
  }
}
