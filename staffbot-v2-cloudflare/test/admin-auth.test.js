import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  requireAdminSession,
  startAdminLogin,
  verifyAdminLogin
} from '../src/admin-auth.js';
import { handleAdminApi } from '../src/admin-api.js';
import { createD1 } from './helpers/d1.js';

const schema = readFileSync(
  new URL('../db/schema.sql', import.meta.url),
  'utf8'
);

function authFixture() {
  const database = new DatabaseSync(':memory:');
  database.exec(schema);
  return {
    database,
    env: {
      ADMIN_IDS: 'ADMIN-1',
      DB: createD1(database)
    }
  };
}

function requestJson(path, body) {
  return new Request(`https://staffbot.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

function context() {
  return { waitUntil() {} };
}

test('verified login creates one reusable session with CSRF', async () => {
  const fixture = authFixture();
  try {
    fixture.database.prepare(`
      INSERT INTO admin_login_codes (
        telegram_id, code, expires_at, created_at,
        failed_attempts, locked_until
      ) VALUES (?, ?, ?, ?, 0, NULL)
    `).run(
      'ADMIN-1',
      '123456',
      '2099-01-01T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z'
    );

    const response = await verifyAdminLogin(
      requestJson('/api/admin/login/verify', {
        telegram_id: 'ADMIN-1',
        code: '123456'
      }),
      fixture.env
    );
    const session = fixture.database.prepare(`
      SELECT token, telegram_id, csrf_token FROM admin_sessions
    `).get();
    const cookie = response.headers.get('set-cookie').split(';', 1)[0];
    const reusable = await requireAdminSession(
      new Request('https://staffbot.test/manage', {
        headers: { cookie }
      }),
      fixture.env
    );
    const me = await handleAdminApi(
      new Request('https://staffbot.test/api/admin/me', {
        headers: { cookie }
      }),
      fixture.env,
      new URL('https://staffbot.test/api/admin/me'),
      context()
    );

    assert.equal(response.status, 200);
    assert.equal(session.telegram_id, 'ADMIN-1');
    assert.match(session.csrf_token, /^CSRF-/);
    assert.equal(reusable.token, session.token);
    assert.equal(reusable.csrf_token, session.csrf_token);
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), {
      ok: true,
      telegram_id: 'ADMIN-1',
      global_admin: true
    });
  } finally {
    fixture.database.close();
  }
});

test('a legacy valid session receives CSRF without another OTP', async () => {
  const fixture = authFixture();
  try {
    fixture.database.prepare(`
      INSERT INTO admin_sessions (
        token, telegram_id, expires_at, created_at, csrf_token
      ) VALUES (?, ?, ?, ?, NULL)
    `).run(
      'LEGACY-SESSION',
      'ADMIN-1',
      '2099-01-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z'
    );
    const request = new Request('https://staffbot.test/manage', {
      headers: { cookie: 'staffbot_admin_session=LEGACY-SESSION' }
    });

    const session = await requireAdminSession(request, fixture.env);

    assert.match(session.csrf_token, /^CSRF-/);
    assert.equal(
      fixture.database.prepare(`
        SELECT csrf_token FROM admin_sessions
        WHERE token = 'LEGACY-SESSION'
      `).get().csrf_token,
      session.csrf_token
    );
  } finally {
    fixture.database.close();
  }
});

test('login start keeps the forbidden response contract', async () => {
  const fixture = authFixture();
  try {
    const response = await startAdminLogin(
      requestJson('/api/admin/login/start', { telegram_id: 'UNKNOWN' }),
      fixture.env
    );

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: 'forbidden'
    });
  } finally {
    fixture.database.close();
  }
});
