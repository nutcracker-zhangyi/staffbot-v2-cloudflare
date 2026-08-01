import { MANAGE_CLIENT } from './manage-client.js';
import { manageSecurityHeaders } from './security.js';

const MANAGE_STYLES = `:root {
  color-scheme: light;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #111827;
  background: #f3f4f6;
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; }
button, input { font: inherit; }
button { min-height: 44px; border: 0; border-radius: 12px; padding: 0 16px; background: #111827; color: #fff; }
button:disabled { opacity: .5; }
label { display: grid; gap: 6px; font-weight: 600; }
input { min-height: 44px; border: 1px solid #d1d5db; border-radius: 12px; padding: 0 12px; }
#app { width: min(100%, 560px); min-height: 100vh; margin: 0 auto; padding: 24px 20px 92px; background: #fff; }
.auth-card { display: grid; gap: 16px; margin-top: 12vh; }
.eyebrow { margin: 0; color: #6b7280; font-size: 12px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
h1, h2, p { margin-top: 0; }
.app-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.secondary { background: #e5e7eb; color: #111827; }
.placeholder { margin-top: 24px; border: 1px solid #e5e7eb; border-radius: 16px; padding: 20px; }
.bottom-nav { position: fixed; right: 0; bottom: 0; left: 0; display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; width: min(100%, 560px); margin: 0 auto; padding: 8px 12px max(8px, env(safe-area-inset-bottom)); border-top: 1px solid #e5e7eb; background: #fff; }
.bottom-nav button { padding: 0 6px; background: transparent; color: #6b7280; font-size: 13px; }
.bottom-nav button[aria-current="page"] { color: #111827; font-weight: 700; }
`;

const MANAGE_MANIFEST = JSON.stringify({
  name: 'StaffBot 管理端',
  short_name: 'StaffBot',
  start_url: '/manage',
  scope: '/manage',
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

const MANAGE_SERVICE_WORKER = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
`;

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
  const headers = {
    'content-type': contentType,
    ...manageSecurityHeaders()
  };
  if (url.pathname === '/manage/sw.js') headers['cache-control'] = 'no-cache';
  return new Response(body, { headers });
}
