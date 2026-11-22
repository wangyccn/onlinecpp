import { defineConfig } from 'vite';
import path from 'path';
import fs from 'fs';

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

function createAssetMiddleware() {
  return (req: any, res: any, next: any) => {
    const rawUrl = (req.url || '').split('?')[0];
    if (rawUrl.startsWith('/emception-cdn/')) {
      const rel = rawUrl.slice('/emception-cdn/'.length);
      const targetPath = path.resolve(import.meta.dirname, 'node_modules/emception/cdn', rel);
      if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
        serveFile(res, targetPath);
        return;
      }
    } else if (rawUrl.startsWith('/clangd-assets/')) {
      const rel = rawUrl.slice('/clangd-assets/'.length);
      const targetPath = path.resolve(import.meta.dirname, 'node_modules/@algoproclub/clangd-wasm/assets', rel);
      if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
        serveFile(res, targetPath);
        return;
      }
    }
    next();
  };
}

function serveFile(res: any, filePath: string) {
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
  fs.createReadStream(filePath).pipe(res);
}
