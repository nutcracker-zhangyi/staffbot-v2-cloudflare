import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.js';
import { executeManageClient } from './helpers/manage-dom.js';

function context() {
  return { waitUntil() {} };
}

const env = { ENVIRONMENT: 'staging' };

test('serves the manage shell and assets without changing admin', async () => {
  for (const path of [
    '/manage',
    '/manage/app.js',
    '/manage/styles.css',
    '/manage/manifest.webmanifest',
    '/manage/sw.js',
    '/manage/icon.svg'
  ]) {
    const response = await worker.fetch(
      new Request(`https://staffbot.test${path}`),
      env,
      context()
    );
    assert.equal(response.status, 200, path);
  }
  assert.equal(
    (await worker.fetch(
      new Request('https://staffbot.test/admin'),
      env,
      context()
    )).status,
    200
  );
});

test('manage document uses external assets and strict manage headers', async () => {
  const response = await worker.fetch(
    new Request('https://staffbot.test/manage'),
    env,
    context()
  );
  const document = await response.text();

  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(
    response.headers.get('content-security-policy'),
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  );
  assert.equal(
    response.headers.get('permissions-policy'),
    'geolocation=(), microphone=(), camera=(self)'
  );
  assert.match(document, /<link rel="manifest" href="\/manage\/manifest\.webmanifest">/);
  assert.match(document, /<link rel="stylesheet" href="\/manage\/styles\.css">/);
  assert.match(document, /<main id="app" aria-live="polite"><\/main>/);
  assert.match(document, /<script src="\/manage\/app\.js" defer><\/script>/);
  assert.doesNotMatch(document, /<style[ >]/);
  assert.doesNotMatch(document, /<script(?! src=)[ >]/);
});

test('manage assets have explicit content types and no-cache service worker', async () => {
  const expected = new Map([
    ['/manage/app.js', 'application/javascript; charset=utf-8'],
    ['/manage/styles.css', 'text/css; charset=utf-8'],
    ['/manage/manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
    ['/manage/sw.js', 'application/javascript; charset=utf-8'],
    ['/manage/icon.svg', 'image/svg+xml; charset=utf-8']
  ]);

  for (const [path, contentType] of expected) {
    const response = await worker.fetch(
      new Request(`https://staffbot.test${path}`),
      env,
      context()
    );
    assert.equal(response.headers.get('content-type'), contentType, path);
    assert.equal(
      response.headers.get('content-security-policy'),
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      path
    );
  }

  const serviceWorker = await worker.fetch(
    new Request('https://staffbot.test/manage/sw.js'),
    env,
    context()
  );
  assert.equal(serviceWorker.headers.get('cache-control'), 'no-cache');
});

test('manage client transitions through login, authenticated navigation, and logout', async () => {
  const response = await worker.fetch(
    new Request('https://staffbot.test/manage/app.js'),
    env,
    context()
  );
  const requests = [];
  let authenticated = false;
  const browser = await executeManageClient(await response.text(), {
    async fetch(path, options = {}) {
      const method = options.method || 'GET';
      requests.push({
        path,
        method,
        body: options.body ? JSON.parse(options.body) : null
      });
      if (path === '/api/admin/me' && !authenticated) {
        return new Response(JSON.stringify({
          ok: false,
          error: 'unauthorized'
        }), { status: 401 });
      }
      if (path === '/api/admin/login/start') {
        return new Response(JSON.stringify({ ok: true }));
      }
      if (path === '/api/admin/login/verify') {
        authenticated = true;
        return new Response(JSON.stringify({ ok: true }));
      }
      if (path === '/api/admin/me') {
        return new Response(JSON.stringify({
          ok: true,
          telegram_id: 'ADMIN-1',
          global_admin: true
        }));
      }
      if (path === '/api/admin/logout') {
        authenticated = false;
        return new Response(JSON.stringify({ ok: true }));
      }
      return new Response(JSON.stringify({
        ok: false,
        error: 'not_found'
      }), { status: 404 });
    }
  });

  const telegramId = browser.document.getElementById('telegram-id');
  const loginCode = browser.document.getElementById('login-code');
  assert.ok(telegramId);
  assert.ok(loginCode);
  assert.equal(browser.document.querySelector(
    'nav[aria-label="Bottom navigation"]'
  ), null);

  telegramId.value = 'ADMIN-1';
  loginCode.value = '123456';
  await browser.document.getElementById('send-code').click();
  assert.equal(
    browser.document.getElementById('login-status').textContent,
    '验证码已发送'
  );

  await browser.document.getElementById('verify-code').click();
  assert.equal(
    browser.document.getElementById('session-admin').textContent,
    '已登录：ADMIN-1'
  );
  const navigation = browser.document.querySelector(
    'nav[aria-label="Bottom navigation"]'
  );
  assert.ok(navigation);
  assert.deepEqual(
    Array.from(navigation.children, (button) => button.textContent),
    ['工作台', '待办', '员工', '更多']
  );
  assert.equal(
    navigation.children[0].getAttribute('aria-current'),
    'page'
  );

  await browser.document.getElementById('logout').click();
  assert.ok(browser.document.getElementById('telegram-id'));
  assert.equal(browser.document.getElementById('session-admin'), null);
  assert.deepEqual(requests, [
    { path: '/api/admin/me', method: 'GET', body: null },
    {
      path: '/api/admin/login/start',
      method: 'POST',
      body: { telegram_id: 'ADMIN-1' }
    },
    {
      path: '/api/admin/login/verify',
      method: 'POST',
      body: { telegram_id: 'ADMIN-1', code: '123456' }
    },
    { path: '/api/admin/me', method: 'GET', body: null },
    { path: '/api/admin/logout', method: 'POST', body: null }
  ]);
});

test('unknown manage assets and non-GET manage requests remain not found', async () => {
  for (const request of [
    new Request('https://staffbot.test/manage/missing.js'),
    new Request('https://staffbot.test/manage', { method: 'POST' })
  ]) {
    const response = await worker.fetch(request, env, context());
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: 'not_found'
    });
  }
});
