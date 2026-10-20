import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { Session } from './session.js';
import { saveConfig } from './config.js';
import {
  clamp,
  isPidAlive,
  killTree,
  listProcesses,
  getProcessCommandLine,
  normalizeHealthCheck,
  randomId,
  readJson,
  sleep,
  slugify,
  writeJsonAtomic,
} from './util.js';

function commandFingerprint(command) {
  const tokens = String(command || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  for (const token of tokens) {
    if (/\.(py|js|mjs|cjs|exe|bat|cmd|ps1)$/i.test(token)) {
      return path.basename(token).toLowerCase();
    }
  }
  return (tokens[0] || '').toLowerCase();
}

export function normalizeSessionCfg(raw, index = 0) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const type = input.type === 'file' ? 'file' : 'process';
  const name = String(input.name || input.id || '会话 ' + (index + 1)).trim();
  const id = String(input.id || '').trim() || slugify(name) || randomId('s');
  const cfg = {
    id,
    name,
    type,
    command: type === 'process' ? String(input.command || '').trim() : '',
    cwd: String(input.cwd || '').trim(),
    path: type === 'file' ? String(input.path || '').trim() : '',
    env: input.env && typeof input.env === 'object' ? input.env : {},
    pathPrepend: Array.isArray(input.pathPrepend) ? input.pathPrepend.map(String) : [],
    encoding: input.encoding === 'gbk' ? 'gbk' : 'utf8',
    tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
    color: String(input.color || ''),
    autostart: input.autostart === true,
    restartPolicy: ['never', 'on-failure', 'always'].includes(input.restartPolicy)
      ? input.restartPolicy
      : 'never',
    maxRestarts: Number.isFinite(Number(input.maxRestarts)) ? clamp(Number(input.maxRestarts), 0, 100) : 10,
    restartDelayMs: Number.isFinite(Number(input.restartDelayMs))
      ? clamp(Number(input.restartDelayMs), 300, 600000)
      : 2000,
    healthCheck: normalizeHealthCheck(input.healthCheck),
    bufferLines: clamp(Number(input.bufferLines) || 4000, 100, 20000),
    historyLines: clamp(Number(input.historyLines) || 300, 0, 3000),
    fromBeginning: input.fromBeginning === true,
    takeoverPatterns: Array.isArray(input.takeoverPatterns)
      ? input.takeoverPatterns.map(String).map((item) => item.trim()).filter(Boolean)
      : [],
    createdAt: input.createdAt || new Date().toISOString(),
    order: Number.isFinite(Number(input.order)) ? Number(input.order) : index,
  };
  return cfg;
}

function tcpCheck(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const socket = new net.Socket();
    const finish = (ok) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    try {
      socket.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

export async function checkHealth(healthCheck) {
  const started = Date.now();
  const hc = healthCheck;
  try {
    if (hc.type === 'http') {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), hc.timeoutMs);
      let status = 0;
      try {
        const res = await fetch(hc.url, { signal: controller.signal, redirect: 'manual' });
        status = res.status;
      } finally {
        clearTimeout(timer);
      }
      const ok = hc.expectStatus ? status === hc.expectStatus : status < 500;
      return {
        ok,
        checkedAt: Date.now(),
        ms: Date.now() - started,
        target: hc.url,
        status,
      };
    }
    const ok = await tcpCheck(hc.host, hc.port, hc.timeoutMs);
    return {
      ok,
      checkedAt: Date.now(),
      ms: Date.now() - started,
      target: hc.host + ':' + hc.port,
    };
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    return {
      ok: false,
      checkedAt: Date.now(),
      ms: Date.now() - started,
      target: hc.url || hc.host + ':' + hc.port,
      error: aborted ? '超时' : err && err.message ? err.message : String(err),
    };
  }
}

