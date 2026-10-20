import fsp from 'node:fs/promises';
import path from 'node:path';
import { collapseCR } from './linesplitter.js';

export function parseTextLines(text, maxLines = 400) {
  const lines = [];
  const raw = String(text || '').split('\n');
  for (let i = 0; i < raw.length; i += 1) {
    let line = raw[i];
    if (line.endsWith('\r')) line = line.slice(0, -1);
    line = collapseCR(line);
    lines.push(line);
  }
  if (lines.length > 0 && lines[lines.length - 1] === '' && text.endsWith('\n')) {
    lines.pop();
  }
  return lines.slice(-maxLines);
}

const utf8Carry = new WeakMap();

export async function readTailLines(file, maxLines = 300, maxBytes = 512 * 1024) {
  const st = await fsp.stat(file);
  const size = st.size;
  if (!size) return { lines: [], size: 0, truncated: false };
  const start = Math.max(0, size - maxBytes);
  const len = size - start;
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    let text = buf.toString('utf8');
    let truncated = start > 0;
    if (start > 0) {
      const nl = text.indexOf('\n');
      if (nl >= 0) {
        text = text.slice(nl + 1);
      } else {
        text = '';
      }
    }
    const lines = parseTextLines(text, maxLines);
    return { lines, size, truncated };
  } finally {
    await fh.close();
  }
}

function decodeUtf8Chunk(buf, state) {
  const prev = state.carry || Buffer.alloc(0);
  const data = prev.length ? Buffer.concat([prev, buf]) : buf;
  let cut = data.length;
  let i = data.length - 1;
  let cont = 0;
  while (i >= 0 && (data[i] & 0xc0) === 0x80) {
    i -= 1;
    cont += 1;
  }
  if (i >= 0) {
    const lead = data[i];
    let need = 1;
    if (lead >= 0xf0) need = 4;
    else if (lead >= 0xe0) need = 3;
    else if (lead >= 0xc0) need = 2;
    if (cont + 1 < need) cut = i;
  }
  state.carry = Buffer.from(data.subarray(cut));
  return data.subarray(0, cut).toString('utf8');
}

export class FileTail {
  constructor(file, handlers = {}) {
    this.file = path.resolve(file);
    this.pollMs = Number(handlers.pollMs) || 600;
    this.onChunk = handlers.onChunk || (() => {});
    this.onError = handlers.onError || (() => {});
    this.onRotate = handlers.onRotate || (() => {});
    this.offset = 0;
    this.timer = null;
    this.busy = false;
    this.state = { carry: Buffer.alloc(0) };
  }

  async start(startOffset = null) {
    this.initialized = false;
    try {
      const st = await fsp.stat(this.file);
      this.offset =
        startOffset === null || startOffset === undefined ? st.size : startOffset;
      this.initialized = true;
    } catch {
      this.offset = 0;
      this.initialized = false;
    }
    this.state = { carry: Buffer.alloc(0) };
    this.timer = setInterval(() => {
      this.tick();
    }, this.pollMs);
    if (this.timer.unref) this.timer.unref();
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      let st;
      try {
        st = await fsp.stat(this.file);
      } catch (err) {
        this.onError(err);
        return;
      }
      if (!this.initialized) {
        this.initialized = true;
        this.state = { carry: Buffer.alloc(0) };
        if (st.size > 0) {
          const tailBytes = Math.min(st.size, 512 * 1024);
          const start = st.size - tailBytes;
          const chunk = Buffer.alloc(tailBytes);
          const fh = await fsp.open(this.file, 'r');
          try {
            await fh.read(chunk, 0, tailBytes, start);
          } finally {
            await fh.close();
          }
          this.offset = st.size;
          this.onChunk(decodeUtf8Chunk(chunk, this.state));
        } else {
          this.offset = 0;
        }
        return;
      }
      if (st.size < this.offset) {
        this.offset = 0;
        this.state = { carry: Buffer.alloc(0) };
        this.onRotate(st);
      }
      if (st.size <= this.offset) return;
      const len = st.size - this.offset;
      const chunk = Buffer.alloc(len);
      const fh = await fsp.open(this.file, 'r');
      try {
        await fh.read(chunk, 0, len, this.offset);
      } finally {
        await fh.close();
      }
      this.offset = st.size;
      const text = decodeUtf8Chunk(chunk, this.state);
      if (text) this.onChunk(text);
    } catch (err) {
      this.onError(err);
    } finally {
      this.busy = false;
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
