import type { NativeEntry } from '../services/nativeIO';
import { cleanNativePath } from '../services/localPaths';
import { BufferedFileSystem, IndexedIOJournal, type DiskBackend } from '../services/bufferedFileSystem';

let root: FileSystemDirectoryHandle | null = null;
let buffered: BufferedFileSystem | null = null;
let journal: IndexedIOJournal | null = null;
let releaseWorkspace: (() => void) | undefined;
const filesystem = () => { if (!buffered) throw new Error('Open a folder or select browser storage first'); return buffered; };
async function lockWorkspace(workspace: string): Promise<void> {
  if (!navigator.locks) return;
  await new Promise<void>((resolve, reject) => {
    void navigator.locks.request('onlinecpp-io-' + workspace, { ifAvailable: true }, async (lock) => {
      if (!lock) { reject(new Error('This workspace is already open in another tab. Close it before switching.')); return; }
      await new Promise<void>((release) => { releaseWorkspace = release; resolve(); });
    }).catch(reject);
  });
}
const directories = new Map<string, FileSystemDirectoryHandle>();
const files = new Map<string, FileSystemFileHandle>();
const writes = new Map<string, Promise<any>>();
const openWritables = new Map<string, FileSystemWritableFileStream>();
const encoder = new TextEncoder();
const textCache = new Map<string, { size: number; lastModified: number; content: string }>();
// Kept outside the executable Worker so SIGINT can still commit completed writes.
const runtimeFiles = new Map<string, { bytes: Uint8Array; size: number; dirty: boolean; writable: boolean; refs: number }>();
const runtimeOpening = new Set<string>();
const connections = new Map<MessagePort, { kind: string; chain: Promise<void> }>();
// File System Access promises never settle when the target file is locked (Windows + IDE/AV/OneDrive)
// or when the permission state stays "prompt" inside a worker. Every stage therefore needs a deadline.
const STAGE_TIMEOUT = 20000;

function withTimeout<T>(task: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error(message), { name: 'TimeoutError', errno: 5 })), ms);
    task.then((value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); });
  });
}

/** Drop cached handles for a path so the next attempt re-resolves them from the root handle. */
function forgetHandles(path: string): void {
  files.delete(path);
  const parts = path.split('/');
  for (let index = parts.length - 1; index > 0; index--) directories.delete(parts.slice(0, index).join('/'));
}

async function resetWritable(path: string): Promise<void> {
  const stale = openWritables.get(path);
  if (!stale) return;
  openWritables.delete(path);
  await withTimeout(stale.abort(), 2000, 'Resetting a stuck write stream timed out').catch(() => {});
}

async function writeOnce(path: string, data: Uint8Array | string, fresh: boolean): Promise<void> {
  const handle = await withTimeout(file(path, true, fresh), STAGE_TIMEOUT,
    `Opening "${path}" for writing timed out — another program may hold the file open`);
  // A worker can never satisfy a permission prompt, so surface a denial instead of hanging.
  const probe = handle as FileSystemFileHandle & { queryPermission?: (descriptor: { mode: 'readwrite' }) => Promise<string> };
  if (typeof probe.queryPermission === 'function') {
    try {
      const permission = await withTimeout(probe.queryPermission({ mode: 'readwrite' }), 5000, 'Permission query timed out');
      if (permission === 'denied') throw Object.assign(new Error(`No write permission for "${path}". Re-open the folder and choose "Allow".`), { name: 'NotAllowedError' });
    } catch (error: any) {
      if (error.name === 'NotAllowedError') throw error;
    }
  }
  const writable = await withTimeout(handle.createWritable(), STAGE_TIMEOUT,
    `Preparing "${path}" for writing timed out — another program may hold the file open`);
  openWritables.set(path, writable);
  try {
    await withTimeout(writable.write(data as any), STAGE_TIMEOUT, `Writing "${path}" timed out`);
    await withTimeout(writable.close(), STAGE_TIMEOUT,
      `Committing "${path}" timed out — the file may be locked by an IDE, antivirus or cloud sync`);
    openWritables.delete(path);
    textCache.delete(path);
  } catch (error) {
    openWritables.delete(path);
    forgetHandles(path);
    await withTimeout(writable.abort(), 2000, 'Aborting a failed write stream timed out').catch(() => {});
    throw error;
  }
}

