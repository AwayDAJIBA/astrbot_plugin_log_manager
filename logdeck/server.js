import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig, APP_ROOT } from './lib/config.js';
import { SessionManager, checkHealth } from './lib/manager.js';
import { clamp, safeEqual, stripAnsi, timestampLocal } from './lib/util.js';

const VERSION = '1.0.0';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');

function parseArgs(argv) {
  const args = { config: '', port: 0, host: '', noAutostart: false };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === '--config' || item === '-c') {
      args.config = argv[i + 1] || '';
      i += 1;
    } else if (item === '--port' || item === '-p') {
      args.port = Number(argv[i + 1]) || 0;
      i += 1;
    } else if (item === '--host') {
      args.host = argv[i + 1] || '';
      i += 1;
    } else if (item === '--no-autostart') {
      args.noAutostart = true;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const config = loadConfig(args.config);
if (args.port) config.port = args.port;
if (args.host) config.host = args.host;

const serverId = crypto.randomUUID();
const sseClients = new Set();
let shuttingDown = false;
let httpServer = null;
let manager = null;

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function ok(res, data = {}) {
  json(res, 200, { ok: true, ...data });
}

function fail(res, status, message) {
  json(res, status, { ok: false, error: message });
}

function getToken(req, url) {
  const header = req.headers['x-logdeck-token'];
  if (header) return String(header).trim();
  const auth = String(req.headers.authorization || '');
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const query = url && url.searchParams.get('token');
  return query ? String(query).trim() : '';
}

function authorized(req, url) {
  if (!config.token) return true;
  const token = getToken(req, url);
  return safeEqual(token, config.token);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  return new Promise((resolve, reject) => {
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

function broadcast(event) {
  if (sseClients.size === 0) return;
  const payload = 'data: ' + JSON.stringify(event) + '\n\n';
  for (const client of sseClients) {
    try {
      client.res.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

function handleManagerEvent(event) {
  if (!event) return;
  if (event.type === 'line') {
    broadcast({ type: 'line', id: event.id, line: event.line });
  } else {
    broadcast(event);
  }
}

function serveStatic(req, res, url) {
  let pathname = url.pathname;
  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(publicDir, pathname));
  if (!file.startsWith(publicDir)) {
    fail(res, 403, 'forbidden');
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    fail(res, 404, 'not found');
    return;
  }
  const ext = path.extname(file).toLowerCase();
  const mime =
    ext === '.html'
      ? 'text/html; charset=utf-8'
      : ext === '.js'
        ? 'text/javascript; charset=utf-8'
        : ext === '.css'
          ? 'text/css; charset=utf-8'
          : ext === '.svg'
            ? 'image/svg+xml'
            : 'application/octet-stream';
  if (ext === '.html') {
    let html = fs.readFileSync(file, 'utf8');
    const boot = {
      token: config.token,
      version: VERSION,
      serverId,
      port: config.port,
      base: '',
    };
    html = html.replace('<!--LOGDECK_BOOT-->', '<script>window.__LOGDECK_BOOT__=' + JSON.stringify(boot) + ';</script>');
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

function handleSse(req, res, url) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  const client = { res };
  sseClients.add(client);
  const hello = {
    type: 'hello',
    serverId,
    version: VERSION,
    pid: process.pid,
    startedAt: manager.startedAt,
    sessions: manager.list(),
    time: Date.now(),
  };
  res.write('data: ' + JSON.stringify(hello) + '\n\n');
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping ' + Date.now() + '\n\n');
    } catch {
      /* ignore */
    }
  }, 15000);
  if (heartbeat.unref) heartbeat.unref();
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(client);
  });
}

function formatPlainLine(line, withTimestamp) {
  const text = stripAnsi(line.text);
  if (line.stream === 'system' || line.stream === 'input') return text;
  let prefix = '';
  if (withTimestamp) prefix += '[' + timestampLocal(line.ts) + '] ';
  if (line.stream === 'stderr') prefix += '[stderr] ';
  return prefix + text;
}

async function handleSessionAction(req, res, session, action) {
  if (action === 'ensure') {
    await manager.ensureSession(session.id);
    return ok(res, { session: session.publicInfo() });
  }
  if (action === 'start') {
    await session.start();
    return ok(res, { session: session.publicInfo() });
  }
  if (action === 'stop') {
    await session.stop();
    return ok(res, { session: session.publicInfo() });
  }
  if (action === 'restart') {
    await session.restart();
    return ok(res, { session: session.publicInfo() });
  }
  if (action === 'clear') {
    await session.clear();
    return ok(res, { session: session.publicInfo() });
  }
  if (action === 'input') {
    const body = await readBody(req);
    await session.sendInput(body.text, body.enter !== false);
    return ok(res, { session: session.publicInfo() });
  }
  if (action === 'health') {
    if (!session.cfg.healthCheck) {
      return fail(res, 400, '该会话没有配置健康检查');
    }
    session.health = await checkHealth(session.cfg.healthCheck);
    manager.broadcastSession(session);
    return ok(res, { health: session.health });
  }
  return fail(res, 404, 'unknown action');
}

async function handleApi(req, res, url) {
  if (!authorized(req, url)) {
    return fail(res, 401, '无效的 LogDeck 令牌');
  }
  const method = req.method || 'GET';
  const pathname = url.pathname;
  let match;

  if (method === 'GET' && pathname === '/api/info') {
    return ok(res, {
      name: config.name,
      version: VERSION,
      pid: process.pid,
      serverId,
      port: config.port,
      host: config.host,
      startedAt: manager.startedAt,
      uptimeMs: Date.now() - manager.startedAt,
      sessionCount: manager.sessions.size,
      runningCount: manager.list().filter((s) => s.status === 'running').length,
      configPath: config.configPath,
      dataDir: config.dataDirAbs,
      logsDir: config.logsDirAbs,
      managerLogPath: config.managerLogPath,
      maxLogMb: config.maxLogMb,
      token: config.token,
    });
  }

  if (method === 'GET' && pathname === '/api/sessions') {
    return ok(res, { sessions: manager.list() });
  }

  if (method === 'POST' && pathname === '/api/sessions') {
    const body = await readBody(req);
    const session = await manager.createSession(body);
    return ok(res, { session: session.publicInfo() });
  }

  if (method === 'GET' && pathname === '/api/takeover') {
    const rules = Array.from(manager.sessions.values())
      .filter((session) => (session.cfg.takeoverPatterns || []).length > 0)
      .map((session) => ({
        session: session.id,
        name: session.name,
        patterns: session.cfg.takeoverPatterns,
        status: session.status,
      }));
    return ok(res, { intervalMs: manager.config.takeoverIntervalMs, rules });
  }

  if (method === 'POST' && pathname === '/api/takeover/scan') {
    const result = await manager.runTakeoverScan();
    return ok(res, { result });
  }

  if (method === 'POST' && (pathname === '/api/actions/start-all' || pathname === '/api/actions/stop-all')) {
    const started = Date.now();
    let results;
    if (pathname.endsWith('start-all')) results = await manager.startAll();
    else results = await manager.stopAll();
    return ok(res, { actions: results, ms: Date.now() - started });
  }

  if (method === 'GET' && pathname === '/api/search') {
    const q = String(url.searchParams.get('q') || '').trim();
    const ids = String(url.searchParams.get('ids') || '').split(',').filter(Boolean);
    const limit = clamp(Number(url.searchParams.get('limit')) || 5, 1, 50);
    const useRegex = url.searchParams.get('regex') === '1';
    let pattern = null;
    if (useRegex && q) {
      try {
        pattern = new RegExp(q, 'i');
      } catch (err) {
        return fail(res, 400, '正则表达式无效: ' + err.message);
      }
    }
    const results = [];
    if (q) {
      const list = ids.length
        ? ids.map((id) => manager.resolve(id)).filter(Boolean)
        : Array.from(manager.sessions.values());
      for (const session of list) {
        const matches = [];
        const items = session.buffer.items;
        for (let i = items.length - 1; i >= 0 && matches.length < limit; i -= 1) {
          const text = stripAnsi(items[i].text);
          const hit = pattern ? pattern.test(text) : text.toLowerCase().includes(q.toLowerCase());
          if (hit) matches.unshift(items[i]);
        }
        if (matches.length) {
          results.push({ id: session.id, name: session.name, status: session.status, matches });
        }
      }
    }
    return ok(res, { q, results });
  }

  match = pathname.match(/^\/api\/sessions\/([^/]+)\/(ensure|start|stop|restart|clear|input|health)$/);
  if (match) {
    const session = manager.require(decodeURIComponent(match[1]));
    if (method !== 'POST') return fail(res, 405, 'method not allowed');
    return handleSessionAction(req, res, session, match[2]);
  }

  match = pathname.match(/^\/api\/sessions\/([^/]+)\/log$/);
  if (match && method === 'GET') {
    const session = manager.require(decodeURIComponent(match[1]));
    const tail = clamp(Number(url.searchParams.get('tail')) || 300, 1, 5000);
    const grep = String(url.searchParams.get('grep') || '');
    const useRegex = url.searchParams.get('regex') === '1';
    const afterSeq = Number(url.searchParams.get('afterSeq')) || 0;
    const plain = url.searchParams.get('plain') === '1';
    const withTimestamp = url.searchParams.get('timestamps') !== '0';
    let items = session.buffer.items.slice();
    const firstSeq = items.length ? items[0].seq : 0;
    const lastSeq = session.seq;
    let truncated = false;
    if (afterSeq > 0) {
      if (firstSeq > afterSeq + 1) truncated = true;
      items = items.filter((item) => item.seq > afterSeq);
    }
    if (grep) {
      let pattern = null;
      if (useRegex) {
        try {
          pattern = new RegExp(grep, 'i');
        } catch (err) {
          return fail(res, 400, '正则表达式无效: ' + err.message);
        }
      }
      items = items.filter((item) => {
        const text = stripAnsi(item.text);
        return pattern ? pattern.test(text) : text.toLowerCase().includes(grep.toLowerCase());
      });
    }
    items = items.slice(-tail);
    if (plain) {
      const body = items.map((item) => formatPlainLine(item, withTimestamp)).join('\n');
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(body + (body ? '\n' : ''));
      return;
    }
    return ok(res, {
      id: session.id,
      name: session.name,
      seq: lastSeq,
      firstSeq,
      lastSeq,
      truncated,
      count: items.length,
      lines: items,
    });
  }

  match = pathname.match(/^\/api\/sessions\/([^/]+)\/download$/);
  if (match && method === 'GET') {
    const session = manager.require(decodeURIComponent(match[1]));
    const file = session.type === 'file' ? session.cfg.path : session.logFile;
    const resolved = file ? path.resolve(config.root, file) : '';
    if (!resolved || !fs.existsSync(resolved)) return fail(res, 404, '日志文件不存在');
    const stat = fs.statSync(resolved);
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': 'attachment; filename="' + session.id + '.log"',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(resolved).pipe(res);
    return;
  }

  match = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (match) {
    const id = decodeURIComponent(match[1]);
    if (method === 'GET') {
      const session = manager.require(id);
      return ok(res, { session: session.publicInfo() });
    }
    if (method === 'PATCH' || method === 'PUT') {
      const body = await readBody(req);
      const session = await manager.updateSession(id, body);
      return ok(res, { session: session.publicInfo() });
    }
    if (method === 'DELETE') {
      const deleteLog = url.searchParams.get('deleteLog') === '1';
      await manager.deleteSession(id, { deleteLog });
      return ok(res, { id });
    }
  }

  return fail(res, 404, '接口不存在: ' + method + ' ' + pathname);
}

async function requestHandler(req, res) {
  const url = new URL(req.url || '/', 'http://' + (req.headers.host || '127.0.0.1'));
  try {
    if (url.pathname === '/api/events') {
      if (!authorized(req, url)) return fail(res, 401, '无效的 LogDeck 令牌');
      return handleSse(req, res, url);
    }
    if (url.pathname.startsWith('/api/')) {
      return await handleApi(req, res, url);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return fail(res, 405, 'method not allowed');
    }
    return serveStatic(req, res, url);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (!res.headersSent) {
      fail(res, 500, message);
    } else {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
  }
}

function writePidFile() {
  try {
    fs.writeFileSync(
      path.join(config.dataDirAbs, 'logdeck.pid'),
      JSON.stringify({ pid: process.pid, port: config.port, startedAt: new Date().toISOString() }, null, 2)
    );
  } catch {
    /* ignore */
  }
}

function removePidFile() {
  try {
    fs.rmSync(path.join(config.dataDirAbs, 'logdeck.pid'), { force: true });
  } catch {
    /* ignore */
  }
}

async function shutdown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  manager.log('正在退出 (' + reason + ')');
  broadcast({ type: 'server:shutdown' });
  try {
    if (httpServer) httpServer.close();
  } catch {
    /* ignore */
  }
  try {
    await manager.shutdown();
  } catch (err) {
    manager.log('退出时停止会话失败: ' + (err && err.message ? err.message : String(err)));
  }
  for (const client of sseClients) {
    try {
      client.res.end();
    } catch {
      /* ignore */
    }
  }
  sseClients.clear();
  removePidFile();
  setTimeout(() => process.exit(code), 150);
}

async function main() {
  manager = new SessionManager(config, handleManagerEvent);
  await manager.init();
  httpServer = http.createServer((req, res) => {
    requestHandler(req, res);
  });
  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error('[LogDeck] 端口 ' + config.port + ' 已被占用，可能已经有实例在运行。');
      process.exit(2);
    }
    console.error('[LogDeck] 服务器错误: ' + (err && err.stack ? err.stack : String(err)));
    process.exit(1);
  });
  httpServer.listen(config.port, config.host, () => {
    writePidFile();
    manager.log('LogDeck v' + VERSION + ' 已启动: http://' + config.host + ':' + config.port + '/  (config: ' + config.configPath + ')');
    console.log('LogDeck v' + VERSION + ' -> http://' + config.host + ':' + config.port + '/');
    if (!args.noAutostart && config.startAllOnBoot !== false) {
      setTimeout(() => {
        manager.startAutostart().catch((err) => manager.log('自动启动失败: ' + err.message));
      }, 1000);
    }
  });

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    manager.log('uncaughtException: ' + (err && err.stack ? err.stack : String(err)));
  });
  process.on('unhandledRejection', (err) => {
    manager.log('unhandledRejection: ' + (err && err.stack ? err.stack : String(err)));
  });
}

main().catch((err) => {
  console.error('[LogDeck] 启动失败: ' + (err && err.stack ? err.stack : String(err)));
  process.exit(1);
});
