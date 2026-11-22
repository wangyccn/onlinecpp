import type { NativeEntry, NativeStat, StorageMode, StorageStatus } from './nativeIO';

export interface BufferedEntry {
  path: string; kind: 'file' | 'directory' | 'deleted'; version: number; lastModified: number;
  blob?: Blob; reset?: boolean; fresh?: boolean;
}
export interface IOJournal {
  load(): Promise<BufferedEntry[]>;
  update(entries: BufferedEntry[], remove?: string[]): Promise<void>;
  removeVersion(path: string, version: number): Promise<void>;
  removeVersions(items: Array<{ path: string; version: number }>): Promise<void>;
  clearAll(): Promise<void>;
}
export interface DiskBackend {
  read(path: string): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  stat(path: string): Promise<NativeStat | null>;
  list(path: string): Promise<NativeEntry[]>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
}
const missing = (path: string) => Object.assign(new Error('No such file or directory: ' + path), { name: 'NotFoundError', errno: 44 });
const mismatch = () => Object.assign(new Error('Not a directory'), { name: 'TypeMismatchError', errno: 54 });
const inside = (path: string, parent: string) => path === parent || path.startsWith(parent + '/');
const related = (a: string, b: string) => inside(a, b) || inside(b, a);

/** A disk write that never settles is worse than a failure: it pins the queue forever. */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function withTimeout<T>(task: Promise<T>, ms: number, message: string): Promise<T> {
  if (!(ms > 0)) return task;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error(message), { name: 'TimeoutError', errno: 5 })), ms);
    task.then((value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); });
  });
}
const RETRY_LIMIT = 5;

/** All user/compiler/runtime IO goes through this write-back filesystem in the IO Worker.
 * A write is acknowledged only after its IDB transaction commits, NOT after slow external IO. */
export class BufferedFileSystem {
  private entries = new Map<string, BufferedEntry>();
  private due = new Map<string, number>();
  private active = new Map<string, Promise<void>>();
  private errors = new Map<string, unknown>();
  private attempts = new Map<string, number>();
  private materialized = new Set<string>();
  private knownDirectories = new Set(['']);
  private version = 0;
  private mutations: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private flushing = false;

  constructor(private journal: IOJournal, private disk: DiskBackend | null,
    private notify: (status: StorageStatus) => void = () => {}, private delay = 350, private concurrency = 6,
    private commitTimeout = 30000, private flushTimeout = 60000) {}