async function writeContents(path: string, data: Uint8Array | string): Promise<void> {
  const task = (writes.get(path) || Promise.resolve()).catch(() => {}).then(async () => {
    await resetWritable(path);
    try { await writeOnce(path, data, false); }
    catch (error: any) {
      // Cached directory/file handles go stale whenever the folder changes outside the app.
      if (!['NotFoundError', 'TypeMismatchError', 'InvalidStateError'].includes(error.name)) throw error;
      forgetHandles(path);
      await writeOnce(path, data, true);
    }
  });
  writes.set(path, task);
  try { await task; } finally { if (writes.get(path) === task) writes.delete(path); }
}

async function commitRuntime(path: string): Promise<void> {
  const entry = runtimeFiles.get(path);
  if (!entry?.dirty) return;
  await filesystem().write(path, entry.bytes.subarray(0, entry.size));
  textCache.delete(path);
  entry.dirty = false;
}

async function directory(path: string, create = false, fresh = false): Promise<FileSystemDirectoryHandle> {
  if (!root) throw new Error('Open a local folder first');
  if (!fresh && directories.has(path)) return directories.get(path)!;
  let handle = root, key = '';
  for (const part of path.split('/').filter(Boolean)) {
    key = key ? `${key}/${part}` : part;
    handle = (!fresh && directories.get(key)) || await handle.getDirectoryHandle(part, { create });
    directories.set(key, handle);
  }
  return handle;
}

async function file(path: string, create = false, fresh = false): Promise<FileSystemFileHandle> {
  if (!fresh && files.has(path)) return files.get(path)!;
  const parts = path.split('/'), name = parts.pop()!;
  const handle = await (await directory(parts.join('/'), create, fresh)).getFileHandle(name, { create });
  files.set(path, handle);
  return handle;
}

async function nativeFile(path: string): Promise<File> {
  try { return await (await file(path)).getFile(); }
  catch (error: any) {
    if (error.name !== 'NotFoundError') throw error;
    files.delete(path); return (await file(path, false, true)).getFile();
  }
}

const diskBackend: DiskBackend = {
  read: async (path) => new Uint8Array(await (await nativeFile(path)).arrayBuffer()),
  write: writeContents,
  mkdir: async (path) => { await directory(path, true); },
  list: async (path) => {
    const entries: NativeEntry[] = [];
    for await (const [name, handle] of (await directory(path)) as any) {
      const full = path ? path + '/' + name : name;
      if (handle.kind === 'file') files.set(full, handle); else directories.set(full, handle);
      entries.push({ name, kind: handle.kind });
    }
    return entries;
  },
  stat: async (path) => {
    if (!path) { await directory(''); return { kind: 'directory', size: 0, lastModified: 0 }; }
    try { const f = await nativeFile(path); return { kind: 'file', size: f.size, lastModified: f.lastModified }; }
    catch (error: any) {
      if (!['NotFoundError', 'TypeMismatchError'].includes(error.name)) throw error;
      files.delete(path);
      try { await directory(path, false, true); return { kind: 'directory', size: 0, lastModified: 0 }; }
      catch (error: any) { if (error.name === 'NotFoundError') return null; throw error; }
    }
  },
  remove: async (path) => {
    const parts = path.split('/'), name = parts.pop()!;
    try { await (await directory(parts.join('/'))).removeEntry(name, { recursive: true }); }
    catch (error: any) { if (error.name !== 'NotFoundError') throw error; }
    for (const key of files.keys()) if (key === path || key.startsWith(path + '/')) files.delete(key);
    for (const key of directories.keys()) if (key === path || key.startsWith(path + '/')) directories.delete(key);
    for (const key of textCache.keys()) if (key === path || key.startsWith(path + '/')) textCache.delete(key);
  },
};

