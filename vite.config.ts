import { defineConfig } from 'vite';
import path from 'path';
import fs from 'fs';

let outDir = 'dist';

export default defineConfig({
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5173,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Access-Control-Allow-Origin': '*',
    },
    fs: {
      allow: ['..'],
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Access-Control-Allow-Origin': '*',
    },
  },
  optimizeDeps: {
    include: ['@algoproclub/clangd-wasm > vscode-jsonrpc/lib/common/messages.js'],
    exclude: [
      '@gameguild/emception-browser',
      '@gameguild/emception-xterm',
      'emception',
      '@algoproclub/clangd-wasm',
      '@emception-runtime/vfs/lazy.js',
      '@emception-runtime/vfs/idb.js',
      '@emception-runtime/vfs/index.js',
      '@emception-runtime/tool-runner.js',
      '@emception-runtime/manifest.js',
    ],
  },
  resolve: {
    alias: [
      { find: '@clangd-broker', replacement: path.resolve(import.meta.dirname, 'node_modules/@algoproclub/clangd-wasm/lib/clangd.shared-worker.js') },
      // Worker-safe runtime modules; the package root also imports DOM/xterm boot code.
      { find: '@emception-runtime', replacement: path.resolve(import.meta.dirname, 'node_modules/@gameguild/emception-browser/dist') },
      {
        find: /@gameguild\/emception-browser\/dist\/worker-entry$/,
        replacement: path.resolve(import.meta.dirname, 'node_modules/@gameguild/emception-browser/dist/worker-entry.js'),
      },
    ],
  },
  plugins: [
    {
      name: 'clangd-worker-entry',
      enforce: 'pre',
      transform(code, id) {
        if (!id.replace(/\\/g, '/').endsWith('/@algoproclub/clangd-wasm/lib/browser.js')) return;
        const constructor = 'new URL("./clangd.shared-worker.js", import.meta.url)';
        if (!code.includes(constructor)) throw new Error('clangd worker entry changed; update the Vite integration');
        return 'import clangdWorkerUrl from "/src/workers/clangd.worker.ts?sharedworker&url";\n' + code.replace(constructor, 'clangdWorkerUrl').replace('name: "algopro-clangd"', 'name: "onlinecpp-clangd"');
      },
    },
    {
      name: 'monaco-language-filter',
      enforce: 'pre',
      resolveId(id) {
        const cleanId = id.replace(/\\/g, '/');
        // Eliminate all unneeded Monaco language highlighters (Java, PHP, Python, Rust, SQL, etc.)
        // Keep ONLY C/C++ (cpp)
        if (cleanId.includes('/languages/definitions/') && !cleanId.includes('/languages/definitions/cpp/')) {
          return '\0virtual:empty-monaco-language';
        }
        if (cleanId.includes('/languages/features/')) {
          return '\0virtual:empty-monaco-language';
        }
        if (cleanId.includes('/basic-languages/') && !cleanId.includes('/basic-languages/cpp/')) {
          return '\0virtual:empty-monaco-language';
        }
        return null;
      },
      load(id) {
        if (id === '\0virtual:empty-monaco-language') {
          return 'export default {}; export const typescriptDefaults = {}; export const javascriptDefaults = {}; export const cssDefaults = {}; export const htmlDefaults = {}; export const jsonDefaults = {}; export const registerLanguage = () => {};';
        }
        return null;
      },
    },
    {
      name: 'clangd-asset-manifest',
      enforce: 'pre',
      // Emit a manifest of the hashed clangd artifacts and let the shared worker take
      // its asset URLs from Cache Storage (see src/services/clangdAssets.ts).
      transform(code, id) {
        const cleanId = id.replace(/\\/g, '/').split('?')[0];
        if (!cleanId.endsWith('/@algoproclub/clangd-wasm/lib/clangd.shared-worker.js')) return;
        const redirects: Array<[string, string, string]> = [
          ['dataUrl', '../assets/headers.data', 'data'],
          ['indexUrl', '../assets/system.index', 'index'],
          ['wasmUrl', '../assets/clangd.wasm', 'wasm'],
        ];
        let next = code;
        for (const [field, file, kind] of redirects) {
          const original = `${field}: new URL("${file}", import.meta.url).href`;
          // Optional: the fetch interceptor in clangdAssets.ts is the primary route, so a
          // changed upstream shape must not break the build.
          if (!next.includes(original)) continue;
          next = next.replace(original, `${field}: __onlinecppClangdResolve("${kind}", new URL("${file}", import.meta.url).href)`);
        }
        if (next === code) return;
        const helper = 'const __onlinecppClangdResolve = (kind, fallback) => (typeof globalThis.__onlinecppClangdAsset === "function" && globalThis.__onlinecppClangdAsset(kind)) || fallback;\n';
        return helper + next;
      },
      configResolved(config) {
        outDir = path.resolve(config.root, config.build.outDir);
      },
      // Written after the bundle lands on disk: the hashed file names are only final then,
      // and a cached rebuild may not re-run generateBundle for emitted assets.
      closeBundle() {
        try {
          const assetsDir = path.join(outDir, 'assets');
          if (!fs.existsSync(assetsDir)) return;
          const manifest: Record<string, string> = {};
          for (const base of fs.readdirSync(assetsDir)) {
            if (/^clangd-[\w-]*\.wasm$/.test(base)) manifest.wasm = `assets/${base}`;
            else if (/^headers-[\w-]*\.data$/.test(base)) manifest.data = `assets/${base}`;
            else if (/^system-[\w-]*\.index$/.test(base)) manifest.index = `assets/${base}`;
          }
          fs.writeFileSync(path.join(outDir, 'onlinecpp-clangd-assets.json'), JSON.stringify(manifest, null, 2));
        } catch (error) {
          console.warn('[clangd-asset-manifest] could not write manifest:', error);
        }
      },
      configureServer(server) {
        server.middlewares.use(serveClangdManifest);
      },
      configurePreviewServer(server) {
        server.middlewares.use(serveClangdManifest);
      },
    },
    {
      name: 'local-assets-server',
      configureServer(server) {
        server.middlewares.use(createAssetMiddleware());
      },
      configurePreviewServer(server) {
        server.middlewares.use(createAssetMiddleware());
      },
    },
  ],
  worker: {
    format: 'es',
  },
});

