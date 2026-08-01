import { MANAGE_CLIENT } from './manage-client.js';
import { manageSecurityHeaders } from './security.js';

const MANAGE_STYLES = `:root {
  color-scheme: light;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #111827;
  background: #f3f4f6;
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: #e5e7eb; }
button, input, select, textarea { font: inherit; }
button { min-height: 44px; border: 0; border-radius: 10px; padding: 0 16px; background: #111827; color: #fff; font-weight: 700; cursor: pointer; }
button:disabled { opacity: .5; }
button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 3px solid #93c5fd; outline-offset: 2px; }
label { display: grid; gap: 6px; font-size: 13px; font-weight: 700; color: #374151; }
input, select, textarea { width: 100%; min-height: 44px; border: 1px solid #d1d5db; border-radius: 10px; padding: 0 12px; background: #fff; color: #111827; }
textarea { padding-top: 10px; resize: vertical; }
#app { width: min(100%, 560px); min-height: 100vh; margin: 0 auto; padding: max(20px, env(safe-area-inset-top)) 16px 92px; background: #f9fafb; }
.auth-card { display: grid; gap: 16px; margin-top: 12vh; }
.eyebrow { margin: 0; color: #6b7280; font-size: 12px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
h1, h2, p { margin-top: 0; }
.app-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding-bottom: 16px; }
.app-header h1 { margin: 2px 0 0; font-size: 24px; }
.account { max-width: 42%; overflow: hidden; color: #6b7280; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.secondary { background: #e5e7eb; color: #111827; }
.danger { background: #b91c1c; }
.text-button { min-height: 40px; margin-bottom: 12px; padding: 0; background: transparent; color: #374151; }
.offline { margin-bottom: 12px; border: 1px solid #f59e0b; border-radius: 10px; padding: 10px 12px; background: #fffbeb; color: #92400e; font-weight: 700; }
.offline[hidden] { display: none; }
.app-message { min-height: 20px; margin-bottom: 8px; color: #1d4ed8; font-size: 13px; }
.section-heading, .task-card-top, .claim-actions, .approval-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.section-heading h2 { margin-bottom: 0; }
.section-heading > span { color: #6b7280; font-size: 13px; }
.filters { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; margin: 16px 0; }
.filters label { align-self: end; }
.task-list { display: grid; gap: 12px; }
.task-card, .detail-card, .more-panel, .empty-state { border: 1px solid #e5e7eb; border-radius: 14px; padding: 16px; background: #fff; }
.task-card h3 { margin: 16px 0 6px; }
.task-card p { margin-bottom: 8px; }
.task-card button { width: 100%; margin-top: 8px; }
.type-badge { border-radius: 999px; padding: 5px 9px; background: #e0f2fe; color: #075985; font-size: 12px; font-weight: 800; }
.urgency { color: #9a3412; font-size: 12px; font-weight: 800; }
.meta, .muted { color: #6b7280; font-size: 13px; }
.detail-card h2 { margin: 18px 0 8px; }
.detail-card section { margin-top: 24px; }
.claim-status { margin: 16px 0 6px; font-weight: 700; }
.decision-status { color: #4b5563; }
.claim-actions { justify-content: flex-start; }
.facts { display: grid; gap: 10px; margin: 0; }
.facts div { display: grid; grid-template-columns: minmax(90px, 1fr) 2fr; gap: 12px; border-bottom: 1px solid #f3f4f6; padding-bottom: 10px; }
.facts dt { color: #6b7280; }
.facts dd { margin: 0; overflow-wrap: anywhere; text-align: right; }
.empty-copy { margin-bottom: 0; color: #6b7280; }
.timeline { display: grid; gap: 12px; margin: 0; padding-left: 22px; }
.timeline li { padding-left: 4px; }
.timeline strong, .timeline span { display: block; overflow-wrap: anywhere; }
.timeline span { margin-top: 3px; color: #6b7280; font-size: 13px; }
.approval-actions { margin-top: 24px; }
.approval-actions button { flex: 1; }
.confirm-panel { display: grid; gap: 10px; margin-top: 16px; border-top: 1px solid #e5e7eb; padding-top: 16px; }
.confirm-panel p { margin-bottom: 0; font-weight: 700; }
.error { min-height: 18px; margin: 0; color: #b91c1c; font-size: 13px; }
.payroll-filter { grid-template-columns: 1fr; }
.payroll-dossier > button { width: 100%; margin-top: 16px; }
.attempt-history { display: grid; gap: 12px; }
.attempt-card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 12px; background: #f9fafb; }
.attempt-card p { margin: 10px 0 0; font-size: 13px; }
.proof-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 12px; }
.proof-card { margin: 0; overflow: hidden; border: 1px solid #e5e7eb; border-radius: 10px; background: #fff; }
.proof-card img { display: block; width: 100%; aspect-ratio: 1; object-fit: cover; }
.proof-card figcaption { padding: 8px; color: #4b5563; font-size: 12px; overflow-wrap: anywhere; }
.proof-card button { width: calc(100% - 16px); margin: 0 8px 8px; }
.payment-qr { width: min(220px, 100%); margin: 14px auto 0; }
.payment-form { display: grid; gap: 16px; border-top: 2px solid #111827; padding-top: 20px; }
.payment-form > h3, .payment-form > p { margin-bottom: 0; }
.payment-method { display: grid; gap: 8px; border: 1px solid #d1d5db; border-radius: 12px; padding: 12px; }
.upload-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.file-action { display: flex; min-height: 44px; align-items: center; justify-content: center; border-radius: 10px; padding: 8px; background: #e5e7eb; color: #111827; text-align: center; cursor: pointer; }
.file-input { position: absolute; width: 1px; height: 1px; min-height: 0; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }
.upload-list { display: grid; gap: 8px; }
.upload-item { display: grid; gap: 6px; border-radius: 8px; padding: 8px; background: #f3f4f6; font-size: 12px; overflow-wrap: anywhere; }
.payment-summary { margin-top: 0; }
.payment-summary dd { font-variant-numeric: tabular-nums; }
.empty-state { padding: 40px 20px; text-align: center; }
.bottom-nav { position: fixed; right: 0; bottom: 0; left: 0; display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; width: min(100%, 560px); margin: 0 auto; padding: 8px 12px max(8px, env(safe-area-inset-bottom)); border-top: 1px solid #e5e7eb; background: #fff; }
.bottom-nav button { padding: 0 6px; background: transparent; color: #6b7280; font-size: 13px; }
.bottom-nav button[aria-current="page"] { color: #111827; font-weight: 700; }
@media (min-width: 640px) {
  #app { border-right: 1px solid #d1d5db; border-left: 1px solid #d1d5db; padding-right: 24px; padding-left: 24px; }
}
`;