async function operation(op: string, rawPath: string, data?: any): Promise<any> {
  const path = cleanNativePath(rawPath);
  if (op === 'finish') {
    const active = [];
    for (const [port, connection] of connections) if (connection.kind === 'runtime') {
      port.close(); connections.delete(port); active.push(connection.chain);
    }
    await Promise.all(active).catch(() => {});
    let failure: unknown;
    for (const name of [...runtimeFiles.keys()]) {
      try { await commitRuntime(name); }
      catch (error) { failure ??= error; }
      // Always release the buffer: a file stuck in `runtimeFiles` blocks every later editor save.
      finally { runtimeFiles.delete(name); }
    }
    if (failure) throw failure;
    return;
  }
  if (op === 'open') {
    if ((data.flags & 512) && !(data.flags & 3)) throw Object.assign(new Error('Truncate requires a writable file'), { errno: 8 });
    let entry = runtimeFiles.get(path);
    if (!entry) {
      if (data.flags & 3) runtimeOpening.add(path);
      try {
        let bytes: Uint8Array;
        let created = false;
        try {
          // Truncating a large file must not first copy its old contents into RAM.
          if (data.flags & 512) {
            const stat = await filesystem().stat(path);
            if (!stat) throw Object.assign(new Error('No such file'), { name: 'NotFoundError' });
            if (stat.kind !== 'file') throw Object.assign(new Error('Is a directory'), { errno: 31 });
            bytes = new Uint8Array(0);
          }
          else bytes = await operation('read', path);
          if ((data.flags & 64) && (data.flags & 128)) throw Object.assign(new Error('File exists'), { errno: 20 });
        }
        catch (error: any) {
          if (error.name !== 'NotFoundError' || !(data.flags & 64)) throw error;
          // POSIX open(O_CREAT) does not create missing parent directories.
          const parent = await filesystem().stat(path.split('/').slice(0, -1).join('/'));
          if (!parent) throw Object.assign(new Error('No such directory'), { name: 'NotFoundError', errno: 44 });
          if (parent.kind !== 'directory') throw Object.assign(new Error('Not a directory'), { errno: 54 });
          bytes = new Uint8Array(0); created = true;
        }
        entry = { bytes, size: bytes.length, dirty: created, writable: !!(data.flags & 3), refs: 0 };
        runtimeFiles.set(path, entry);
      } finally { runtimeOpening.delete(path); }
    } else if ((data.flags & 64) && (data.flags & 128)) throw Object.assign(new Error('File exists'), { name: 'InvalidModificationError' });
    if (data.flags & 512) { entry.size = 0; entry.dirty = true; }
    if (data.flags & 3) entry.writable = true;
    entry.refs++;
    return { size: entry.size };
  }
  if (op === 'readAt') {
    const entry = runtimeFiles.get(path);
    if (!entry) throw new Error('File descriptor closed');
    return entry.bytes.slice(data.position, Math.min(entry.size, data.position + data.length));
  }
  if (op === 'writeAt' || op === 'truncate') {
    const entry = runtimeFiles.get(path);
    if (!entry) throw new Error('File descriptor closed');
    if (!entry.writable) throw Object.assign(new Error('File is read-only'), { errno: 8 });
    const position = data.append ? entry.size : data.position;
    const size = op === 'truncate' ? data.size : Math.max(entry.size, position + data.bytes.length);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid file size');
    if (size > entry.bytes.length) {
      const bytes = new Uint8Array(Math.max(size, Math.min(entry.bytes.length * 2, 1024 * 1024 * 1024)));
      bytes.set(entry.bytes.subarray(0, entry.size)); entry.bytes = bytes;
    }
    if (size > entry.size) entry.bytes.fill(0, entry.size, size);
    if (op === 'writeAt') entry.bytes.set(data.bytes, position);
    entry.size = size; entry.dirty = true;
    return { size, position: op === 'writeAt' ? position + data.bytes.length : size };
  }
  if (op === 'close' || op === 'sync') {
    const entry = runtimeFiles.get(path);
    if (!entry) return;
    if (op === 'close') entry.refs--;
    if (op === 'sync' || entry.refs <= 0) {
      try { await commitRuntime(path); }
      catch (error) { if (entry.refs <= 0) runtimeFiles.delete(path); throw error; }
      if (entry.refs <= 0) runtimeFiles.delete(path);
    }
    return;
  }
  if (op === 'flushDisk') return filesystem().flushDisk();
  if (op === 'clearAll') return filesystem().clearAll();
  if (op === 'clearCache') {
    // Delete build cache directories and binary artifacts (.wasm, .o, .a) without touching source files.
    const targets = ['.onlinecpp'];
    for (const target of targets) {
      try { await filesystem().remove(target, 'delete'); }
      catch (error: any) { if (error.name !== 'NotFoundError') throw error; }
    }
    // Also scan for stray .wasm/.o files in root
    try {
      const rootEntries = await filesystem().list('');
      for (const entry of rootEntries) {
        if (entry.kind === 'file' && /\.(wasm|o|a|obj|so|dll|dylib)$/i.test(entry.name)) {
          try { await filesystem().remove(entry.name, 'delete'); } catch {}
        }
      }
    } catch {}
    return;
  }
  if (op === 'write') {
    if (runtimeOpening.has(path) || runtimeFiles.get(path)?.writable) throw Object.assign(new Error('File is open for writing by the running program; retry after it exits'), { name: 'NoModificationAllowedError' });
    await filesystem().write(path, data); textCache.delete(path); return;
  }
  if (op === 'read') return filesystem().read(path);
  if (op === 'snapshot') {
    const pending = [''], paths: string[] = [], ignored = new Set<string>(data.ignored);
    while (pending.length) {
      await Promise.all(pending.splice(0, 4).map(async (dir) => {
        for (const { name, kind } of await filesystem().list(dir)) {
          if (name.startsWith('.') || name.startsWith('~') || ignored.has(name)) continue;
          const relative = dir ? dir + '/' + name : name;
          if (kind === 'directory') pending.push(relative);
          else if (/\.(c|cc|cpp|cxx|h|hh|hpp|hxx|inc|ipp|tpp)$/i.test(name)) {
            if (data.mode === 'single' && /\.(c|cc|cpp|cxx)$/i.test(name) && relative !== data.mainFile) continue;
            paths.push(relative);
          }
        }
      }));
    }
    const result: Record<string, string> = {};
    for (let i = 0; i < paths.length; i += 4) await Promise.all(paths.slice(i, i + 4).map(async (name) => {
      const stat = await filesystem().stat(name), cached = textCache.get(name);
      if (stat && cached && cached.size === stat.size && cached.lastModified === stat.lastModified) result[name] = cached.content;
      else {
        result[name] = new TextDecoder().decode(await filesystem().read(name));
        if (stat) textCache.set(name, { size: stat.size, lastModified: stat.lastModified, content: result[name] });
      }
    }));
    for (const name of textCache.keys()) if (!(name in result)) textCache.delete(name);
    return result;
  }
  if (op === 'mkdir') {
    if (data?.exclusive) {
      const parent = await filesystem().stat(path.split('/').slice(0, -1).join('/'));
      if (!parent) throw Object.assign(new Error('No such directory'), { errno: 44 });
      if (parent.kind !== 'directory') throw Object.assign(new Error('Not a directory'), { errno: 54 });
    }
    return filesystem().mkdir(path, !!data?.exclusive);
  }
  if (op === 'list') return filesystem().list(path);
  if (op === 'stat') {
    const opened = runtimeFiles.get(path);
    return opened ? { kind: 'file', size: opened.size, lastModified: Date.now() } : filesystem().stat(path);
  }
  if (op === 'statMany') {
    const result: Record<string, 'file' | 'dir' | null> = {};
    for (let i = 0; i < data.length; i += 4) await Promise.all(data.slice(i, i + 4).map(async (name: string) => {
      const stat = await operation('stat', name); result[name] = stat ? stat.kind === 'directory' ? 'dir' : 'file' : null;
    }));
    return result;
  }
  if (op === 'delete' || op === 'unlink' || op === 'rmdir') {
    const parts = path.split('/'), name = parts.pop()!;
    if (!name) throw new Error('Cannot remove the selected root');
    if ([...runtimeFiles.keys(), ...runtimeOpening].some((key) => key === path || key.startsWith(path + '/'))) throw Object.assign(new Error('File is still open by the running program'), { errno: 10 });
    await filesystem().remove(path, op);
    for (const key of textCache.keys()) if (key === path || key.startsWith(path + '/')) textCache.delete(key);
    for (const key of files.keys()) if (key === path || key.startsWith(path + '/')) files.delete(key);
    for (const key of directories.keys()) if (key === path || key.startsWith(path + '/')) directories.delete(key);
    return;
  }
  throw new Error(`Unknown native IO operation: ${op}`);
}

