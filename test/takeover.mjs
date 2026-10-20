// 外部启动自动接管测试：独立端口 + 临时目录，不碰生产配置。
// 用法: node test/takeover.mjs
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const logdeckDir = path.join(appRoot, 'logdeck');
const tempDir = path.join(appRoot, 'test-temp', 'takeover-' + Date.now());
const port = 18100 + Math.floor(Math.random() * 15);
const token = 'takeover-' + Date.now().toString(16);
const configPath = path.join(tempDir, 'config.json');
const probeScript = path.join(tempDir, 'probe-target.mjs');

fs.mkdirSync(tempDir, { recursive: true });
fs.writeFileSync(probeScript, "console.log('probe started ' + new Date().toISOString());\nsetInterval(() => console.log('probe alive ' + Date.now()), 1500);\n");
fs.writeFileSync(
  configPath,
  JSON.stringify(
    {
      name: 'LogDeck Takeover Test',
      host: '127.0.0.1',
      port,
      token,
      dataDir: 'data',
      historyLines: 100,
      maxLogMb: 2,
      startAllOnBoot: false,
      takeoverIntervalMs: 2000,
      sessions: [
        {
          id: 'probe',
          name: 'Probe',
          type: 'process',
          command: 'node probe-target.mjs',
          cwd: '',
          autostart: false,
          restartPolicy: 'never',
          bufferLines: 500,
          takeoverPatterns: ['probe-target.mjs']
        }
      ]
    },
    null,
    2
  )
);

const failures = [];
function check(name, condition, detail) {
  if (condition) console.log('  PASS ' + name);
  else {
    failures.push(name + (detail ? ': ' + detail : ''));
    console.log('  FAIL ' + name + (detail ? ': ' + detail : ''));
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const base = 'http://127.0.0.1:' + port;
const headers = { 'X-LogDeck-Token': token, 'Content-Type': 'application/json' };

async function api(method, pathname, body) {
  const res = await fetch(base + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, data };
}
async function waitFor(fn, timeoutMs, intervalMs = 300) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await fn()) return true; } catch { /* retry */ }
    await sleep(intervalMs);
  }
  return false;
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const server = spawn(process.execPath, [path.join(logdeckDir, 'server.js'), '--config', configPath], { cwd: logdeckDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let serverOutput = '';
server.stdout.on('data', (b) => { serverOutput += b.toString('utf8'); });
server.stderr.on('data', (b) => { serverOutput += b.toString('utf8'); });

const children = [];
function spawnExternal(scriptName) {
  const child = spawn(process.execPath, [scriptName], { cwd: tempDir, stdio: 'ignore', windowsHide: true });
  children.push(child);
  return child;
}

async function main() {
  const up = await waitFor(async () => {
    const res = await api('GET', '/api/info');
    return res.status === 200 && res.data && res.data.ok;
  }, 10000);
  check('测试服务器启动', up, serverOutput.slice(-500));
  if (!up) return;

  const started = await api('POST', '/api/sessions/probe/start', {});
  check('探针会话启动', started.data.session.status === 'running' && !!started.data.session.pid);
  const managedPid = started.data.session.pid;

  // 干扰项：powershell 命令行里出现关键词，但并不是被接管的程序进程
  const decoy = spawn('powershell.exe', ['-NoProfile', '-Command', "Start-Sleep -Seconds 12; Write-Output 'probe-target.mjs'"], { stdio: 'ignore', windowsHide: true });
  children.push(decoy);
  let decoyExited = false;
  decoy.on('exit', () => { decoyExited = true; });

  // 场景 1：会话正在运行，外部又启动一份
  const externalA = spawnExternal('probe-target.mjs');
  const deadA = await waitFor(() => externalA.exitCode !== null, 15000);
  check('运行中：外部启动的副本被结束', deadA);
  await sleep(1500);
  const stateA = (await api('GET', '/api/sessions')).data.sessions.find((s) => s.id === 'probe');
  check('运行中：LogDeck 托管实例继续运行', stateA && stateA.status === 'running' && stateA.pid === managedPid, JSON.stringify(stateA));
  check('干扰项 PowerShell 未被误杀', !decoyExited);

  // 场景 2：会话已停止，外部启动后应被结束并由 LogDeck 重新托管
  const externalB = spawnExternal('probe-target.mjs');
  await sleep(800);
  check('场景2 外部进程已启动', externalB.exitCode === null);
  const stopped = await api('POST', '/api/sessions/probe/stop', {});
  check('探针会话已停止', stopped.data.session.status === 'stopped');
  const restarted = await waitFor(async () => {
    const res = await api('GET', '/api/sessions');
    const s = res.data.sessions.find((item) => item.id === 'probe');
    return s && s.status === 'running';
  }, 20000);
  check('停止状态：外部进程被接管后自动重启', restarted);
  const deadB = await waitFor(() => externalB.exitCode !== null, 3000);
  check('停止状态：外部进程被结束', deadB);
  const logRes = await fetch(base + '/api/sessions/probe/log?tail=200&plain=1&timestamps=0', { headers });
  const logText = await logRes.text();
  check('会话日志记录接管事件', logText.includes('自动接管'));

  const takeoverInfo = await api('GET', '/api/takeover');
  check('takeover 规则可查询', takeoverInfo.status === 200 && takeoverInfo.data.rules.length === 1);

  server.kill();
  await waitFor(() => server.exitCode !== null || server.signalCode !== null, 8000);
}

main()
  .catch((err) => { failures.push('测试异常: ' + err.message); console.error(err); })
  .finally(async () => {
    for (const child of children) {
      try { child.kill(); } catch { /* ignore */ }
    }
    try { server.kill(); } catch { /* ignore */ }
    await sleep(300);
    try { await fsp.rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    console.log('');
    if (failures.length) {
      console.log('TAKEOVER TEST FAILED (' + failures.length + ')');
      for (const item of failures) console.log(' - ' + item);
      process.exitCode = 1;
    } else {
      console.log('TAKEOVER TEST PASSED');
    }
  });