const MANAGE_MANIFEST = JSON.stringify({
  name: 'StaffBot 管理端',
  short_name: 'StaffBot',
  start_url: '/manage/',
  scope: '/manage/',
  display: 'standalone',
  background_color: '#ffffff',
  theme_color: '#111827',
  icons: [{
    src: '/manage/icon.svg',
    sizes: 'any',
    type: 'image/svg+xml',
    purpose: 'any maskable'
  }]
});

const MANAGE_CACHE_PREFIX = 'staffbot-manage-shell-';
const MANAGE_CACHE_VERSION_LIMIT = 80;
const MANAGE_SERVICE_WORKER = `const CACHE_NAME = __MANAGE_CACHE_NAME__;
const SHELL_URLS = [
  '/manage/',
  '/manage/app.js',
  '/manage/styles.css',
  '/manage/manifest.webmanifest',
  '/manage/icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names
          .filter((name) => name.startsWith('staffbot-manage-shell-') && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  const isShell = request.method === 'GET'
    && url.origin === self.location.origin
    && !url.search
    && SHELL_URLS.includes(url.pathname);
  if (!isShell) {
    event.respondWith(fetch(request));
    return;
  }
  event.respondWith(
    caches.open(CACHE_NAME)
      .then((cache) => cache.match(request))
      .then((cached) => cached || fetch(request))
  );
});
`;

function manageServiceWorker(env) {
  const rawVersion = env
    && env.CF_VERSION_METADATA
    && typeof env.CF_VERSION_METADATA.id === 'string'
    ? env.CF_VERSION_METADATA.id.trim()
    : '';
  const safeVersion = rawVersion
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MANAGE_CACHE_VERSION_LIMIT) || 'local';
  const cacheName = MANAGE_CACHE_PREFIX + safeVersion;
  return MANAGE_SERVICE_WORKER.replace(
    '__MANAGE_CACHE_NAME__',
    JSON.stringify(cacheName)
  );
}

const MANAGE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="StaffBot">
  <rect width="512" height="512" rx="112" fill="#111827"/>
  <path d="M144 152h224v56H224v48h112v56H224v96h-80z" fill="#fff"/>
</svg>`;

const ASSETS = new Map([
  ['/manage/app.js', [MANAGE_CLIENT, 'application/javascript; charset=utf-8']],
  ['/manage/styles.css', [MANAGE_STYLES, 'text/css; charset=utf-8']],
  ['/manage/manifest.webmanifest', [MANAGE_MANIFEST, 'application/manifest+json; charset=utf-8']],
  ['/manage/sw.js', [MANAGE_SERVICE_WORKER, 'application/javascript; charset=utf-8']],
  ['/manage/icon.svg', [MANAGE_ICON, 'image/svg+xml; charset=utf-8']]
]);

export function handleManageAsset(request, env, url) {
  const asset = ASSETS.get(url.pathname);
  if (!asset) return null;
  const [body, contentType] = asset;
  const responseBody = url.pathname === '/manage/sw.js'
    ? manageServiceWorker(env)
    : body;
  const headers = {
    'content-type': contentType,
    ...manageSecurityHeaders()
  };
  if (
    url.pathname === '/manage/sw.js'
    || url.pathname === '/manage/manifest.webmanifest'
  ) headers['cache-control'] = 'no-cache';
  return new Response(responseBody, { headers });
}