  public async init(): Promise<void> {
    for (const entry of await this.journal.load()) {
      // A previous tab may have closed between external commit and journal cleanup.
      entry.fresh = false; this.entries.set(entry.path, entry); this.due.set(entry.path, Date.now() + this.delay);
      this.version = Math.max(this.version, entry.version);
    }
    this.changed(); this.drain();
  }
  public get mode(): StorageMode { return this.disk ? 'disk' : 'browser'; }
  public get status(): StorageStatus {
    const error = this.errors.values().next().value as any;
    return { mode: this.mode, pending: this.disk ? this.entries.size : 0, error: error ? String(error.message || error) : undefined };
  }
  private changed(): void { this.notify(this.status); }
  private mutate<T>(task: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(task); this.mutations = next.catch(() => {}); return next;
  }
  private hidden(path: string): boolean {
    for (const entry of this.entries.values()) if (entry.kind === 'deleted' || entry.reset) {
      if (inside(path, entry.path)) return true;
    }
    return false;
  }
  private async statNow(path: string): Promise<NativeStat | null> {
    if (!path) return { kind: 'directory', size: 0, lastModified: 0 };
    const entry = this.entries.get(path);
    if (entry) return entry.kind === 'deleted' ? null : { kind: entry.kind, size: entry.blob?.size || 0, lastModified: entry.lastModified };
    return !this.disk || this.hidden(path) ? null : this.disk.stat(path);
  }
  public async stat(path: string): Promise<NativeStat | null> { await this.mutations; return this.statNow(path); }
  public async read(path: string): Promise<Uint8Array> {
    await this.mutations;
    const entry = this.entries.get(path);
    if (entry?.kind === 'file') return new Uint8Array(await entry.blob!.arrayBuffer());
    if (entry?.kind === 'directory') throw Object.assign(new Error('Is a directory'), { name: 'TypeMismatchError', errno: 31 });
    if (!this.disk || this.hidden(path)) throw missing(path);
    return this.disk.read(path);
  }
  private async listNow(path: string): Promise<NativeEntry[]> {
    const stat = await this.statNow(path);
    if (!stat) throw missing(path); if (stat.kind !== 'directory') throw mismatch();
    const result = new Map<string, NativeEntry>();
    if (this.disk && !this.hidden(path)) {
      try { for (const entry of await this.disk.list(path)) result.set(entry.name, entry); }
      catch (error: any) { if (error.name !== 'NotFoundError' || !this.entries.has(path)) throw error; }
    }
    const prefix = path ? path + '/' : '';
    for (const entry of this.entries.values()) {
      if (!entry.path.startsWith(prefix)) continue;
      const name = entry.path.slice(prefix.length); if (!name || name.includes('/')) continue;
      if (entry.kind === 'deleted') result.delete(name); else result.set(name, { name, kind: entry.kind });
    }
    return [...result.values()];
  }
  public async list(path: string): Promise<NativeEntry[]> { await this.mutations; return this.listNow(path); }
  private make(path: string, kind: BufferedEntry['kind'], extra: Partial<BufferedEntry> = {}): BufferedEntry {
    return { path, kind, version: ++this.version, lastModified: Date.now(), ...extra };
  }
  private async stage(entries: BufferedEntry[], remove: string[] = []): Promise<void> {
    await this.journal.update(entries, remove);
    for (const path of remove) { this.entries.delete(path); this.due.delete(path); this.errors.delete(path); this.attempts.delete(path); }
    for (const entry of entries) {
      this.entries.set(entry.path, entry); this.due.set(entry.path, Date.now() + this.delay);
      this.errors.delete(entry.path); this.attempts.delete(entry.path);
    }
    this.changed(); this.drain();
  }
  private async parents(path: string): Promise<BufferedEntry[]> {
    const parts = path.split('/'); parts.pop(); const additions: BufferedEntry[] = []; let parent = '';
    for (const part of parts) {
      parent = parent ? parent + '/' + part : part;
      if (this.knownDirectories.has(parent)) continue;
      const stat = await this.statNow(parent); if (stat && stat.kind !== 'directory') throw mismatch();
      if (!stat) additions.push(this.make(parent, 'directory', { reset: this.entries.get(parent)?.kind === 'deleted' }));
    }
    return additions;
  }
  public write(path: string, data: Uint8Array | string): Promise<void> {
    // Capture caller-owned data before awaiting; replies may transfer their ArrayBuffers.
    const blob = new Blob([typeof data === 'string' ? data : data.slice() as Uint8Array<ArrayBuffer>]);
    return this.mutate(async () => {
      const previous = this.entries.get(path), stat = await this.statNow(path);
      if (stat?.kind === 'directory') throw Object.assign(new Error('Is a directory'), { name: 'TypeMismatchError', errno: 31 });
      const parents = await this.parents(path);
      await this.stage([...parents, this.make(path, 'file', { blob, fresh: previous?.kind === 'deleted' ? false : previous?.fresh ?? !stat, reset: previous?.reset || previous?.kind === 'deleted' })]);
      for (const parent of parents) this.knownDirectories.add(parent.path);
    });
  }
  public mkdir(path: string, exclusive = false): Promise<void> {
    return this.mutate(async () => {
      const stat = await this.statNow(path);
      if (stat && exclusive) throw Object.assign(new Error('File exists'), { errno: 20 });
      if (stat?.kind === 'file') throw mismatch(); if (stat) { this.knownDirectories.add(path); return; }
      const parents = await this.parents(path);
      await this.stage([...parents, this.make(path, 'directory', { reset: this.entries.get(path)?.kind === 'deleted' })]);
      for (const entry of parents) this.knownDirectories.add(entry.path); this.knownDirectories.add(path);
    });
  }
  public remove(path: string, kind: 'delete' | 'unlink' | 'rmdir' = 'delete'): Promise<void> {
    return this.mutate(async () => {
      if (!path) throw new Error('Cannot remove the selected root');
      const stat = await this.statNow(path); if (!stat) throw missing(path);
      if (kind === 'unlink' && stat.kind === 'directory') throw Object.assign(new Error('Is a directory'), { errno: 31 });
      if (kind === 'rmdir') {
        if (stat.kind !== 'directory') throw mismatch();
        if ((await this.listNow(path)).length) throw Object.assign(new Error('Directory not empty'), { errno: 55 });
      }
      const previous = this.entries.get(path), remove = [...this.entries.keys()].filter((name) => inside(name, path));
      // New, short-lived compiler outputs never need an external create/delete round trip.
      const neverWritten = previous?.fresh && !this.materialized.has(path) && ![...this.active.keys()].some((name) => related(path, name));
      await this.stage(!this.disk || neverWritten ? [] : [this.make(path, 'deleted')], remove);
      for (const name of this.knownDirectories) if (inside(name, path)) this.knownDirectories.delete(name);
    });
  }
  private drain(): void {
    clearTimeout(this.timer); this.timer = undefined; if (!this.disk) return;
    let nextDue = Infinity;
    const entries = [...this.entries.values()].sort((a, b) => a.version - b.version);
    for (const entry of entries) {
      const path = entry.path;
      if (this.active.size >= this.concurrency) break;
      if (this.errors.has(path) || [...this.active.keys()].some((name) => related(name, path))) continue;
      if (entries.some((other) => other.version < entry.version && related(other.path, path))) continue;
      const due = this.due.get(path) || 0; if (due > Date.now()) { nextDue = Math.min(nextDue, due); continue; }
      const task = this.commit(entry); this.active.set(path, task);
      void task.finally(() => { this.active.delete(path); this.drain(); });
    }
    if (nextDue < Infinity) this.timer = setTimeout(() => this.drain(), Math.max(0, nextDue - Date.now()));
  }
  private async commit(entry: BufferedEntry): Promise<void> {
    const attempt = (this.attempts.get(entry.path) || 0) + 1;
    this.attempts.set(entry.path, attempt);
    try {
      await withTimeout(this.commitNow(entry), this.commitTimeout,
        `Writing "${entry.path}" to disk timed out after ${Math.round(this.commitTimeout / 1000)}s — the file may be locked by another program (IDE, antivirus, cloud sync)`);
      this.attempts.delete(entry.path);
      await this.mutate(async () => {
        // Completing version N must never delete a newer queued version N+1.
        if (this.entries.get(entry.path)?.version !== entry.version) return;
        await this.journal.removeVersion(entry.path, entry.version);
        this.entries.delete(entry.path); this.due.delete(entry.path); this.errors.delete(entry.path); this.materialized.delete(entry.path); this.changed();
      });
    } catch (error) {
      if (this.entries.get(entry.path)?.version !== entry.version) return;
      if (this.flushing || attempt >= RETRY_LIMIT) { this.errors.set(entry.path, error); this.changed(); return; }
      // A transient failure must not leave the entry pinned forever: retry with backoff.
      this.due.set(entry.path, Date.now() + Math.min(4000, 250 * 2 ** (attempt - 1)));
      this.changed();
    }
  }
  /** The pure external commit; `commit()` adds the timeout, retry and journal cleanup around it. */
  private async commitNow(entry: BufferedEntry): Promise<void> {
    if (entry.reset || entry.kind === 'deleted') await this.disk!.remove(entry.path);
    if (entry.kind === 'directory') await this.disk!.mkdir(entry.path);
    if (entry.kind === 'file') await this.disk!.write(entry.path, new Uint8Array(await entry.blob!.arrayBuffer()));
    this.materialized.add(entry.path);
  }
  /** Explicit sync / workspace switch only. Builds and normal saves do not wait for disk. */
  public async flushDisk(): Promise<void> {
    await this.mutations; if (!this.disk) return;
    this.errors.clear();
    for (const path of this.entries.keys()) { this.attempts.delete(path); this.due.set(path, 0); }
    const deadline = Date.now() + this.flushTimeout;
    this.flushing = true;
    try {
      while (this.entries.size || this.active.size) {
        this.drain();
        if (this.active.size) await Promise.all([...this.active.values()]);
        await this.mutations;
        if (!this.entries.size) return;
        if (this.errors.size) throw this.errors.values().next().value;
        if (Date.now() > deadline) throw Object.assign(new Error(`Timed out syncing ${this.entries.size} file(s) to disk`), { name: 'TimeoutError' });
        // Never busy-spin: yield until the next queued attempt is due, then force every entry forward again.
        const due = Math.min(...[...this.entries.keys()].map((path) => this.due.get(path) || 0));
        await sleep(Math.max(8, Math.min(200, due - Date.now())));
        for (const path of this.entries.keys()) this.due.set(path, 0);
      }
    } finally { this.flushing = false; }
  }
  /** Clear all buffered entries and IDB journal data for this workspace. Does not touch external disk. */
  public async clearAll(): Promise<void> {
    await this.mutations;
    this.entries.clear(); this.due.clear(); this.errors.clear(); this.attempts.clear();
    this.materialized.clear(); this.knownDirectories.clear(); this.knownDirectories.add('');
    await this.journal.clearAll();
    this.changed();
  }
}

