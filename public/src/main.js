import { App } from './app.js';

const app = new App();
window.geocentricSafari = app; // handy for debugging from the console
app.start();

// The site no longer uses an offline service worker. Remove any left over from an earlier release
// (and its cache) so every visit gets the current code straight from the server.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => r.unregister())).catch(() => {});
}
if ('caches' in window) {
  caches.keys().then((keys) => keys.filter((k) => k.startsWith('gs3d-')).forEach((k) => caches.delete(k))).catch(() => {});
}
