/*! coi-serviceworker v0.1.7 - Guido Zuidhof and contributors, licensed under MIT */
let coepCredentialless = false;
if (typeof window === 'undefined') {
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

  self.addEventListener("message", (ev) => {
    if (!ev.data) {
      return;
    } else if (ev.data.type === "deregister") {
      self.registration
        .unregister()
        .then(() => {
          return self.clients.matchAll();
        })
        .then(clients => {
          clients.forEach(client => client.navigate(client.url));
        });
    } else if (ev.data.type === "coepCredentialless") {
      coepCredentialless = ev.data.value;
    }
  });

  self.addEventListener("fetch", function (event) {
    const r = event.request;
    if (r.cache === "only-if-cached" && r.mode !== "same-origin") {
      return;
    }

    const coep = coepCredentialless ? "credentialless" : "require-corp";

    event.respondWith(
      fetch(r).then((response) => {
        if (response.status === 0) {
          return response;
        }

        const newHeaders = new Headers(response.headers);
        newHeaders.set("Cross-Origin-Embedder-Policy", coep);
        newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders,
        });
      })
    );
  });
} else {
  (() => {
    const reloadedBySelf = window.sessionStorage.getItem("coiReloadedBySelf");
    window.sessionStorage.removeItem("coiReloadedBySelf");

    // If Cross-Origin Isolation is already enabled natively by server headers, do nothing!
    if (window.crossOriginIsolated) return;

    const currentScript = document.currentScript;
    const scriptUrl = currentScript ? currentScript.src : "coi-serviceworker.js";

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register(scriptUrl).then(
        (registration) => {
          registration.addEventListener("updatefound", () => {
            window.location.reload();
          });

          if (registration.active && !navigator.serviceWorker.controller) {
            window.sessionStorage.setItem("coiReloadedBySelf", "true");
            window.location.reload();
          }
        },
        (err) => {
          console.warn("COOP/COEP Service Worker registration note: ", err);
        }
      );
    }
  })();
}