/** The journal is shared by recovered native workspaces and the disk-free workspace. */
export class IndexedIOJournal implements IOJournal {
  private constructor(private db: IDBDatabase, public readonly workspace: string) {}
  /** A blocked or quota-wedged IndexedDB transaction must fail the save, never hang it. */
  private static readonly TIMEOUT = 15000;
  private static guard<T>(task: Promise<T>, what: string): Promise<T> {
    return withTimeout(task, IndexedIOJournal.TIMEOUT,
      `IndexedDB ${what} timed out after ${IndexedIOJournal.TIMEOUT / 1000}s (another tab may be blocking the database or the quota is exhausted)`);
  }
  public static async open(root: FileSystemDirectoryHandle | null, browserWorkspace = 'browser'): Promise<IndexedIOJournal> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('onlinecpp-io-v1', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('roots', { keyPath: 'id' });
        request.result.createObjectStore('entries', { keyPath: ['workspace', 'path'] }).createIndex('workspace', 'workspace');
      };
      request.onsuccess = () => { request.result.addEventListener('versionchange', () => request.result.close()); resolve(request.result); };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('IndexedDB is blocked by another tab holding an older version; close the other tabs and retry'));
    });
    let workspace = browserWorkspace;
    if (root) {
      const roots = await new Promise<Array<{ id: string; handle: FileSystemDirectoryHandle }>>((resolve, reject) => {
        const request = db.transaction('roots').objectStore('roots').getAll();
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      let found: string | undefined;
      for (const saved of roots) if (await root.isSameEntry(saved.handle)) { found = saved.id; break; }
      workspace = found || crypto.randomUUID();
      if (!found) await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('roots', 'readwrite'); tx.objectStore('roots').put({ id: workspace, handle: root });
        tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => {};
      });
    }
    return new IndexedIOJournal(db, workspace);
  }
  public load(): Promise<BufferedEntry[]> {
    return IndexedIOJournal.guard(new Promise<BufferedEntry[]>((resolve, reject) => {
      const request = this.db.transaction('entries').objectStore('entries').index('workspace').getAll(this.workspace);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    }), 'restore');
  }
  public update(entries: BufferedEntry[], remove: string[] = []): Promise<void> {
    return IndexedIOJournal.guard(new Promise<void>((resolve, reject) => {
      const tx = this.db.transaction('entries', 'readwrite'), store = tx.objectStore('entries');
      for (const path of remove) store.delete([this.workspace, path]);
      for (const entry of entries) store.put({ ...entry, workspace: this.workspace });
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => {};
    }), 'write');
  }
  public removeVersion(path: string, version: number): Promise<void> {
    return IndexedIOJournal.guard(new Promise<void>((resolve, reject) => {
      const tx = this.db.transaction('entries', 'readwrite'), store = tx.objectStore('entries');
      const request = store.get([this.workspace, path]);
      request.onsuccess = () => { if (request.result?.version === version) store.delete([this.workspace, path]); };
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => {};
    }), 'cleanup');
  }
  /** Batch-remove multiple versions in a single IDB transaction to reduce write amplification. */
  public removeVersions(items: Array<{ path: string; version: number }>): Promise<void> {
    if (!items.length) return Promise.resolve();
    return IndexedIOJournal.guard(new Promise<void>((resolve, reject) => {
      const tx = this.db.transaction('entries', 'readwrite'), store = tx.objectStore('entries');
      for (const { path, version } of items) {
        const request = store.get([this.workspace, path]);
        request.onsuccess = () => { if (request.result?.version === version) store.delete([this.workspace, path]); };
      }
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => {};
    }), 'cleanup');
  }
  public close(): void { this.db.close(); }
  public clearAll(): Promise<void> {
    return IndexedIOJournal.guard(new Promise<void>((resolve, reject) => {
      const tx = this.db.transaction(['entries', 'roots'], 'readwrite');
      tx.objectStore('entries').index('workspace').openKeyCursor(this.workspace).onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) { tx.objectStore('entries').delete(cursor.primaryKey); cursor.continue(); }
      };
      tx.objectStore('roots').delete(this.workspace);
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => {};
    }), 'clear');
  }
}
