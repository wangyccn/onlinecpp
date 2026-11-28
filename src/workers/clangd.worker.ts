// Keep the broker in Vite's worker graph in development as well as production,
// but load it only once the language-service assets are available locally.
import { installClangdAssetFetchInterceptor, installClangdAssetUrls } from '../services/clangdAssets';

type ConnectEvent = { ports: MessagePort[] };

const queued: MessagePort[] = [];
let forward: ((event: ConnectEvent) => void) | null = null;

// Register synchronously: a SharedWorker that installs `onconnect` after an await
// would drop the port the page already created.
(self as unknown as { onconnect: ((event: ConnectEvent) => void) | null }).onconnect = (event) => {
  const port = event.ports[0];
  if (forward) forward({ ports: [port] });
  else queued.push(port);
};

void (async () => {
  try {
    // Serve clangd's own asset requests from Cache Storage: no network on startup.
    const intercepted = await installClangdAssetFetchInterceptor();
    // Blob URLs are a second route for bundles that resolve asset URLs up front.
    if (!intercepted) await installClangdAssetUrls();
  } catch (error) {
    console.warn('[clangd] cached assets unavailable, falling back to network URLs', error);
  }
  try {
    await import('@clangd-broker');
  } catch (error) {
    console.error('[clangd] language service failed to load', error);
    for (const port of queued.splice(0)) {
      try { port.postMessage({ type: 'algopro/clangd-error', message: 'clangd 语言服务加载失败：' + String((error as Error)?.message || error) }); }
      catch { /* port already gone */ }
    }
    return;
  }
  // The broker installed its own onconnect; reuse it for ports that arrived early.
  forward = (self as unknown as { onconnect: (event: ConnectEvent) => void }).onconnect;
  for (const port of queued.splice(0)) forward({ ports: [port] });
})();
