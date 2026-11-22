import type { FSStats, IFileSystem } from 'emception';
import type { NativeOperation, NativeStat, NativeEntry } from './nativeIO';

/** Synchronous POSIX calls block only the WASM Worker, never the UI/IO Worker. */
export class SyncNativeIO {
  private shared = new SharedArrayBuffer(65536 + 16);
  constructor(private port: MessagePort) {}

  public request<T>(op: NativeOperation, path: string, data?: any): T {
    while (true) {
      const control = new Int32Array(this.shared, 0, 4);
      control.fill(0);
      this.port.postMessage({ op, path, data, shared: this.shared });
      while (Atomics.load(control, 0) === 0) {
        if (Atomics.wait(control, 0, 0, 60000) === 'timed-out') throw new Error(`Local filesystem timed out: ${op} ${path}`);
      }
      const status = Atomics.load(control, 0), length = Atomics.load(control, 1);
      if (status === 2) {
        if (op !== 'read' && op !== 'readAt' && op !== 'list') throw new Error('Unexpected filesystem response size');
        this.shared = new SharedArrayBuffer(length + 16); continue;
      }
      const bytes = new Uint8Array(this.shared, 16, length).slice();
      if (status === -1) {
        const error = JSON.parse(new TextDecoder().decode(bytes));
        throw Object.assign(new Error(error.message), error);
      }
      return (op === 'read' || op === 'readAt' ? bytes : JSON.parse(new TextDecoder().decode(bytes))) as T;
    }
  }
}

/** Project mount. Dirty buffers commit once per tool to the shared write-back IO Worker. */
export class NativeMount implements IFileSystem {
  private dirty = new Map<string, Uint8Array>();
  private stats = new Map<string, FSStats | null>();
  private reads = new Map<string, Uint8Array | null>();
  private lists = new Map<string, string[]>();
  private inputs = new Map<string, Uint8Array>();
  private observed = new Map<string, Uint8Array>();
  constructor(private io: SyncNativeIO) {}

  public setInputs(files: Record<string, string>): void {
    this.inputs.clear();
    for (const [path, text] of Object.entries(files)) this.inputs.set('/' + path.replace(/^\/+/, ''), new TextEncoder().encode(text));
  }

  public begin(): void { this.stats.clear(); this.reads.clear(); this.lists.clear(); this.observed.clear(); }
  public captureInputs(): { readFiles: Record<string, Uint8Array>; probes: Record<string, 'file' | 'dir' | null> } {
    const readFiles: Record<string, Uint8Array> = {}, probes: Record<string, 'file' | 'dir' | null> = {};
    for (const [path, bytes] of this.observed) if (!path.startsWith('/.onlinecpp/')) {
      readFiles[path.slice(1)] = bytes; this.inputs.set(path, bytes);
    }
    for (const [path, stat] of this.stats) if (path !== '/' && !path.startsWith('/.onlinecpp') && !this.dirty.has(path)) probes[path.slice(1)] = stat?.type === 'dir' ? 'dir' : stat ? 'file' : null;
    return { readFiles, probes };
  }
  public flush(): void {
    for (const [path, data] of this.dirty) { this.io.request('write', path, data); this.dirty.delete(path); }
  }
  /**
   * Hand a freshly produced tool output back to the caller without a round trip
   * through the IO worker + IndexedDB. The file is dropped from the dirty set, so
   * the next flush will not write it. Returns null when nothing is buffered.
   */
  public extract(path: string): Uint8Array | null {
    const data = this.dirty.get(path);
    if (data) {
      this.dirty.delete(path);
      this.reads.set(path, data);
      this.stats.set(path, { type: 'file', size: data.length, mode: 0o100644, mtimeNs: BigInt(Date.now()) * 1000000n });
      return data;
    }
    if (this.inputs.has(path)) return null;
    try { return this.readFileSync(path); }
    catch { return null; }
  }
  public readFileSync(path: string): Uint8Array | null {
    if (this.dirty.has(path)) return this.dirty.get(path)!;
    if (this.inputs.has(path)) { const bytes = this.inputs.get(path)!; this.observed.set(path, bytes); return bytes; }
    if (this.reads.has(path)) return this.reads.get(path)!;
    try { const bytes = this.io.request<Uint8Array>('read', path); this.reads.set(path, bytes); this.observed.set(path, bytes); return bytes; }
    catch (error: any) { if (['NotFoundError', 'TypeMismatchError'].includes(error.name)) { this.stats.set(path, null); return null; } throw error; }
  }
  public writeFileSync(path: string, data: Uint8Array): void {
    this.dirty.set(path, data.byteOffset || data.buffer.byteLength !== data.length ? data.slice() : data);
    this.stats.set(path, { type: 'file', size: data.length, mode: 0o100644, mtimeNs: BigInt(Date.now()) * 1000000n });
    this.lists.clear();
  }
  public statSync(path: string): FSStats | null {
    if (this.inputs.has(path)) {
      const stat: FSStats = { type: 'file', size: this.inputs.get(path)!.length, mode: 0o100644, mtimeNs: 0n };
      this.stats.set(path, stat); return stat;
    }
    if (this.stats.has(path)) return this.stats.get(path)!;
    const stat = this.io.request<NativeStat | null>('stat', path);
    const result: FSStats | null = stat ? {
      type: stat.kind === 'directory' ? 'dir' : 'file', size: stat.size,
      mode: stat.kind === 'directory' ? 0o40755 : 0o100644, mtimeNs: BigInt(stat.lastModified) * 1000000n,
    } : null;
    this.stats.set(path, result);
    return result;
  }
  public existsSync(path: string): boolean { return this.statSync(path) !== null; }
  public readdirSync(path: string): string[] {
    if (!this.lists.has(path)) {
      try { this.lists.set(path, this.io.request<NativeEntry[]>('list', path).map((entry) => entry.name)); }
      catch (error: any) { if (error.name !== 'NotFoundError') throw error; return []; }
    }
    return this.lists.get(path)!;
  }
  public mkdirSync(path: string): void { this.io.request('mkdir', path); this.stats.delete(path); this.lists.clear(); }
  public deleteFileSync(path: string): boolean {
    this.dirty.delete(path); this.reads.delete(path); this.stats.delete(path); this.lists.clear();
    try { this.io.request('delete', path); return true; } catch (error: any) { if (error.name === 'NotFoundError') return false; throw error; }
  }
  public async readFile(path: string) { return this.readFileSync(path); }
  public async writeFile(path: string, data: Uint8Array) { this.writeFileSync(path, data); return true; }
  public async stat(path: string) { return this.statSync(path); }
  public async exists(path: string) { return this.existsSync(path); }
  public async readdir(path: string) { return this.readdirSync(path); }
  public async mkdir(path: string) { this.mkdirSync(path); return true; }
  public async deleteFile(path: string) { return this.deleteFileSync(path); }
}