async function handleRequest(message: any, reply: (data: any, transfer?: Transferable[]) => void): Promise<void> {
  const { id, op, shared } = message;
  try {
    let value: any;
    if (op === 'mount') {
      await operation('finish', '');
      await buffered?.flushDisk();
      const nextJournal = await IndexedIOJournal.open(message.root);
      const sameWorkspace = journal?.workspace === nextJournal.workspace;
      if (!sameWorkspace) {
        // Acquire the next lock before giving up the current, still usable workspace.
        const oldRelease = releaseWorkspace;
        try { await lockWorkspace(nextJournal.workspace); } catch (error) { nextJournal.close(); throw error; }
        oldRelease?.();
      }
      journal?.close(); journal = nextJournal;
      root = message.root; directories.clear(); files.clear(); textCache.clear();
      buffered = new BufferedFileSystem(journal, root ? diskBackend : null, (storageStatus) => self.postMessage({ storageStatus }));
      await buffered.init();
    } else if (op === 'connect') {
      const connection = { kind: message.kind || 'compiler', chain: Promise.resolve() };
      connections.set(message.port, connection);
      message.port.onmessage = ({ data }: MessageEvent) => {
        connection.chain = connection.chain.then(() => handleRequest(data, (result, transfer) => message.port.postMessage(result, transfer || [])));
      };
      message.port.start();
    } else if (op === 'disconnectCompiler') {
      for (const [port, connection] of connections) if (connection.kind === 'compiler') { port.close(); connections.delete(port); }
    } else value = await operation(op, message.path, message.data);
    if (!shared) { reply({ id, value }, value instanceof Uint8Array ? [value.buffer as ArrayBuffer] : []); return; }
    const control = new Int32Array(shared, 0, 4);
    const bytes = value instanceof Uint8Array ? value : encoder.encode(JSON.stringify(value ?? null));
    Atomics.store(control, 1, bytes.length);
    if (bytes.length > shared.byteLength - 16) Atomics.store(control, 0, 2);
    else { new Uint8Array(shared, 16, bytes.length).set(bytes); Atomics.store(control, 0, 1); }
    Atomics.notify(control, 0);
  } catch (error: any) {
    if (shared) {
      const control = new Int32Array(shared, 0, 4);
      const bytes = encoder.encode(JSON.stringify({ message: error.message, name: error.name, errno: error.errno }));
      const size = Math.min(bytes.length, shared.byteLength - 16);
      new Uint8Array(shared, 16, size).set(bytes.subarray(0, size));
      Atomics.store(control, 1, size); Atomics.store(control, 0, -1); Atomics.notify(control, 0);
    } else reply({ id, error: { message: error.message, name: error.name, errno: error.errno } });
  }
}

self.onmessage = ({ data }) => void handleRequest(data, (result, transfer) => self.postMessage(result, { transfer: transfer || [] }));
