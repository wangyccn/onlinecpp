/**
 * Clang language-service assets (~76 MB: clangd.wasm, headers.data, system.index).
 *
 * The upstream package asks the browser for each file with a single plain `fetch`,
 * one after another, so a slow single stream to one CDN makes the whole language
 * service crawl. Here the three files are fetched concurrently, every file is split
 * into ranged chunks that run in parallel, the fastest mirror wins a probe race, and
 * the result is kept in Cache Storage so later sessions start instantly.
 *
 * When the network refuses to cooperate at all, `importClangdAssets()` accepts files
 * the user downloaded by hand.
 */

export type ClangdAssetKind = 'wasm' | 'data' | 'index';

export interface ClangdAssetSpec {
  kind: ClangdAssetKind;
  label: string;
  /** File name inside `@algoproclub/clangd-wasm/assets`. */
  file: string;
  /** Nominal size used for progress and for the manual-import sanity check. */
  nominalBytes: number;
  minBytes: number;
  contentType: string;
}

export const CLANGD_ASSETS: ClangdAssetSpec[] = [
  { kind: 'wasm', label: 'clangd.wasm', file: 'clangd.wasm', nominalBytes: 26916224, minBytes: 12 * 1024 * 1024, contentType: 'application/wasm' },
  { kind: 'data', label: 'headers.data', file: 'headers.data', nominalBytes: 44185800, minBytes: 24 * 1024 * 1024, contentType: 'application/octet-stream' },
  { kind: 'index', label: 'system.index', file: 'system.index', nominalBytes: 5365500, minBytes: 1 * 1024 * 1024, contentType: 'application/octet-stream' },
];

export interface ClangdAssetProgress {
  loaded: number;
  total: number;
  bytesPerSecond: number;
  label: string;
  done?: boolean;
}

export interface ClangdAssetManifest { wasm?: string; data?: string; index?: string }
export interface ClangdAssetUrls { wasm: string; data: string; index: string }

const PACKAGE_SCOPE = '@algoproclub/clangd-wasm';
const PACKAGE_VERSION = '0.1.1';
const CACHE_NAME = 'onlinecpp-clangd-assets-v1';
const MANIFEST_PATH = 'onlinecpp-clangd-assets.json';
const CHUNK_BYTES = 8 * 1024 * 1024;
const CHUNK_PARALLEL = 6;
const PROBE_BYTES = 512 * 1024;
const RETRIES = 3;

const cacheKey = (kind: ClangdAssetKind) => new URL(`/__onlinecpp-clangd/${kind}`, location.origin).href;
const specOf = (kind: ClangdAssetKind) => CLANGD_ASSETS.find((spec) => spec.kind === kind)!;

let progressHandler: ((progress: ClangdAssetProgress) => void) | undefined;
let readiness: Promise<ClangdAssetUrls> | null = null;

export function onClangdAssetProgress(handler?: (progress: ClangdAssetProgress) => void): void {
  progressHandler = handler;
}