/** Dev/preview mirror of the build-time manifest, so the parallel downloader works locally too. */
function serveClangdManifest(req: any, res: any, next: any) {
  const rawUrl = (req.url || '').split('?')[0];
  if (rawUrl !== '/onlinecpp-clangd-assets.json') { next(); return; }
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({
    wasm: '/clangd-assets/clangd.wasm',
    data: '/clangd-assets/headers.data',
    index: '/clangd-assets/system.index',
  }));
}

function createAssetMiddleware() {
  return (req: any, res: any, next: any) => {
    const rawUrl = (req.url || '').split('?')[0];
    if (rawUrl.startsWith('/emception-cdn/')) {
      const rel = rawUrl.slice('/emception-cdn/'.length);
      const targetPath = path.resolve(import.meta.dirname, 'node_modules/emception/cdn', rel);
      if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
        serveFile(req, res, targetPath);
        return;
      }
    } else if (rawUrl.startsWith('/clangd-assets/')) {
      const rel = rawUrl.slice('/clangd-assets/'.length);
      const targetPath = path.resolve(import.meta.dirname, 'node_modules/@algoproclub/clangd-wasm/assets', rel);
      if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
        serveFile(req, res, targetPath);
        return;
      }
    }
    next();
  };
}

function serveFile(req: any, res: any, filePath: string) {
  const ext = path.extname(filePath);
  if (ext === '.wasm') res.setHeader('Content-Type', 'application/wasm');
  else if (ext === '.json') res.setHeader('Content-Type', 'application/json');
  else if (ext === '.js' || ext === '.mjs') res.setHeader('Content-Type', 'application/javascript');
  else if (ext === '.br' || ext === '.data') res.setHeader('Content-Type', 'application/octet-stream');
  else if (ext === '.css') res.setHeader('Content-Type', 'text/css');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Accept-Ranges', 'bytes');
  // Serve byte ranges so the parallel chunked downloader can be exercised locally.
  const size = fs.statSync(filePath).size;
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req?.headers?.range || '').trim());
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || end < start) {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${size}`);
      res.end();
      return;
    }
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', String(end - start + 1));
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }
  res.setHeader('Content-Length', String(size));
  fs.createReadStream(filePath).pipe(res);
}

