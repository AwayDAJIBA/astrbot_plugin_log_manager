export class RingBuffer {
  constructor(maxLines = 4000) {
    this.max = Math.max(50, Number(maxLines) || 4000);
    this.items = [];
  }

  push(item) {
    this.items.push(item);
    if (this.items.length > this.max) {
      this.items.splice(0, this.items.length - this.max);
    }
  }

  replaceLast(item) {
    if (this.items.length === 0) {
      this.push(item);
      return;
    }
    this.items[this.items.length - 1] = item;
  }

  replaceBySeq(seq, item) {
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      if (this.items[i].seq === seq) {
        this.items[i] = item;
        return true;
      }
    }
    this.push(item);
    return false;
  }

  tail(count) {
    const n = Number(count) || 0;
    if (n > 0 && n < this.items.length) return this.items.slice(-n);
    return this.items.slice();
  }

  clear() {
    this.items = [];
  }

  get size() {
    return this.items.length;
  }
}
