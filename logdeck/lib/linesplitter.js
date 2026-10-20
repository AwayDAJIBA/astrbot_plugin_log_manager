export function collapseCR(line) {
  const idx = line.lastIndexOf('\r');
  return idx >= 0 ? line.slice(idx + 1) : line;
}

export class LineSplitter {
  constructor(onLine, onPartial, options = {}) {
    this.onLine = onLine;
    this.onPartial = onPartial;
    this.maxPartial = Number(options.maxPartial) || 16000;
    this.buf = '';
  }

  feed(text, stream = 'stdout') {
    if (!text) return;
    this.buf += text;
    let nl = this.buf.indexOf('\n');
    while (nl !== -1) {
      let line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.onLine(collapseCR(line), stream);
      nl = this.buf.indexOf('\n');
    }
    if (this.buf.length > 0) {
      if (this.buf.length > this.maxPartial) {
        this.buf = this.buf.slice(this.buf.length - this.maxPartial);
      }
      this.onPartial(collapseCR(this.buf), stream);
    }
  }

  flush(stream = 'stdout') {
    if (!this.buf) return;
    const line = collapseCR(this.buf);
    this.buf = '';
    this.onLine(line, stream);
  }

  reset() {
    this.buf = '';
  }
}
