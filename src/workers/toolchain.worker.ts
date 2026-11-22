import { OverlayFS } from 'emception';
import { LazyFS } from '@emception-runtime/vfs/lazy.js';
import { IDBFS } from '@emception-runtime/vfs/idb.js';
import { createVFSManager } from '@emception-runtime/vfs/index.js';
import { ToolRunner } from '@emception-runtime/tool-runner.js';
import { parseManifest } from '@emception-runtime/manifest.js';
import { NativeMount, SyncNativeIO } from '../services/nativeMount';

let runner: ToolRunner;
let native: NativeMount;
let overlay: OverlayFS;
let booted: Promise<void> | undefined;

async function installBrotli(base: string): Promise<void> {
  // Match the upstream worker's fallback: static hosts need not set Content-Encoding.
  const [glue, wasm] = await Promise.all([fetch(base + '/brotli_wasm.js'), fetch(base + '/brotli_wasm.wasm')]);
  if (!glue.ok || !wasm.ok) throw new Error('Could not load the toolchain Brotli decoder');
  const url = URL.createObjectURL(new Blob([await glue.text()], { type: 'application/javascript' }));
  try {
    const factory = (await import(/* @vite-ignore */ url)).default;
    const module = await factory({ wasmBinary: await wasm.arrayBuffer(), locateFile: (path: string) => base + '/' + path });
    const decompress = module.cwrap('brotli_decompress_buffer', 'number', ['number', 'number', 'number']);
    const free = module.cwrap('brotli_free_buffer', null, ['number']);
    const lastError = module.cwrap('brotli_get_last_error_message', 'string', []);
    LazyFS.customBrotliDecompressor = (bytes) => {
      const input = module._malloc(Math.max(1, bytes.length)), length = module._malloc(4);
      let output = 0;
      try {
        module.HEAPU8.set(bytes, input); module.HEAPU32[length >>> 2] = 0;
        output = decompress(input, bytes.length, length);
        if (!output) throw new Error(lastError() || 'Brotli decode failed');
        return module.HEAPU8.slice(output, output + module.HEAPU32[length >>> 2]);
      } finally { if (output) free(output); module._free(length); module._free(input); }
    };
  } finally { URL.revokeObjectURL(url); }
}

async function boot(manifestUrl: string, port: MessagePort, libraries: string[]): Promise<void> {
  const response = await fetch(manifestUrl);
  if (!response.ok) throw new Error(`Toolchain manifest: HTTP ${response.status}`);
  const manifest = parseManifest(await response.json());
  const base = manifestUrl.slice(0, manifestUrl.lastIndexOf('/'));
  manifest.baseUrl = base;
  await installBrotli(base);
  for (const bundle of Object.values(manifest.bundles || {})) {
    if (!bundle.url.startsWith('http')) bundle.url = base + bundle.url.replace(/^\/cdn/, '');
  }
  const lazy = new LazyFS(manifest);
  // Headers are read-only toolchain assets. Project files and outputs use the separate write-back IO Worker, never these volatile mounts.
  const memory = new IDBFS('onlinecpp-process-memory', { volatile: true });
  const temp = new IDBFS('onlinecpp-scratch', { volatile: true });
  await Promise.all([lazy.init(), memory.init(), temp.init()]);
  overlay = new OverlayFS(lazy, memory);
  native = new NativeMount(new SyncNativeIO(port));
  overlay.mount('/home/user', native);
  overlay.mount('/tmp', temp);
  memory.mkdirSync('/home');
  overlay.mkdirSync('/tmp');
  const vfs = createVFSManager(overlay, lazy);
  // The IDE has a fixed, explicit link line. Do not warm every pthread/debug/libc++
  // variant on every link (hundreds of MB that this program will never use).
  const libraryPaths = new Set<string>(), libraryBundles = new Set<string>();
  for (const flag of libraries) {
    let path = '/usr/lib/emscripten/cache-lib/wasm32-emscripten/lib' + flag.slice(2) + '.a';
    for (let i = 0; i < 10 && manifest.files[path]; i++) {
      libraryPaths.add(path);
      const entry = manifest.files[path];
      if ('symlink' in entry && entry.symlink) path = entry.symlink;
      else { if ('bundle' in entry && entry.bundle) libraryBundles.add(entry.bundle); break; }
    }
  }
  const preload = vfs.preloadBundle.bind(vfs), bundlePaths = vfs.getBundleFilePaths.bind(vfs);
  vfs.preloadBundle = (name) => name.startsWith('cache-') && !libraryBundles.has(name) ? Promise.resolve() : preload(name);
  vfs.getBundleFilePaths = (name) => name.startsWith('cache-') ? bundlePaths(name).filter((path) => libraryPaths.has(path)) : bundlePaths(name);
  const fetchFile = vfs.fetchFile.bind(vfs);
  // Keep warmed system headers/libraries in RAM across invocations instead of re-reading IDB.
  const cache = new Map<string, Uint8Array>();
  let size = 0;
  vfs.fetchFile = async (path) => {
    if (cache.has(path)) return cache.get(path)!;
    const data = await fetchFile(path);
    if (data && path.startsWith('/usr/') && size + data.length <= 192 * 1024 * 1024) {
      cache.set(path, data); size += data.length;
    }
    return data;
  };
  runner = new ToolRunner(vfs, manifest.toolVersions);
}

self.onmessage = async ({ data }) => {
  const { id, op } = data;
  try {
    let value: any;
    if (op === 'boot') { booted = boot(data.manifestUrl, data.port, data.libraries); await booted; }
    else {
      await booted;
      if (op === 'writeSupport') {
        for (const [path, text] of Object.entries(data.files)) overlay.writeFileSync(path, new TextEncoder().encode(text as string));
      } else if (op === 'setInputs') { native.setInputs(data.files); }
      else if (op === 'run') {
        native.begin();
        self.postMessage({ type: 'output', text: `\x1b[90m[Toolchain] ${data.tool}\x1b[0m\r\n` });
        const out = (stream: string) => (text: string) => self.postMessage({ type: 'output', id, stream, text });
        try {
          value = await runner.run(data.tool, data.argv, { cwd: '/home/user', onStdout: out('stdout'), onStderr: out('stderr') });
          if (data.tool === 'clang' && value.exitCode === 0) Object.assign(value, native.captureInputs());
          // Pull declared outputs straight out of the mount's write buffer: this saves a
          // full write + read + delete round trip through the IO worker for every object,
          // depfile and linked binary.
          if (value && Array.isArray(data.capture) && data.capture.length) {
            const files: Record<string, Uint8Array> = {};
            for (const path of data.capture as string[]) {
              const bytes = native.extract(path);
              if (bytes) files[path] = bytes;
            }
            if (Object.keys(files).length) value.files = files;
          }
        }
        finally { native.flush(); }
      } else throw new Error(`Unknown toolchain request: ${op}`);
    }
    self.postMessage({ id, value });
  } catch (error: any) { self.postMessage({ id, error: { name: error.name, message: error.message } }); }
};
