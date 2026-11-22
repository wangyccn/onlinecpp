/** Bounded stdout/stderr ring. The UI drains even while WASM never yields. */
export class ProcessOutput {
  public readonly shared: SharedArrayBuffer;
  private control: Int32Array;
  private bytes: Uint8Array;
  private cursor = 0;

  constructor(shared = new SharedArrayBuffer(256 * 1024 + 8)) {
    this.shared = shared;
    this.control = new Int32Array(shared, 0, 2);
    this.bytes = new Uint8Array(shared, 8);
  }

  /** Producer only (execution Worker); waits for xterm consumption, not the UI. */
  public write(stream: number, bytes: Uint8Array): void {
    for (let offset = 0; offset < bytes.length;) {
      const length = Math.min(16384, this.bytes.length - 6, bytes.length - offset);
      const write = Atomics.load(this.control, 1), required = length + 5;
      while (true) {
        const read = Atomics.load(this.control, 0);
        const free = (read - write - 1 + this.bytes.length) % this.bytes.length;
        if (free >= required) break;
        Atomics.wait(this.control, 0, read);
      }
      for (let i = 0; i < 5; i++) this.bytes[(write + i) % this.bytes.length] = i ? (length >>> ((i - 1) * 8)) & 255 : stream;
      const start = (write + 5) % this.bytes.length, first = Math.min(length, this.bytes.length - start);
      this.bytes.set(bytes.subarray(offset, offset + first), start);
      if (first < length) this.bytes.set(bytes.subarray(offset + first, offset + length), 0);
      Atomics.store(this.control, 1, (write + required) % this.bytes.length);
      offset += length;
    }
  }

  /** Consumer only. Copy published records before acknowledging their lifetime. */
  public read(): { chunks: Array<{ stream: number; bytes: Uint8Array }>; end: number } {
    const end = Atomics.load(this.control, 1), chunks = [];
    while (this.cursor !== end) {
      const stream = this.bytes[this.cursor]; let length = 0;
      for (let i = 0; i < 4; i++) length |= this.bytes[(this.cursor + 1 + i) % this.bytes.length] << (i * 8);
      const start = (this.cursor + 5) % this.bytes.length, first = Math.min(length, this.bytes.length - start);
      const bytes = new Uint8Array(length);
      bytes.set(this.bytes.subarray(start, start + first));
      if (first < length) bytes.set(this.bytes.subarray(0, length - first), first);
      chunks.push({ stream, bytes }); this.cursor = (this.cursor + length + 5) % this.bytes.length;
    }
    return { chunks, end };
  }

  public acknowledge(end: number): void {
    Atomics.store(this.control, 0, end); Atomics.notify(this.control, 0);
  }
}
