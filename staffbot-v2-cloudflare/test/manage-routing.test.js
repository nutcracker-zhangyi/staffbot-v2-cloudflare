import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import worker from '../src/index.js';
import { createD1 } from './helpers/d1.js';
import { executeManageClient } from './helpers/manage-dom.js';

const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

function context() {
  return { waitUntil() {} };
}

const env = { ENVIRONMENT: 'staging' };

function manageApiFixture() {
  const database = new DatabaseSync(':memory:');
  database.exec(schema);
  const now = '2026-07-29T03:00:00.000Z';
  for (const [storeId, name] of [['STORE-1', 'Tokyo Club'], ['STORE-2', 'Osaka Club']]) {
    database.prepare(`
      INSERT INTO stores (store_id, name, currency, created_at, updated_at)
      VALUES (?, ?, '₫', ?, ?)
    `).run(storeId, name, now, now);
  }
  for (const [storeId, adminId] of [['STORE-1', 'ADMIN-1'], ['STORE-2', 'ADMIN-2']]) {
    database.prepare(`
      INSERT INTO store_members (
        store_id, telegram_id, display_name, role, status,
        cycle_start, joined_at, updated_at
      ) VALUES (?, ?, ?, 'admin', 'active', '2026-07-01', ?, ?)
    `).run(storeId, adminId, adminId, now, now);
  }
  for (const [storeId, employeeId, requestId] of [
    ['STORE-1', 'EMP-1', 'INC/1'],
    ['STORE-2', 'EMP-2', 'INC-2']
  ]) {
    database.prepare(`
      INSERT INTO store_members (
        store_id, telegram_id, display_name, role, status,
        cycle_start, joined_at, updated_at
      ) VALUES (?, ?, ?, 'employee', 'active', '2026-07-01', ?, ?)
    `).run(storeId, employeeId, employeeId, now, now);
    database.prepare(`
      INSERT INTO pending_income (
        request_id, store_id, telegram_id, income, commission_rate,
        commission_income, fine, status, submitted_at
      ) VALUES (?, ?, ?, 100, 0.6, 60, 0, 'pending', ?)
    `).run(requestId, storeId, employeeId, now);
  }
  database.prepare(`
    INSERT INTO admin_sessions (
      token, telegram_id, expires_at, created_at, csrf_token
    ) VALUES ('SESSION-1', 'ADMIN-1', '2099-01-01T00:00:00.000Z', ?, 'CSRF-1')
  `).run(now);
  return {
    database,
    env: {
      ADMIN_IDS: '',
      ENVIRONMENT: 'staging',
      DB: createD1(database)
    }
  };
}

function manageRequest(path, options = {}) {
  const headers = new Headers(options.headers);
  headers.set('cookie', 'staffbot_admin_session=SESSION-1');
  return new Request(`https://staffbot.test${path}`, { ...options, headers });
}

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
      if (path === '/api/manage/session') {
        return new Response(JSON.stringify({
          ok: true,
          telegram_id: 'ADMIN-1',
          global_admin: true,
          csrf_token: 'CSRF-1'
        }));
      }
      if (path === '/api/manage/stores') {
        return new Response(JSON.stringify({ ok: true, stores: [] }));
      }
      if (path === '/api/manage/tasks?') {
        return new Response(JSON.stringify({ ok: true, tasks: [] }));
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
  await browser.clickButton('更多');
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
    ['待办', '审批', '工资', '更多']
  );
  assert.equal(
    navigation.children[3].getAttribute('aria-current'),
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
    { path: '/api/manage/session', method: 'GET', body: null },
    { path: '/api/manage/stores', method: 'GET', body: null },
    { path: '/api/manage/tasks?', method: 'GET', body: null },
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

test('manage API requires a session and returns session plus authorized stores', async () => {
  const fixture = manageApiFixture();
  const unauthorized = await worker.fetch(
    new Request('https://staffbot.test/api/manage/session'),
    fixture.env,
    context()
  );
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), { ok: false, error: 'unauthorized' });

  const session = await worker.fetch(
    manageRequest('/api/manage/session'),
    fixture.env,
    context()
  );
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), {
    ok: true,
    telegram_id: 'ADMIN-1',
    global_admin: false,
    csrf_token: 'CSRF-1'
  });

  const stores = await worker.fetch(
    manageRequest('/api/manage/stores'),
    fixture.env,
    context()
  );
  assert.deepEqual(await stores.json(), {
    ok: true,
    stores: [{
      store_id: 'STORE-1',
      name: 'Tokyo Club',
      currency: '₫',
      timezone: 'Asia/Tokyo'
    }]
  });
});