export class SessionManager {
  constructor(config, onEvent) {
    this.config = config;
    this.root = config.root;
    this.logsDir = config.logsDirAbs;
    this.sessions = new Map();
    this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};
    this.healthTimer = null;
    this.takeoverTimer = null;
    this.takeoverBusy = false;
    this.takeoverHandled = new Map();
    this.startedAt = Date.now();
  }

  log(text) {
    const line = '[' + new Date().toLocaleString('zh-CN', { hour12: false }) + '] ' + text;
    try {
      fs.appendFileSync(this.config.managerLogPath, line + '\n');
    } catch {
      /* ignore */
    }
    try {
      console.log(line);
    } catch {
      /* ignore */
    }
  }

  async init() {
    for (let i = 0; i < this.config.sessions.length; i += 1) {
      const raw = this.config.sessions[i];
      const cfg = normalizeSessionCfg(raw, i);
      if (this.sessions.has(cfg.id)) {
        cfg.id = cfg.id + '-' + (i + 1);
      }
      const session = new Session(this, cfg);
      await session.init();
      this.sessions.set(cfg.id, session);
    }
    await this.cleanupOrphans();
    this.startHealthLoop();
    this.startTakeoverLoop();
    this.log('LogDeck 会话管理器已加载 ' + this.sessions.size + ' 个会话');
  }

  async cleanupOrphans() {
    const runtime = readJson(this.config.runtimePath, null);
    if (!runtime || !Array.isArray(runtime.sessions)) {
      try {
        await fsp.rm(this.config.runtimePath, { force: true });
      } catch {
        /* ignore */
      }
      return;
    }
    for (const entry of runtime.sessions) {
      if (!entry || !entry.pid) continue;
      if (!isPidAlive(entry.pid)) continue;
      const fingerprint = commandFingerprint(entry.command || '');
      const cmdline = (await getProcessCommandLine(entry.pid)).toLowerCase();
      if (fingerprint && cmdline.includes(fingerprint)) {
        this.log('清理上次退出遗留的进程 pid=' + entry.pid + ' (' + (entry.id || '') + ')');
        await killTree(entry.pid, true);
      }
    }
    try {
      await fsp.rm(this.config.runtimePath, { force: true });
    } catch {
      /* ignore */
    }
  }

  saveRuntime() {
    const data = {
      managerPid: process.pid,
      updatedAt: new Date().toISOString(),
      sessions: [],
    };
    for (const session of this.sessions.values()) {
      if (session.type === 'process' && session.pid) {
        data.sessions.push({
          id: session.id,
          pid: session.pid,
          command: session.cfg.command,
          startedAt: session.startedAt,
        });
      }
    }
    try {
      writeJsonAtomic(this.config.runtimePath, data);
    } catch (err) {
      this.log('保存运行状态失败: ' + (err && err.message ? err.message : String(err)));
    }
  }

  saveConfig() {
    this.config.sessions = Array.from(this.sessions.values()).map((session) => session.cfg);
    saveConfig(this.config);
  }

  list() {
    return Array.from(this.sessions.values())
      .sort((a, b) => {
        const oa = Number(a.cfg.order) || 0;
        const ob = Number(b.cfg.order) || 0;
        if (oa !== ob) return oa - ob;
        return a.name.localeCompare(b.name, 'zh-CN');
      })
      .map((session) => session.publicInfo());
  }

  get(id) {
    return this.sessions.get(String(id || '')) || null;
  }

  resolve(idOrName) {
    const key = String(idOrName || '').trim();
    if (!key) return null;
    if (this.sessions.has(key)) return this.sessions.get(key);
    const lower = key.toLowerCase();
    const byName = Array.from(this.sessions.values()).filter(
      (session) => session.name.toLowerCase() === lower
    );
    if (byName.length === 1) return byName[0];
    const byPrefix = Array.from(this.sessions.values()).filter((session) =>
      session.id.toLowerCase().startsWith(lower)
    );
    if (byPrefix.length === 1) return byPrefix[0];
    return null;
  }

  require(idOrName) {
    const session = this.resolve(idOrName);
    if (!session) throw new Error('找不到会话: ' + String(idOrName || ''));
    return session;
  }

  async createSession(input = {}) {
    const cfg = normalizeSessionCfg(input, this.sessions.size);
    if (!cfg.name) throw new Error('名称不能为空');
    if (cfg.type === 'process' && !cfg.command) throw new Error('命令不能为空');
    if (cfg.type === 'file' && !cfg.path) throw new Error('日志文件路径不能为空');
    let id = cfg.id;
    const base = id;
    let n = 1;
    while (this.sessions.has(id)) {
      n += 1;
      id = base + '-' + n;
    }
    cfg.id = id;
    const session = new Session(this, cfg);
    await session.init();
    this.sessions.set(id, session);
    this.saveConfig();
    this.broadcastSession(session);
    this.log('新增会话 ' + id + ' (' + cfg.name + ')');
    if (input.startNow) await session.start();
    return session;
  }

  async updateSession(idOrName, patch = {}) {
    const session = this.require(idOrName);
    const raw = { ...session.cfg };
    const allowed = [
      'name',
      'command',
      'cwd',
      'path',
      'env',
      'pathPrepend',
      'tags',
      'color',
      'autostart',
      'restartPolicy',
      'maxRestarts',
      'restartDelayMs',
      'healthCheck',
      'bufferLines',
      'historyLines',
      'fromBeginning',
      'encoding',
      'order',
      'takeoverPatterns',
    ];
    for (const key of allowed) {
      if (patch[key] !== undefined) raw[key] = patch[key];
    }
    if (patch.healthPort !== undefined) {
      raw.healthCheck = patch.healthPort
        ? { type: 'tcp', host: '127.0.0.1', port: Number(patch.healthPort) }
        : null;
    }
    if (patch.type && patch.type !== session.type) {
      if (session.status === 'running' || session.status === 'starting') {
        throw new Error('请先停止会话再修改类型');
      }
      raw.type = patch.type === 'file' ? 'file' : 'process';
    }
    const cfg = normalizeSessionCfg(raw, Number(session.cfg.order) || 0);
    cfg.id = session.id;
    session.cfg = cfg;
    session.name = cfg.name;
    session.type = cfg.type;
    session.buffer.max = cfg.bufferLines || 4000;
    this.saveConfig();
    this.broadcastSession(session);
    this.log('更新会话 ' + cfg.id);
    return session;
  }

  async deleteSession(idOrName, options = {}) {
    const session = this.require(idOrName);
    if (
      session.status === 'running' ||
      session.status === 'starting' ||
      session.status === 'stopping'
    ) {
      await session.stop();
    }
    this.clearRestart(session);
    this.clearSingleHealth(session);
    this.sessions.delete(session.id);
    this.saveConfig();
    this.onEvent({ type: 'remove', id: session.id });
    if (options.deleteLog) {
      try {
        await fsp.rm(session.logFile, { force: true });
      } catch {
        /* ignore */
      }
    }
    this.log('删除会话 ' + session.id);
    return true;
  }

  async startSession(idOrName) {
    const session = this.require(idOrName);
    await session.start();
    return session;
  }

  async ensureSession(idOrName) {
    const session = this.require(idOrName);
    if (session.status === 'running' || session.status === 'starting') return session;
    await session.start();
    return session;
  }

  startTakeoverLoop() {
    if (this.takeoverTimer) clearInterval(this.takeoverTimer);
    const hasRules = Array.from(this.sessions.values()).some(
      (session) => Array.isArray(session.cfg.takeoverPatterns) && session.cfg.takeoverPatterns.length > 0
    );
    if (!hasRules) return;
    const interval = Math.max(1500, Number(this.config.takeoverIntervalMs) || 5000);
    this.takeoverTimer = setInterval(() => {
      this.runTakeoverScan().catch((err) => {
        this.log('外部启动接管扫描失败: ' + (err && err.message ? err.message : String(err)));
      });
    }, interval);
    if (this.takeoverTimer.unref) this.takeoverTimer.unref();
    setTimeout(() => this.runTakeoverScan().catch(() => {}), 2500).unref?.();
    this.log('外部启动接管已启用，扫描间隔 ' + interval + 'ms');
  }

  collectManagedPids(children) {
    const result = new Set();
    const walk = (startPid) => {
      const queue = [Number(startPid)];
      while (queue.length) {
        const pid = queue.pop();
        if (!pid || result.has(pid)) continue;
        result.add(pid);
        for (const child of children.get(pid) || []) queue.push(Number(child.ProcessId));
      }
    };
    walk(process.pid);
    for (const session of this.sessions.values()) {
      if (session.pid) walk(session.pid);
    }
    return result;
  }

  async runTakeoverScan() {
    if (this.takeoverBusy) return { skipped: true };
    this.takeoverBusy = true;
    const result = { checked: 0, matched: 0, taken: [] };
    try {
      const processes = await listProcesses();
      if (!processes.length) return result;
      result.checked = processes.length;
      const byPid = new Map();
      const children = new Map();
      for (const proc of processes) {
        byPid.set(proc.ProcessId, proc);
        if (!children.has(proc.ParentProcessId)) children.set(proc.ParentProcessId, []);
        children.get(proc.ParentProcessId).push(proc);
      }
      const managed = this.collectManagedPids(children);
      const now = Date.now();
      for (const session of this.sessions.values()) {
        const patterns = (session.cfg.takeoverPatterns || [])
          .map((item) => String(item).toLowerCase())
          .filter(Boolean);
        if (!patterns.length) continue;
        if (session.status === 'starting' || session.status === 'stopping') continue;
        const matches = [];
        for (const proc of processes) {
          const pid = proc.ProcessId;
          if (!pid || managed.has(pid) || pid === process.pid) continue;
          const procName = String(proc.Name || '').toLowerCase();
          if (!['python.exe', 'pythonw.exe', 'node.exe'].includes(procName)) continue;
          const info = ((proc.ExecutablePath || '') + ' ' + (proc.CommandLine || '')).toLowerCase();
          if (!patterns.every((pattern) => info.includes(pattern))) continue;
          const last = this.takeoverHandled.get(pid) || 0;
          if (now - last < 15000) continue;
          matches.push(proc);
        }
        if (!matches.length) continue;
        result.matched += matches.length;
        const taken = await this.takeoverExternal(session, matches, byPid);
        result.taken.push({ session: session.id, ...taken });
      }
    } finally {
      this.takeoverBusy = false;
    }
    return result;
  }

  async takeoverExternal(session, matches, byPid) {
    const patterns = (session.cfg.takeoverPatterns || []).map((item) => String(item).toLowerCase());
    const launcherHints = ['launcher_astrbot', 'launcher.bat', 'start_3000', 'api_puchiko', 'api.bat'];
    const killPids = new Set();
    for (const match of matches) {
      let current = match;
      for (let depth = 0; depth < 8 && current; depth += 1) {
        const pid = Number(current.ProcessId);
        if (!pid) break;
        killPids.add(pid);
        this.takeoverHandled.set(pid, Date.now());
        const parent = byPid.get(Number(current.ParentProcessId));
        if (!parent || parent.ProcessId === process.pid) break;
        const name = String(parent.Name || '').toLowerCase();
        if (!['cmd.exe', 'powershell.exe', 'pwsh.exe', 'python.exe', 'pythonw.exe', 'node.exe'].includes(name)) break;
        const parentInfo = ((parent.ExecutablePath || '') + ' ' + (parent.CommandLine || '')).toLowerCase();
        const matchesPattern = patterns.some((pattern) => parentInfo.includes(pattern));
        const matchesHint = launcherHints.some((hint) => parentInfo.includes(hint));
        if (!matchesPattern && !matchesHint) break;
        current = parent;
      }
    }
    const pidList = Array.from(killPids);
    const summary =
      '检测到外部启动的 ' +
      session.name +
      '（PID ' +
      pidList.join(', ') +
      '），已自动接管';
    this.log(summary);
    session.system(
      summary +
        '：结束外部进程' +
        (session.status === 'running'
          ? '，LogDeck 托管实例继续运行。'
          : '，由 LogDeck 重新托管启动。')
    );
    this.broadcastSession(session);
    for (const pid of pidList) {
      if (isPidAlive(pid)) {
        try {
          await killTree(pid, true);
        } catch {
          /* ignore */
        }
        await sleep(60);
      }
    }
    await sleep(400);
    if (session.status !== 'running' && session.status !== 'starting') {
      session.restarts = 0;
      setTimeout(() => {
        session.start().catch((err) => {
          session.system('接管后重新启动失败: ' + (err && err.message ? err.message : String(err)));
          this.broadcastSession(session);
        });
      }, 1200);
    }
    return { pids: pidList };
  }

  async stopSession(idOrName) {
    const session = this.require(idOrName);
    await session.stop();
    return session;
  }

  async restartSession(idOrName) {
    const session = this.require(idOrName);
    await session.restart();
    return session;
  }

  async startAll() {
    const results = [];
    for (const session of this.sessions.values()) {
      if (session.status === 'running' || session.status === 'starting') continue;
      try {
        await session.start();
        results.push({ id: session.id, ok: true });
      } catch (err) {
        results.push({ id: session.id, ok: false, error: err && err.message ? err.message : String(err) });
      }
    }
    return results;
  }

  async stopAll() {
    const results = [];
    const list = Array.from(this.sessions.values());
    await Promise.allSettled(
      list.map(async (session) => {
        try {
          await session.stop();
          results.push({ id: session.id, ok: true });
        } catch (err) {
          results.push({ id: session.id, ok: false, error: err && err.message ? err.message : String(err) });
        }
      })
    );
    return results;
  }

  async startAutostart() {
    const list = Array.from(this.sessions.values()).filter((session) => session.cfg.autostart);
    const stagger = Number(this.config.autostartStaggerMs) || 0;
    for (const session of list) {
      if (session.status !== 'stopped') continue;
      try {
        await session.start();
        this.log('自动启动 ' + session.id);
      } catch (err) {
        this.log('自动启动 ' + session.id + ' 失败: ' + (err && err.message ? err.message : String(err)));
      }
      if (stagger > 0) await sleep(stagger);
    }
  }

  clearRestart(session) {
    if (session._restartTimer) {
      clearTimeout(session._restartTimer);
      session._restartTimer = null;
    }
  }

  scheduleRestart(session) {
    this.clearRestart(session);
    session.restarts += 1;
    const base = Number(session.cfg.restartDelayMs) || 2000;
    const delay = Math.min(60000, Math.round(base * Math.pow(1.6, Math.max(0, session.restarts - 1))));
    session.system('将在 ' + (delay / 1000).toFixed(1) + ' 秒后自动重启（第 ' + session.restarts + ' 次）');
    this.broadcastSession(session);
    session._restartTimer = setTimeout(() => {
      session._restartTimer = null;
      if (session.status === 'running' || session.status === 'starting') return;
      session.start().catch((err) => {
        const message = err && err.message ? err.message : String(err);
        this.log('自动重启 ' + session.id + ' 失败: ' + message);
        session.system('自动重启失败: ' + message);
        this.broadcastSession(session);
      });
    }, delay);
    if (session._restartTimer.unref) session._restartTimer.unref();
  }

  clearSingleHealth(session) {
    if (session._singleHealthTimer) {
      clearTimeout(session._singleHealthTimer);
      session._singleHealthTimer = null;
    }
  }

  scheduleHealthCheck(session, delay = 2000) {
    this.clearSingleHealth(session);
    if (!session.cfg.healthCheck) return;
    session._singleHealthTimer = setTimeout(async () => {
      session._singleHealthTimer = null;
      if (session.status !== 'running') return;
      const prev = session.health;
      const next = await checkHealth(session.cfg.healthCheck);
      session.health = next;
      if (!prev || prev.ok !== next.ok || prev.error !== next.error) this.broadcastSession(session);
    }, delay);
    if (session._singleHealthTimer.unref) session._singleHealthTimer.unref();
  }

  startHealthLoop() {
    if (this.healthTimer) clearInterval(this.healthTimer);
    const interval = Math.max(5, Number(this.config.healthIntervalSec) || 20) * 1000;
    this.healthTimer = setInterval(() => {
      this.runHealthChecks().catch(() => {});
    }, interval);
    if (this.healthTimer.unref) this.healthTimer.unref();
    setTimeout(() => this.runHealthChecks().catch(() => {}), 5000).unref?.();
  }

  async runHealthChecks() {
    for (const session of this.sessions.values()) {
      if (!session.cfg.healthCheck) continue;
      if (session.status !== 'running') {
        if (session.health) {
          session.health = null;
          this.broadcastSession(session);
        }
        continue;
      }
      const prev = session.health;
      const next = await checkHealth(session.cfg.healthCheck);
      session.health = next;
      if (!prev || prev.ok !== next.ok || prev.error !== next.error) {
        this.broadcastSession(session);
      }
    }
  }

  broadcastSession(session) {
    this.onEvent({ type: 'session', session: session.publicInfo() });
  }

  broadcastReset(session) {
    this.onEvent({ type: 'reset', id: session.id, seq: session.seq, lines: [] });
  }

  onLine(session, item) {
    this.onEvent({ type: 'line', id: session.id, line: item });
  }

  async shutdown() {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    if (this.takeoverTimer) {
      clearInterval(this.takeoverTimer);
      this.takeoverTimer = null;
    }
    for (const session of this.sessions.values()) {
      this.clearRestart(session);
      this.clearSingleHealth(session);
    }
    await Promise.allSettled(Array.from(this.sessions.values()).map((session) => session.stop()));
    try {
      await fsp.rm(this.config.runtimePath, { force: true });
    } catch {
      /* ignore */
    }
    this.log('LogDeck 已退出');
  }
}