export class ClangdAssetError extends Error {
  constructor(public readonly kind: ClangdAssetKind | 'all', message: string) {
    super(message);
    this.name = 'ClangdAssetError';
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Files fetched by hand never carry the hashed build name, so recognise them by shape. */
export function detectClangdAssetKind(name: string, head: Uint8Array, size: number): ClangdAssetKind | null {
  const lower = name.toLowerCase();
  if (/\.wasm$/.test(lower) || (head.length >= 4 && head[0] === 0x00 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d)) return 'wasm';
  if (/headers[\w.-]*\.data$/.test(lower)) return 'data';
  if (/system[\w.-]*\.(index|idx|bin)$/.test(lower)) return 'index';
  // Unknown name: fall back to the size windows of the official release.
  if (size >= 24 * 1024 * 1024 && size <= 96 * 1024 * 1024) return 'data';
  if (size >= 1 * 1024 * 1024 && size <= 14 * 1024 * 1024) return 'index';
  return null;
}

function mirrorsFor(spec: ClangdAssetSpec, manifest: ClangdAssetManifest): string[] {
  const urls: string[] = [];
  const built = manifest[spec.kind];
  if (built) { try { urls.push(new URL(built, document.baseURI).href); } catch { /* ignore malformed manifest entry */ } }
  // Same-origin fallback used by dev servers and by manual hosting (see vite.config.ts).
  try { urls.push(new URL(`clangd-assets/${spec.file}`, document.baseURI).href); } catch { /* ignore */ }
  urls.push(`https://cdn.jsdelivr.net/npm/${PACKAGE_SCOPE}@${PACKAGE_VERSION}/assets/${spec.file}`);
  urls.push(`https://unpkg.com/${PACKAGE_SCOPE}@${PACKAGE_VERSION}/assets/${spec.file}`);
  return [...new Set(urls)];
}

async function loadManifest(): Promise<ClangdAssetManifest> {
  try {
    const response = await fetch(new URL(MANIFEST_PATH, document.baseURI), { cache: 'no-cache' });
    if (!response.ok) return {};
    const parsed = await response.json() as ClangdAssetManifest;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

interface ProbeResult { url: string; total: number; ranged: boolean; rate: number }

/** A mirror that never answers must not stall the language service; cap every request. */
function deadline(ms: number, parent?: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  parent?.addEventListener('abort', () => controller.abort(), { once: true });
  return controller.signal;
}

/** A ranged probe doubles as a mirror speed test: the fastest source wins the download. */
async function probe(url: string, signal?: AbortSignal): Promise<ProbeResult | null> {
  const started = performance.now();
  try {
    const response = await fetch(url, { headers: { Range: `bytes=0-${PROBE_BYTES - 1}` }, signal: deadline(8000, signal), cache: 'no-store' });
    if (!response.ok) return null;
    const bytes = await response.arrayBuffer();
    if (!bytes.byteLength) return null;
    const elapsed = Math.max(1, performance.now() - started);
    const encoded = (response.headers.get('content-encoding') || 'identity') !== 'identity';
    const range = response.headers.get('content-range') || '';
    const rangedTotal = Number(range.split('/')[1]) || 0;
    const ranged = response.status === 206 && !encoded && rangedTotal > bytes.byteLength;
    return {
      url,
      total: ranged ? rangedTotal : Number(response.headers.get('content-length')) || bytes.byteLength,
      ranged,
      rate: bytes.byteLength / elapsed,
    };
  } catch { return null; }
}

async function retry<T>(task: () => Promise<T>, attempts: number, signal?: AbortSignal): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    signal?.throwIfAborted();
    try { return await task(); }
    catch (error) { last = error; if (signal?.aborted) break; await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1))); }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

async function downloadStreaming(spec: ClangdAssetSpec, source: ProbeResult, onBytes: (bytes: number) => void, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(source.url, { signal: deadline(300000, signal) });
  if (!response.ok) throw new ClangdAssetError(spec.kind, `${spec.label}: HTTP ${response.status}`);
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    onBytes(bytes.byteLength);
    return new Blob([bytes], { type: spec.contentType });
  }
  const reader = response.body.getReader();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    parts.push(value as Uint8Array<ArrayBuffer>);
    onBytes(value.byteLength);
  }
  return new Blob(parts, { type: spec.contentType });
}

async function downloadRanged(spec: ClangdAssetSpec, source: ProbeResult, onBytes: (bytes: number) => void, signal?: AbortSignal): Promise<Blob> {
  const total = source.total;
  const count = Math.ceil(total / CHUNK_BYTES);
  const parts: Uint8Array<ArrayBuffer>[] = new Array(count);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CHUNK_PARALLEL, count) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= count) return;
      const start = index * CHUNK_BYTES;
      const end = Math.min(total, start + CHUNK_BYTES) - 1;
      const expected = end - start + 1;
      parts[index] = await retry(async () => {
        const response = await fetch(source.url, { headers: { Range: `bytes=${start}-${end}` }, signal: deadline(90000, signal) });
        if (response.status !== 206) throw new Error(`HTTP ${response.status}`);
        if ((response.headers.get('content-encoding') || 'identity') !== 'identity') throw new Error('range was re-encoded');
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength !== expected) throw new Error(`short range (${bytes.byteLength}/${expected})`);
        onBytes(bytes.byteLength);
        return bytes;
      }, RETRIES, signal);
    }
  }));
  return new Blob(parts, { type: spec.contentType });
}

async function readCached(kind: ClangdAssetKind): Promise<Blob | null> {
  try {
    if (typeof caches === 'undefined') return null;
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(cacheKey(kind));
    if (!hit) return null;
    const blob = await hit.blob();
    return blob.size >= specOf(kind).minBytes ? blob : null;
  } catch { return null; }
}

async function writeCached(kind: ClangdAssetKind, blob: Blob): Promise<void> {
  try {
    if (typeof caches === 'undefined') return;
    const cache = await caches.open(CACHE_NAME);
    await cache.put(cacheKey(kind), new Response(blob, {
      headers: { 'Content-Type': specOf(kind).contentType, 'Content-Length': String(blob.size) },
    }));
  } catch { /* quota or private mode: the in-memory copy still works for this session */ }
}

