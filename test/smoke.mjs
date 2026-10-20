// LogDeck 冒烟测试：独立端口 + 临时目录，不影响生产配置。
// 用法: node test/smoke.mjs
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const logdeckDir = path.join(appRoot, 'logdeck');
const tempDir = path.join(appRoot, 'test-temp', 'smoke-' + Date.now());
const port = 17990 + Math.floor(Math.random() * 8);
const token = 'smoke-' + Date.now().toString(16);
const configPath = path.join(tempDir, 'config.json');

fs.mkdirSync(tempDir, { recursive: true });
fs.writeFileSync(
  path.join(tempDir, 'ticker.mjs'),
  "let i=0;setInterval(()=>{i+=1;console.log('tick '+i+' \\u001b[32mgreen\\u001b[0m');if(i%3===0)console.error('err '+i);},120);console.log('started');\n"
);
fs.writeFileSync(path.join(tempDir, 'app.log'), 'line one\nline two\n');
fs.writeFileSync(
  configPath,
  JSON.stringify(
    {
      name: 'LogDeck Smoke',
      host: '127.0.0.1',
      port,
      token,
      dataDir: 'data',
      historyLines: 100,
      maxLogMb: 2,
      startAllOnBoot: false,
      sessions: [
        { id: 'ticker', name: 'Ticker', type: 'process', command: 'node ticker.mjs', autostart: false, restartPolicy: 'never', bufferLines: 500 },
        { id: 'filetail', name: 'FileTail', type: 'file', path: 'app.log', autostart: false, bufferLines: 500 }
      ]
    },
    null,
    2
  )
);

const failures = [];
function check(name, condition, detail) {
  if (condition) {
    console.log('  PASS ' + name);
  } else {
    failures.push(name + (detail ? ': ' + detail : ''));
    console.log('  FAIL ' + name + (detail ? ': ' + detail : ''));
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = spawn(process.execPath, [path.join(logdeckDir, 'server.js'), '--config', configPath], {
  cwd: logdeckDir,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
});
let serverOutput = '';
server.stdout.on('data', (buf) => { serverOutput += buf.toString('utf8'); });
server.stderr.on('data', (buf) => { serverOutput += buf.toString('utf8'); });

const base = 'http://127.0.0.1:' + port;
const headers = { 'X-LogDeck-Token': token, 'Content-Type': 'application/json' };

async function api(method, pathname, body) {
  const res = await fetch(base + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, data };
}

async function waitFor(fn, timeoutMs, intervalMs = 150) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await fn()) return true;
    } catch { /* retry */ }
    await sleep(intervalMs);
  }
  return false;
}