test('manage task API decodes ids and rejects another store', async () => {
  const fixture = manageApiFixture();
  const tasks = await worker.fetch(
    manageRequest('/api/manage/tasks?store_id=STORE-1&type=income'),
    fixture.env,
    context()
  );
  assert.equal(tasks.status, 200);
  assert.deepEqual(
    (await tasks.json()).tasks.map((task) => task.task_id),
    ['INC/1']
  );

  const forbiddenList = await worker.fetch(
    manageRequest('/api/manage/tasks?store_id=STORE-2&type=income'),
    fixture.env,
    context()
  );
  assert.equal(forbiddenList.status, 403);

  const forbiddenClaim = await worker.fetch(
    manageRequest('/api/manage/tasks/income/INC-2/claim', {
      method: 'POST',
      headers: { 'x-csrf-token': 'CSRF-1' }
    }),
    fixture.env,
    context()
  );
  assert.equal(forbiddenClaim.status, 403);

  const encodedClaim = await worker.fetch(
    manageRequest('/api/manage/tasks/income/INC%2F1/claim', {
      method: 'POST',
      headers: { 'x-csrf-token': 'CSRF-1' }
    }),
    fixture.env,
    context()
  );
  assert.equal(encodedClaim.status, 200);
  assert.equal((await encodedClaim.json()).claim.task_id, 'INC/1');
});

test('manage mutations require exact CSRF and map occupied claims to conflict', async () => {
  const fixture = manageApiFixture();
  const missingCsrf = await worker.fetch(
    manageRequest('/api/manage/tasks/income/INC%2F1/claim', { method: 'POST' }),
    fixture.env,
    context()
  );
  assert.equal(missingCsrf.status, 403);
  assert.deepEqual(await missingCsrf.json(), { ok: false, error: 'forbidden' });

  fixture.database.prepare(`
    INSERT INTO admin_task_claims (
      task_type, task_id, store_id, claimed_by,
      claimed_at, lease_expires_at, updated_at
    ) VALUES ('income', 'INC/1', 'STORE-1', 'ADMIN-2',
      datetime('now'), '2099-01-01T00:00:00.000Z', datetime('now'))
  `).run();
  const occupied = await worker.fetch(
    manageRequest('/api/manage/tasks/income/INC%2F1/claim', {
      method: 'POST',
      headers: { 'x-csrf-token': 'CSRF-1' }
    }),
    fixture.env,
    context()
  );
  assert.equal(occupied.status, 409);
  assert.deepEqual(await occupied.json(), { ok: false, error: 'task_claimed' });
});

test('manage API claims, renews, and releases through persisted D1 state', async () => {
  const fixture = manageApiFixture();
  const request = (action) => manageRequest(
    `/api/manage/tasks/income/INC%2F1/${action}`,
    { method: 'POST', headers: { 'x-csrf-token': 'CSRF-1' } }
  );

  const claimed = await worker.fetch(request('claim'), fixture.env, context());
  assert.equal(claimed.status, 200);
  const firstClaim = (await claimed.json()).claim;
  assert.equal(firstClaim.claimed_by, 'ADMIN-1');
  assert.equal(
    new Date(firstClaim.lease_expires_at).getTime() - new Date(firstClaim.updated_at).getTime(),
    15 * 60 * 1000
  );

  const renewed = await worker.fetch(request('renew'), fixture.env, context());
  assert.equal(renewed.status, 200);
  assert.equal((await renewed.json()).claim.claimed_by, 'ADMIN-1');

  const released = await worker.fetch(request('release'), fixture.env, context());
  assert.equal(released.status, 200);
  assert.deepEqual(await released.json(), { ok: true, claim: null });
  assert.equal(
    fixture.database.prepare(`SELECT COUNT(*) AS total FROM admin_task_claims`).get().total,
    0
  );
});