async function downloadAsset(
  spec: ClangdAssetSpec,
  manifest: ClangdAssetManifest,
  onBytes: (bytes: number) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  return downloadFromMirrors(spec, mirrorsFor(spec, manifest), onBytes, signal);
}

/**
 * Race the given mirrors, then download from the fastest ranged one in parallel chunks.
 * Exported so the reassembly logic stays covered by the regression suite.
 */
export async function downloadFromMirrors(
  spec: ClangdAssetSpec,
  urls: string[],
  onBytes: (bytes: number) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  const candidates = await Promise.all(urls.map((url) => probe(url, signal)));
  const ranked = candidates.filter((item): item is ProbeResult => !!item).sort((a, b) => {
    // Prefer ranged sources: only they can use every parallel chunk.
    if (a.ranged !== b.ranged) return a.ranged ? -1 : 1;
    return b.rate - a.rate;
  });
  if (!ranked.length) throw new ClangdAssetError(spec.kind, `${spec.label}: every mirror is unreachable`);
  let lastError: unknown;
  for (const source of ranked) {
    try {
      const blob = source.ranged
        ? await downloadRanged(spec, source, onBytes, signal)
        : await downloadStreaming(spec, source, onBytes, signal);
      if (blob.size < spec.minBytes) throw new ClangdAssetError(spec.kind, `${spec.label}: truncated (${formatBytes(blob.size)})`);
      return blob;
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
      console.warn(`[ClangdAssets] ${spec.label} failed from ${source.url}:`, error);
    }
  }
  throw lastError instanceof Error ? lastError : new ClangdAssetError(spec.kind, `${spec.label}: download failed`);
}

async function run(force: boolean): Promise<ClangdAssetUrls> {
  const manifest = await loadManifest();
  const total = CLANGD_ASSETS.reduce((sum, spec) => sum + spec.nominalBytes, 0);
  const started = performance.now();
  let loaded = 0;
  const report = (label: string) => {
    const elapsed = Math.max(1, performance.now() - started);
    progressHandler?.({ loaded, total, bytesPerSecond: (loaded / elapsed) * 1000, label });
  };
  const blobs = new Map<ClangdAssetKind, Blob>();

  await Promise.all(CLANGD_ASSETS.map(async (spec) => {
    const cached = force ? null : await readCached(spec.kind);
    if (!cached) return;
    blobs.set(spec.kind, cached);
    loaded += spec.nominalBytes;
  }));

  const missing = CLANGD_ASSETS.filter((spec) => !blobs.has(spec.kind));
  if (missing.length) {
    report(`Clang 语言服务：并行下载 ${missing.length} 个文件…`);
    try {
      await Promise.all(missing.map(async (spec) => {
        const blob = await downloadAsset(spec, manifest, (bytes) => {
          loaded += bytes;
          const speed = formatBytes((loaded / Math.max(1, performance.now() - started)) * 1000) + '/s';
          report(`Clang 语言服务 ${formatBytes(loaded)} / ${formatBytes(total)} (${speed}) — ${spec.label}`);
        });
        blobs.set(spec.kind, blob);
        await writeCached(spec.kind, blob);
      }));
    } catch (error) {
      progressHandler?.({ loaded, total, bytesPerSecond: 0, label: (error as Error).message, done: true });
      throw error;
    }
  }

  const urls = { wasm: cacheKey('wasm'), data: cacheKey('data'), index: cacheKey('index') };
  progressHandler?.({
    loaded: total, total, bytesPerSecond: 0, done: true,
    label: missing.length ? `Clang 语言服务就绪（${formatBytes(total)}）` : 'Clang 语言服务：使用本地缓存',
  });
  return urls;
}

/**
 * Downloads (or reuses) every asset. Concurrent callers share one run.
 *
 * The returned promise gives up after `timeoutMs` so a text editor is never blocked
 * behind a stalled download; the run itself keeps going and is reused next time.
 */
