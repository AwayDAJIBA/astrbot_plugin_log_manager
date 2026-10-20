import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function nowIso() {
  return new Date().toISOString();
}

export function randomToken(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function randomId(prefix = 's') {
  return prefix + '-' + crypto.randomBytes(4).toString('hex');
}

export function slugify(input, fallback = '') {
  const text = String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return text || fallback;
}

export function writeJsonAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function stripAnsi(input) {
  if (!input) return '';
  return String(input)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/\r/g, '');
}

export function timestampLocal(ts = Date.now()) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

export function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

export async function killTree(pid, force = true) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  if (process.platform !== 'win32') {
    try {
      process.kill(n, force ? 'SIGKILL' : 'SIGTERM');
      return true;
    } catch {
      return false;
    }
  }
  const args = ['/PID', String(n), '/T'];
  if (force) args.push('/F');
  try {
    await execFileAsync('taskkill', args, { windowsHide: true, timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

export async function getProcessCommandLine(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return '';
  if (process.platform !== 'win32') {
    try {
      const { stdout } = await execFileAsync('ps', ['-p', String(n), '-o', 'command=']);
      return String(stdout || '').trim();
    } catch {
      return '';
    }
  }
  const script = '$p=Get-CimInstance Win32_Process -Filter "ProcessId=' + n + '"; if($p){[Console]::Out.Write($p.CommandLine)}';
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 10000 }
    );
    return String(stdout || '').trim();
  } catch {
    return '';
  }
}

export async function listProcesses() {
  if (process.platform !== 'win32') {
    try {
      const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid=,comm=,args=']);
      return String(stdout || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
          if (!match) return null;
          return {
            ProcessId: Number(match[1]),
            ParentProcessId: Number(match[2]),
            Name: match[3],
            CommandLine: match[4],
            ExecutablePath: '',
          };
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }
  const script =
    "$p=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('python.exe','pythonw.exe','node.exe','cmd.exe','powershell.exe','pwsh.exe','conhost.exe','bash.exe','wsl.exe','WindowsTerminal.exe') } | Select-Object ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath); ConvertTo-Json -InputObject $p -Compress -Depth 3";
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024 * 1024 }
    );
    const text = String(stdout || '').trim();
    if (!text) return [];
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
      .map((item) => ({
        ProcessId: Number(item.ProcessId),
        ParentProcessId: Number(item.ParentProcessId),
        Name: String(item.Name || ''),
        CommandLine: String(item.CommandLine || ''),
        ExecutablePath: String(item.ExecutablePath || ''),
      }))
      .filter((item) => Number.isInteger(item.ProcessId));
  } catch {
    return [];
  }
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length || left.length === 0) return false;
  try {
    return crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

export function normalizeHealthCheck(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.url) {
    return {
      type: 'http',
      url: String(raw.url),
      expectStatus: Number(raw.expectStatus) || 0,
      timeoutMs: clamp(Number(raw.timeoutMs) || 3000, 500, 15000),
    };
  }
  const port = Number(raw.port);
  if (Number.isInteger(port) && port > 0 && port < 65536) {
    return {
      type: 'tcp',
      host: String(raw.host || '127.0.0.1'),
      port,
      timeoutMs: clamp(Number(raw.timeoutMs) || 2000, 300, 15000),
    };
  }
  return null;
}

export function healthCheckLabel(hc) {
  if (!hc) return '';
  if (hc.type === 'tcp') return 'tcp://' + hc.host + ':' + hc.port;
  return hc.url;
}
