import { SyncNativeIO } from './nativeMount';

type Descriptor = { path: string; position: number; flags: number; directory?: boolean };
class ProcessExit { constructor(public code: number) {} }

/** Standalone Emscripten/WASI ABI, with a real preopened local workspace. */
export async function executeWasm(image: Uint8Array | WebAssembly.Module, io: SyncNativeIO, stdin: () => number, output: (fd: number, bytes: Uint8Array) => void, cwd = '', args: string[] = [], program = 'program'): Promise<number> {
  let memory: WebAssembly.Memory;
  let instance: WebAssembly.Instance;
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  const descriptors = new Map<number, Descriptor>([[3, { path: '', position: 0, flags: 0, directory: true }]]);
  let nextFd = 4;
  const view = () => new DataView(memory.buffer);
  const heap = () => new Uint8Array(memory.buffer);
  const string = (ptr: number, length?: number) => {
    const h = heap(); let end = ptr;
    if (length === undefined) { while (end < h.length && h[end]) end++; } else end += length;
    return decoder.decode(h.subarray(ptr, end));
  };
  const fd = (number: number) => { const item = descriptors.get(number); if (!item) throw { errno: 8 }; return item; };
  const resolve = (path: string, base = cwd) => {
    if (path.startsWith('/workspace/')) path = path.slice(11);
    else if (path === '/workspace' || path === '/home/user') path = '';
    else if (path.startsWith('/home/user/')) path = path.slice(11);
    else if (path.startsWith('/')) path = path.slice(1);
    else path = base ? `${base}/${path}` : path;
    const parts: string[] = [];
    for (const part of path.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') { if (!parts.length) throw { errno: 76 }; parts.pop(); } else parts.push(part);
    }
    return parts.join('/');
  };
  const relative = (dir: number, path: string) => resolve(path, dir === -100 ? cwd : fd(dir).path);
  const errno = (error: any): number => error.errno || ({
    NotFoundError: 44, NotAllowedError: 2, SecurityError: 2, TypeMismatchError: 54,
    InvalidModificationError: 20, NoModificationAllowedError: 10, QuotaExceededError: 51,
  } as Record<string, number>)[error.name] || 29;
  const wasi = (fn: (...args: any[]) => number) => (...args: any[]) => { try { return fn(...args); } catch (error) { if (error instanceof ProcessExit) throw error; return errno(error); } };
  const syscall = (fn: (...args: any[]) => number) => (...args: any[]) => { try { return fn(...args); } catch (error) { if (error instanceof ProcessExit) throw error; return -errno(error); } };
  const stat = (path: string) => {
    const item = io.request<any>('stat', path); if (!item) throw { errno: 44 }; return item;
  };
  const open = (path: string, flags: number): number => {
    const metadata = io.request<any>('stat', path);
    if (!metadata && !(flags & 64)) throw { errno: 44 };
    if ((flags & 512) && !(flags & 3)) throw { errno: 8 };
    const directory = metadata?.kind === 'directory';
    if (directory && (flags & 3)) throw { errno: 31 };
    if ((flags & 65536) && !directory) throw { errno: 54 };
    if (metadata && (flags & 64) && (flags & 128)) throw { errno: 20 };
    if (!directory) io.request('open', path, { flags });
    const number = nextFd++; descriptors.set(number, { path, flags, position: 0, directory }); return number;
  };
  const close = (number: number) => {
    if (number <= 2) return 0;
    const item = fd(number);
    if (!item.directory) io.request('close', item.path);
    descriptors.delete(number); return 0;
  };
  const write = (number: number, ptr: number, length: number): number => {
    const bytes = heap().subarray(ptr, ptr + length);
    if (number === 1 || number === 2) { output(number, bytes); return length; }
    const item = fd(number);
    if (item.directory || !(item.flags & 3)) throw { errno: 8 };
    // A structured-cloned subarray would copy the entire WASM backing memory.
    const result = io.request<any>('writeAt', item.path, { position: item.position, bytes: bytes.slice(), append: !!(item.flags & 1024) });
    item.position = result.position; return length;
  };
  const read = (number: number, ptr: number, length: number): number => {
    if (!length) return 0;
    if (number === 0) {
      const byte = stdin(); if (byte < 0) return 0;
      heap()[ptr] = byte; return 1;
    }
    const item = fd(number);
    if (item.directory || (item.flags & 3) === 1) throw { errno: 8 };
    const bytes = io.request<Uint8Array>('readAt', item.path, { position: item.position, length });
    heap().set(bytes, ptr); item.position += bytes.length; return bytes.length;
  };
  const seek = (number: number, offset: number | bigint, whence: number): number => {
    const item = fd(number);
    let position = Number(offset);
    if (whence === 1) position += item.position;
    else if (whence === 2) {
      // The native backend includes uncommitted append/truncate state.
      position += io.request<any>('stat', item.path).size;
    } else if (whence !== 0) throw { errno: 28 };
    if (!Number.isSafeInteger(position) || position < 0) throw { errno: 28 };
    return item.position = position;
  };
  const sync = (number: number) => { if (number > 2) io.request('sync', fd(number).path); return 0; };
  const truncate = (number: number, size: number | bigint) => {
    const item = fd(number); if (item.directory || !(item.flags & 3)) throw { errno: 8 };
    io.request('truncate', item.path, { size: Number(size) }); return 0;
  };
  const filestat = (path: string, ptr: number) => {
    const item = stat(path), v = view();
    heap().fill(0, ptr, ptr + 64);
    v.setUint8(ptr + 16, item.kind === 'directory' ? 3 : 4);
    v.setBigUint64(ptr + 24, 1n, true); v.setBigUint64(ptr + 32, BigInt(item.size), true);
    const ns = BigInt(item.lastModified) * 1000000n;
    for (const offset of [40, 48, 56]) v.setBigUint64(ptr + offset, ns, true);
    return 0;
  };
  const stat64 = (path: string | null, ptr: number) => {
    const item = path === null ? { kind: 'character', size: 0, lastModified: Date.now() } : stat(path);
    const v = view(); heap().fill(0, ptr, ptr + 96);
    v.setUint32(ptr + 12, item.kind === 'directory' ? 0o40755 : item.kind === 'character' ? 0o20666 : 0o100644, true);
    v.setUint32(ptr + 16, 1, true);
    v.setBigInt64(ptr + 40, BigInt(item.size), true);
    v.setUint32(ptr + 48, 4096, true); v.setUint32(ptr + 52, Math.ceil(item.size / 512), true);
    const seconds = Math.floor(item.lastModified / 1000);
    for (const offset of [56, 64, 72]) v.setUint32(ptr + offset, seconds, true);
    v.setBigUint64(ptr + 80, 1n, true); return 0;
  };
  const argv = [program, ...args].map((arg) => encoder.encode(arg + '\0'));
  let exiting = false;
  const shutdown = () => {
    if (exiting) return;
    exiting = true;
    (instance.exports.__funcs_on_exit as Function)?.();
    (instance.exports.__wasm_call_dtors as Function)?.();
    (instance.exports.fflush as Function)?.(0);
  };
  const imports: Record<string, any> = {
    proc_exit: (code: number) => { throw new ProcessExit(code); },
    fd_write: wasi((number, iovs, count, written) => {
      let total = 0; for (let i = 0; i < count; i++) total += write(number, view().getUint32(iovs + i * 8, true), view().getUint32(iovs + i * 8 + 4, true));
      view().setUint32(written, total, true); return 0;
    }),
    fd_read: wasi((number, iovs, count, readPtr) => {
      let total = 0;
      for (let i = 0; i < count; i++) {
        const length = view().getUint32(iovs + i * 8 + 4, true);
        const n = read(number, view().getUint32(iovs + i * 8, true), length); total += n;
        if (n < length) break;
      }
      view().setUint32(readPtr, total, true); return 0;
    }),
    fd_close: wasi(close),
    fd_seek: wasi((number, offset, whence, result) => { view().setBigUint64(result, BigInt(seek(number, offset, whence)), true); return 0; }),
    fd_tell: wasi((number, result) => { view().setBigUint64(result, BigInt(fd(number).position), true); return 0; }),
    fd_sync: wasi(sync), fd_datasync: wasi(sync),
    fd_fdstat_get: wasi((number, ptr) => {
      heap().fill(0, ptr, ptr + 24); const item = number > 2 ? fd(number) : null;
      view().setUint8(ptr, item?.directory ? 3 : item ? 4 : 2);
      view().setBigUint64(ptr + 8, 0x1fffffffn, true); view().setBigUint64(ptr + 16, 0x1fffffffn, true); return 0;
    }),
    fd_fdstat_set_flags: wasi((number, flags) => { fd(number).flags = (fd(number).flags & ~1024) | ((flags & 1) ? 1024 : 0); return 0; }),
    fd_prestat_get: wasi((number, ptr) => { if (number !== 3) throw { errno: 8 }; view().setUint32(ptr, 0, true); view().setUint32(ptr + 4, 1, true); return 0; }),
    fd_prestat_dir_name: wasi((number, ptr) => { if (number !== 3) throw { errno: 8 }; heap()[ptr] = 46; return 0; }),
    fd_filestat_get: wasi((number, ptr) => filestat(fd(number).path, ptr)),
    fd_filestat_set_size: wasi(truncate),
    path_open: wasi((dir, _lookup, ptr, length, oflags, rights, _inherit, fdflags, result) => {
      const canWrite = !!(BigInt(rights) & 64n), canRead = !!(BigInt(rights) & 2n);
      const flags = (canWrite ? canRead ? 2 : 1 : 0) | ((oflags & 1) ? 64 : 0) | ((oflags & 4) ? 128 : 0) | ((oflags & 8) ? 512 : 0) | ((oflags & 2) ? 65536 : 0) | ((fdflags & 1) ? 1024 : 0);
      view().setUint32(result, open(relative(dir, string(ptr, length)), flags), true); return 0;
    }),
    path_filestat_get: wasi((dir, _flags, ptr, length, result) => filestat(relative(dir, string(ptr, length)), result)),
    path_create_directory: wasi((dir, ptr, length) => { io.request('mkdir', relative(dir, string(ptr, length)), { exclusive: true }); return 0; }),
    path_unlink_file: wasi((dir, ptr, length) => { io.request('unlink', relative(dir, string(ptr, length))); return 0; }),
    path_remove_directory: wasi((dir, ptr, length) => { io.request('rmdir', relative(dir, string(ptr, length))); return 0; }),
    args_sizes_get: (count: number, size: number) => { view().setUint32(count, argv.length, true); view().setUint32(size, argv.reduce((n, arg) => n + arg.length, 0), true); return 0; },
    args_get: (ptr: number, buffer: number) => { for (let i = 0; i < argv.length; i++) { view().setUint32(ptr + i * 4, buffer, true); heap().set(argv[i], buffer); buffer += argv[i].length; } return 0; },
    environ_sizes_get: (count: number, size: number) => { view().setUint32(count, 0, true); view().setUint32(size, 0, true); return 0; },
    environ_get: () => 0,
    clock_time_get: (_clock: number, _precision: bigint, ptr: number) => { view().setBigUint64(ptr, BigInt(Date.now()) * 1000000n, true); return 0; },
    random_get: (ptr: number, length: number) => { for (let i = 0; i < length; i += 65536) crypto.getRandomValues(heap().subarray(ptr + i, ptr + Math.min(length, i + 65536))); return 0; },
    sched_yield: () => 0,
  };
  const env: Record<string, any> = {
    exit: (code: number) => { shutdown(); throw new ProcessExit(code); },
    _Exit: (code: number) => { throw new ProcessExit(code); },
    _exit: (code: number) => { throw new ProcessExit(code); },
    __syscall_openat: syscall((dir, path, flags) => open(relative(dir, string(path)), flags)),
    __syscall_stat64: syscall((path, ptr) => stat64(resolve(string(path)), ptr)),
    __syscall_lstat64: syscall((path, ptr) => stat64(resolve(string(path)), ptr)),
    __syscall_fstat64: syscall((number, ptr) => stat64(number <= 2 ? null : fd(number).path, ptr)),
    __syscall_newfstatat: syscall((dir, path, ptr) => stat64(relative(dir, string(path)), ptr)),
    __syscall_unlinkat: syscall((dir, path, flags) => { io.request(flags & 512 ? 'rmdir' : 'unlink', relative(dir, string(path))); return 0; }),
    __syscall_unlink: syscall((path) => { io.request('unlink', resolve(string(path))); return 0; }),
    __syscall_mkdirat: syscall((dir, path) => { io.request('mkdir', relative(dir, string(path)), { exclusive: true }); return 0; }),
    __syscall_rmdir: syscall((path) => { io.request('rmdir', resolve(string(path))); return 0; }),
    __syscall_ftruncate64: syscall(truncate),
    __syscall_fcntl64: syscall((number, command, varargs) => {
      const item = fd(number);
      if (command === 3) return item.flags;
      if (command === 4) { item.flags = (item.flags & ~1024) | (view().getInt32(varargs, true) & 1024); return 0; }
      if (command === 1 || command === 2) return 0;
      throw { errno: 52 };
    }),
    __syscall_ioctl: syscall((number) => { if (number <= 2) return 0; throw { errno: 59 }; }),
    __syscall_getcwd: syscall((ptr, size) => { const bytes = encoder.encode('/workspace' + (cwd ? '/' + cwd : '') + '\0'); if (bytes.length > size) throw { errno: 68 }; heap().set(bytes, ptr); return bytes.length; }),
    __syscall_chdir: syscall((ptr) => { const path = resolve(string(ptr)); if (stat(path).kind !== 'directory') throw { errno: 54 }; cwd = path; return 0; }),
    __syscall_faccessat: syscall((dir, ptr) => { stat(relative(dir, string(ptr))); return 0; }),
    __syscall_readlinkat: () => -28,
    emscripten_date_now: () => Date.now(),
    emscripten_get_now: () => performance.now(),
    emscripten_notify_memory_growth: () => {},
    emscripten_resize_heap: (requested: number) => { try { memory.grow(Math.ceil((requested - memory.buffer.byteLength) / 65536)); return 1; } catch { return 0; } },
    _tzset_js: () => {},
    _abort_js: () => { throw new Error('Program aborted'); },
    abort: () => { throw new Error('Program aborted'); },
  };
  const module = image instanceof WebAssembly.Module ? image : await WebAssembly.compile(image as BufferSource);
  const object: WebAssembly.Imports = {};
  for (const imp of WebAssembly.Module.imports(module)) {
    const group = object[imp.module] ||= {};
    if (imp.kind === 'memory') { memory = new WebAssembly.Memory({ initial: 256, maximum: 32768 }); group[imp.name] = memory; }
    else if (imp.kind === 'table') group[imp.name] = new WebAssembly.Table({ element: 'anyfunc', initial: 0 });
    else {
      const implementation = imp.module.startsWith('wasi_') ? imports[imp.name] : env[imp.name];
      // Never pretend unsupported syscalls succeeded: that silently loses data.
      group[imp.name] = implementation || (imp.module.startsWith('wasi_') ? () => 52 : imp.name.startsWith('__syscall_') ? () => -52 : () => { throw new Error(`Unsupported runtime import: ${imp.module}.${imp.name}`); });
    }
  }
  instance = await WebAssembly.instantiate(module, object);
  memory ||= instance.exports.memory as WebAssembly.Memory;
  let code = 0;
  try {
    (instance.exports.__wasm_call_ctors as Function)?.();
    const start = (instance.exports._start || instance.exports.__main_argc_argv || instance.exports.main) as Function;
    if (!start) throw new Error('WebAssembly entry point missing');
    if (instance.exports._start) code = Number(await start()) || 0;
    else {
      const malloc = instance.exports.malloc as Function;
      if (!malloc && args.length) throw new Error('Missing malloc export for main arguments; rebuild this binary');
      if (!malloc) code = Number(await start(0, 0)) || 0;
      else {
        const ptr = Number(malloc((argv.length + 1) * 4 + argv.reduce((n, arg) => n + arg.length, 0)));
        if (!ptr) throw new Error('Could not allocate program arguments');
        let buffer = ptr + (argv.length + 1) * 4;
        for (let i = 0; i < argv.length; i++) { view().setUint32(ptr + i * 4, buffer, true); heap().set(argv[i], buffer); buffer += argv[i].length; }
        view().setUint32(ptr + argv.length * 4, 0, true);
        code = Number(await start(argv.length, ptr)) || 0;
      }
    }
    shutdown();
  } catch (error) { if (error instanceof ProcessExit) code = error.code; else throw error; }
  finally {
    for (const number of [...descriptors.keys()]) if (number > 3) close(number);
  }
  return code;
}