export function ensureClangdAssets(options: { force?: boolean; timeoutMs?: number } = {}): Promise<ClangdAssetUrls> {
  if (options.force) readiness = null;
  if (!readiness) readiness = run(!!options.force).catch((error) => { readiness = null; throw error; });
  const pending = readiness, timeoutMs = options.timeoutMs ?? 180000;
  return new Promise<ClangdAssetUrls>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ClangdAssetError('all',
      'Clang 资源下载超时：请检查网络，或点击状态栏 clangd 手动导入已下载的文件')), timeoutMs);
    pending.then(
      (urls) => { clearTimeout(timer); resolve(urls); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** True when every asset is already cached locally (no network round trip). */
export async function hasCachedClangdAssets(): Promise<Record<ClangdAssetKind, boolean>> {
  const entries = await Promise.all(CLANGD_ASSETS.map(async (spec) => [spec.kind, !!(await readCached(spec.kind))] as const));
  return Object.fromEntries(entries) as Record<ClangdAssetKind, boolean>;
}

export async function clearClangdAssetCache(): Promise<void> {
  readiness = null;
  try { if (typeof caches !== 'undefined') await caches.delete(CACHE_NAME); } catch { /* ignore */ }
}

async function save(blob: Blob, kind: ClangdAssetKind): Promise<void> {
  const spec = specOf(kind);
  if (blob.size < spec.minBytes) {
    throw new ClangdAssetError(kind, `${spec.label}: 文件过小（${formatBytes(blob.size)}），不是有效的 ${spec.label}`);
  }
  await writeCached(kind, blob);
  readiness = null;
}

/** Manual fallback: import files the user downloaded with the browser. */
export async function importClangdAsset(file: File): Promise<ClangdAssetKind> {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const kind = detectClangdAssetKind(file.name, head, file.size);
  if (!kind) throw new ClangdAssetError('all', `${file.name}: 无法识别，需要 clangd.wasm / headers.data / system.index`);
  if (kind === 'wasm' && !(head[0] === 0x00 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d)) {
    throw new ClangdAssetError('wasm', `${file.name}: 不是有效的 WebAssembly 文件`);
  }
  await save(file, kind);
  return kind;
}

export async function importClangdAssets(files: Iterable<File>): Promise<{ imported: ClangdAssetKind[]; failed: string[] }> {
  const imported: ClangdAssetKind[] = [];
  const failed: string[] = [];
  for (const file of files) {
    try { imported.push(await importClangdAsset(file)); }
    catch (error) { failed.push(`${file.name}: ${(error as Error).message}`); }
  }
  return { imported, failed };
}

/**
 * Worker side: hand the shared worker blob URLs backed by Cache Storage, so clangd
 * never touches the network. Returns false when the cache is incomplete.
 */
export async function installClangdAssetUrls(): Promise<boolean> {
  const urls: Partial<Record<ClangdAssetKind, string>> = {};
  for (const spec of CLANGD_ASSETS) {
    const blob = await readCached(spec.kind);
    if (!blob) continue;
    urls[spec.kind] = URL.createObjectURL(blob.slice(0, blob.size, spec.contentType));
  }
  if (!urls.wasm || !urls.data || !urls.index) return false;
  (globalThis as any).__onlinecppClangdAsset = (kind: ClangdAssetKind) => urls[kind] ?? null;
  return true;
}

/** Recognise a clangd asset by its file name, hashed or not (`clangd-BNLtU7oc.wasm`). */
function classifyAssetUrl(url: string): ClangdAssetKind | null {
  const path = url.split('?')[0].split('#')[0];
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (/clangd[\w.-]*\.wasm$/i.test(base)) return 'wasm';
  if (/headers[\w.-]*\.data$/i.test(base)) return 'data';
  if (/system[\w.-]*\.(index|idx)$/i.test(base)) return 'index';
  return null;
}

/**
 * Answer clangd's own asset requests from Cache Storage.
 *
 * The shared worker asks for its files through plain `fetch`, so intercepting here
 * removes the network from the startup path entirely — no hashed URL has to be known.
 */
export async function installClangdAssetFetchInterceptor(): Promise<boolean> {
  const blobs: Partial<Record<ClangdAssetKind, Blob>> = {};
  await Promise.all(CLANGD_ASSETS.map(async (spec) => {
    const blob = await readCached(spec.kind);
    if (blob) blobs[spec.kind] = blob;
  }));
  if (!blobs.wasm || !blobs.data || !blobs.index) return false;
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const kind = classifyAssetUrl(url);
    const blob = kind ? blobs[kind] : undefined;
    if (!kind || !blob) return nativeFetch(input as RequestInfo, init);
    return Promise.resolve(new Response(blob, {
      status: 200,
      headers: {
        'Content-Type': specOf(kind).contentType,
        'Content-Length': String(blob.size),
        'Accept-Ranges': 'bytes',
      },
    }));
  }) as typeof fetch;
  return true;
}

/** Download links shown in the manual-import dialog. */
export function clangdAssetDownloadLinks(spec: ClangdAssetSpec): Array<{ label: string; url: string }> {
  return [
    { label: 'jsDelivr (CDN)', url: `https://cdn.jsdelivr.net/npm/${PACKAGE_SCOPE}@${PACKAGE_VERSION}/assets/${spec.file}` },
    { label: 'unpkg (CDN)', url: `https://unpkg.com/${PACKAGE_SCOPE}@${PACKAGE_VERSION}/assets/${spec.file}` },
  ];
}
