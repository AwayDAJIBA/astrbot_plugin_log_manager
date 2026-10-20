import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDir, randomToken, writeJsonAtomic, readJson, clamp } from './util.js';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PORT = 17890;
export const DEFAULT_CONFIG_PATH = path.join(APP_ROOT, 'config.json');

export function serializeConfig(cfg) {
  return {
    name: cfg.name || 'LogDeck',
    host: cfg.host || '127.0.0.1',
    port: Number(cfg.port) || DEFAULT_PORT,
    token: cfg.token || '',
    dataDir: cfg.dataDir || 'data',
    maxLogMb: Number(cfg.maxLogMb) || 20,
    historyLines: Number(cfg.historyLines) || 300,
    healthIntervalSec: Number(cfg.healthIntervalSec) || 20,
    autostartStaggerMs: Number(cfg.autostartStaggerMs) || 1500,
    takeoverIntervalMs: Number(cfg.takeoverIntervalMs) || 5000,
    sessions: Array.isArray(cfg.sessions) ? cfg.sessions : [],
    ui: cfg.ui && typeof cfg.ui === 'object' ? cfg.ui : {},
    startAllOnBoot: cfg.startAllOnBoot !== false,
  };
}

export function loadConfig(configPath) {
  const file = path.resolve(configPath || process.env.LOGDECK_CONFIG || DEFAULT_CONFIG_PATH);
  const root = path.dirname(file);
  const existed = fs.existsSync(file);
  const raw = readJson(file, null) || {};
  const cfg = {
    name: raw.name || 'LogDeck',
    host: raw.host || '127.0.0.1',
    port: clamp(Number(raw.port) || DEFAULT_PORT, 1024, 65535),
    token: raw.token || '',
    dataDir: raw.dataDir || 'data',
    maxLogMb: clamp(Number(raw.maxLogMb) || 20, 1, 500),
    historyLines: clamp(Number(raw.historyLines) || 300, 0, 3000),
    healthIntervalSec: clamp(Number(raw.healthIntervalSec) || 20, 5, 600),
    autostartStaggerMs: clamp(Number(raw.autostartStaggerMs) || 1500, 0, 60000),
    takeoverIntervalMs: clamp(Number(raw.takeoverIntervalMs) || 5000, 1500, 120000),
    sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
    ui: raw.ui && typeof raw.ui === 'object' ? raw.ui : {},
    startAllOnBoot: raw.startAllOnBoot !== false,
  };
  if (!cfg.token) cfg.token = randomToken(16);
  cfg.configPath = file;
  cfg.root = root;
  cfg.dataDirAbs = path.resolve(root, cfg.dataDir);
  cfg.logsDirAbs = path.join(cfg.dataDirAbs, 'logs');
  cfg.managerLogPath = path.join(cfg.dataDirAbs, 'manager.log');
  cfg.runtimePath = path.join(cfg.dataDirAbs, 'runtime.json');
  ensureDir(cfg.dataDirAbs);
  ensureDir(cfg.logsDirAbs);
  if (!existed || !raw.token) {
    writeJsonAtomic(file, serializeConfig(cfg));
  }
  return cfg;
}

export function saveConfig(cfg) {
  writeJsonAtomic(cfg.configPath, serializeConfig(cfg));
}
