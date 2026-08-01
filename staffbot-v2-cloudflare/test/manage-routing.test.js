import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.js';

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

test('manage client exposes login and authenticated shell placeholders', async () => {
  const response = await worker.fetch(
    new Request('https://staffbot.test/manage/app.js'),
    env,
    context()
  );
  const client = await response.text();

  assert.match(client, /\/api\/admin\/login\/start/);
  assert.match(client, /\/api\/admin\/login\/verify/);
  assert.match(client, /\/api\/admin\/me/);
  assert.match(client, /<nav[^>]*aria-label="Bottom navigation"/);
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