async function main() {
  const up = await waitFor(async () => {
    const res = await api('GET', '/api/info');
    return res.status === 200 && res.data && res.data.ok;
  }, 10000);
  check('server 启动并响应 /api/info', up, serverOutput.slice(-500));
  if (!up) return;

  const info = await api('GET', '/api/info');
  check('info 含版本与 2 个会话', info.data.version === '1.0.0' && info.data.sessionCount === 2);

  const startTicker = await api('POST', '/api/sessions/ticker/start', {});
  check('启动进程会话', startTicker.status === 200 && startTicker.data.session.status === 'running' && !!startTicker.data.session.pid);

  const gotLines = await waitFor(async () => {
    const res = await api('GET', '/api/sessions/ticker/log?tail=50');
    return res.data && res.data.ok && res.data.lines.some((line) => line.text.includes('tick'));
  }, 5000);
  check('进程 stdout 日志进入缓冲区', gotLines);

  const stderrLine = await waitFor(async () => {
    const res = await api('GET', '/api/sessions/ticker/log?tail=200&grep=err');
    return res.data && res.data.ok && res.data.lines.length > 0;
  }, 5000);
  check('stderr 日志可被 grep', stderrLine);

  const plain = await fetch(base + '/api/sessions/ticker/log?tail=5&plain=1&timestamps=0', { headers });
  const plainText = await plain.text();
  check('plain 模式去掉 ANSI 颜色', plain.status === 200 && !plainText.includes('\u001b') && plainText.includes('tick'));

  // progress \r 覆盖
  const progress = await api('POST', '/api/sessions', {
    name: 'Progress Smoke',
    command: "node -e \"let i=0;const t=setInterval(()=>{i++;process.stdout.write('\\\\rprogress '+i+'/5');if(i>=5){clearInterval(t);process.stdout.write('\\\\ndone\\\\n')}},80)\"",
    startNow: true,
    restartPolicy: 'never'
  });
  check('新建进程会话（含 \\r 进度）', progress.status === 200);
  const progressId = progress.data && progress.data.session && progress.data.session.id;
  if (progressId) {
    const progressOk = await waitFor(async () => {
      const res = await api('GET', '/api/sessions/' + progressId + '/log?tail=50');
      return res.data && res.data.lines && res.data.lines.some((line) => line.text.includes('progress 5/5'));
    }, 6000);
    check('\\r 进度行被合并为最终行', progressOk);
  }

  // 文件跟踪
  const startFile = await api('POST', '/api/sessions/filetail/start', {});
  check('启动文件跟踪会话', startFile.status === 200 && startFile.data.session.status === 'running');
  fs.appendFileSync(path.join(tempDir, 'app.log'), 'line three appended\n');
  const fileOk = await waitFor(async () => {
    const res = await api('GET', '/api/sessions/filetail/log?tail=20');
    return res.data && res.data.lines && res.data.lines.some((line) => line.text.includes('line three appended'));
  }, 5000);
  check('日志文件新增内容被实时跟踪', fileOk);

  // 文件还不存在时也能启动，并等待文件出现
  const missingName = 'missing.log';
  const missingCreate = await api('POST', '/api/sessions', {
    name: 'Missing File Smoke',
    type: 'file',
    path: missingName,
    startNow: true
  });
  check('文件不存在时也能启动跟踪会话', missingCreate.status === 200 && missingCreate.data.session.status === 'running');
  await sleep(300);
  fs.writeFileSync(path.join(tempDir, missingName), 'appeared one\nappeared two\n');
  const missingId = missingCreate.data && missingCreate.data.session && missingCreate.data.session.id;
  if (missingId) {
    const appeared = await waitFor(async () => {
      const res = await api('GET', '/api/sessions/' + missingId + '/log?tail=20');
      return res.data && res.data.lines && res.data.lines.some((line) => line.text.includes('appeared two'));
    }, 5000);
    check('文件出现后自动开始跟踪', appeared);
  }

  // 清空日志
  const cleared = await api('POST', '/api/sessions/ticker/clear', {});
  check('清空日志', cleared.status === 200);
  const afterClear = await api('GET', '/api/sessions/ticker/log?tail=10');
  check('清空后缓冲行数很少', afterClear.data.seq >= 0 && afterClear.data.count <= 5);

  // 停止
  const stop = await api('POST', '/api/sessions/ticker/stop', {});
  check('停止进程会话', stop.status === 200 && stop.data.session.status === 'stopped' && !stop.data.session.pid);

  // 修改配置
  const patched = await api('PATCH', '/api/sessions/filetail', { tags: ['smoke'], autostart: true });
  check('修改会话配置', patched.status === 200 && patched.data.session.tags.includes('smoke') && patched.data.session.autostart === true);

  // 删除
  const removed = await api('DELETE', '/api/sessions/' + progressId + '?deleteLog=1');
  check('删除会话', removed.status === 200);
  const list = await api('GET', '/api/sessions');
  check('会话数量减少', list.data.sessions.length === 3);

  // SSE 首帧 hello
  try {
    const controller = new AbortController();
    const sseRes = await fetch(base + '/api/events?token=' + encodeURIComponent(token), { signal: controller.signal });
    const reader = sseRes.body.getReader();
    const chunk = await reader.read();
    controller.abort();
    const text = Buffer.from(chunk.value || []).toString('utf8');
    check('SSE 返回 hello 事件', sseRes.status === 200 && text.includes('"type":"hello"'));
  } catch (err) {
    check('SSE 返回 hello 事件', false, err.message);
  }

  // 退出
  server.kill();
  const stopped = await waitFor(() => server.exitCode !== null || server.signalCode !== null, 8000);
  check('管理器进程可退出', stopped);
}

main()
  .catch((err) => {
    failures.push('测试异常: ' + err.message);
    console.error(err);
  })
  .finally(async () => {
    try { server.kill(); } catch { /* ignore */ }
    await sleep(200);
    try { await fsp.rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    console.log('');
    if (failures.length) {
      console.log('SMOKE FAILED (' + failures.length + ')');
      for (const item of failures) console.log(' - ' + item);
      process.exitCode = 1;
    } else {
      console.log('SMOKE PASSED');
    }
  });
