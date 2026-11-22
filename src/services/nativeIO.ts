export type NativeOperation = 'read' | 'write' | 'stat' | 'statMany' | 'list' | 'snapshot' | 'mkdir' | 'delete' | 'unlink' | 'rmdir' | 'open' | 'readAt' | 'writeAt' | 'truncate' | 'close' | 'sync' | 'finish' | 'flushDisk' | 'clearAll' | 'clearCache';
export type StorageMode = 'disk' | 'browser';
export interface StorageStatus { mode: StorageMode; pending: number; error?: string; }
export interface NativeEntry { name: string; kind: 'file' | 'directory'; }
export interface NativeStat { kind: 'file' | 'directory'; size: number; lastModified: number; }

/** All filesystem access runs off the UI thread. The toolchain gets its own port. */
export class NativeIO {
  private worker = new Worker(new URL('../workers/nativeIO.worker.ts', import.meta.url), { type: 'module' });
  private nextId = 0;
  public storageStatus: StorageStatus = { mode: 'disk', pending: 0 };
  public onStorageStatus?: (status: StorageStatus) => void;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

  constructor() {
    this.worker.onmessage = ({ data }) => {
      if (data.storageStatus) { this.storageStatus = data.storageStatus; this.onStorageStatus?.(data.storageStatus); return; }
      const request = this.pending.get(data.id);
      if (!request) return;
      this.pending.delete(data.id);
      if (data.error) request.reject(Object.assign(new Error(data.error.message), data.error));
      else request.resolve(data.value);
    };
    this.worker.onerror = (event) => {
      for (const request of this.pending.values()) request.reject(new Error(event.message));
      this.pending.clear();
    };
  }

  public mount(root: FileSystemDirectoryHandle | null): Promise<void> { return this.call('mount', { root }); }
  public async connect(kind: 'compiler' | 'runtime' = 'compiler'): Promise<MessagePort> {
    const channel = new MessageChannel();
    await this.call('connect', { port: channel.port1, kind }, [channel.port1]);
    return channel.port2;
  }
  public finishRuntime(): Promise<void> { return this.request('finish', ''); }
  public disconnectCompiler(): void { void this.call('disconnectCompiler', {}).catch(() => {}); }
  public request<T>(op: NativeOperation, path: string, data?: any): Promise<T> {
    return this.call(op, { path, data });
  }
  private call(op: string, args: any, transfer: Transferable[] = []): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, op, ...args }, transfer);
    });
  }
}
