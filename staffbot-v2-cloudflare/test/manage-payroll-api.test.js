import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import worker from '../src/index.js';
import { createD1 } from './helpers/d1.js';

const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

function setup() {
  const database = new DatabaseSync(':memory:');
  database.exec(schema);
  database.exec(`
    INSERT INTO stores (
      store_id, name, status, timezone, currency, created_at, updated_at
    ) VALUES
      ('STORE-1', 'Tokyo Club', 'active', 'Asia/Tokyo', '$',
       '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'),
      ('STORE-2', 'Osaka Club', 'active', 'Asia/Tokyo', '$',
       '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
    INSERT INTO store_members (
      store_id, telegram_id, display_name, role, status,
      cycle_start, joined_at, updated_at
    ) VALUES
      ('STORE-1', 'ADMIN-1', 'Manager', 'admin', 'active',
       '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z',
       '2026-07-01T00:00:00.000Z'),
      ('STORE-1', 'EMP-1', 'Alice', 'employee', 'active',
       '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z',
       '2026-07-01T00:00:00.000Z');
    INSERT INTO admin_sessions (
      token, telegram_id, expires_at, created_at, csrf_token
    ) VALUES (
      'SESSION-1', 'ADMIN-1', '2099-01-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z', 'CSRF-1'
    );
    INSERT INTO payroll_payment_qr_codes (
      qr_id, store_id, telegram_id, object_key, telegram_file_id,
      mime_type, size_bytes, uploaded_at
    ) VALUES (
      'QR-1', 'STORE-1', 'EMP-1', 'secret-r2-qr-key', 'TG-QR',
      'image/png', 120, '2026-07-01T00:00:00.000Z'
    );
    INSERT INTO payroll_disbursements (
      payroll_id, store_id, telegram_id, payroll_start_date,
      scheduled_date, cycle_day, period_start, cutoff_at,
      amount_snapshot_micros, currency, status,
      accepts_bank, accepts_usdt, accepts_cash,
      bank_details_snapshot, usdt_details_snapshot, usdt_qr_id_snapshot,
      created_at, updated_at
    ) VALUES (
      'PAYROLL-1', 'STORE-1', 'EMP-1', '2026-07-01',
      '2026-07-16', 16, '2026-07-01T03:00:00.000Z',
      '2026-07-16T03:00:00.000Z', 100000000, '$',
      'awaiting_admin_payment', 1, 1, 1,
      'Bank 12345678', 'TRX-ABCDEFGH', 'QR-1',
      '2026-07-16T03:10:00.000Z', '2026-07-16T03:10:00.000Z'
    );
    INSERT INTO payroll_payment_attempts (
      attempt_id, payroll_id, version, status,
      bank_micros, usdt_micros, cash_micros,
      submitted_by, submitted_at, created_at, updated_at
    ) VALUES (
      'ATTEMPT-HISTORY', 'PAYROLL-1', 1, 'submitted',
      70000000, 30000000, 0, 'ADMIN-0',
      '2026-07-16T04:00:00.000Z', '2026-07-16T03:50:00.000Z',
      '2026-07-16T04:00:00.000Z'
    );
    INSERT INTO payroll_payment_proofs (
      proof_id, payroll_id, attempt_id, method, object_key,
      mime_type, size_bytes, sort_order, uploaded_by, uploaded_at
    ) VALUES (
      'PROOF-1', 'PAYROLL-1', 'ATTEMPT-HISTORY', 'bank',
      'secret-r2-proof-key', 'image/jpeg', 200, 1, 'ADMIN-0',
      '2026-07-16T03:55:00.000Z'
    );
    INSERT INTO admin_audit_logs (
      store_id, admin_id, action, target_id, details_json, created_at
    ) VALUES
      (
        'STORE-1', 'ADMIN-0', 'save_payroll_payment_split', 'PAYROLL-1',
        '{"version":1,"lease_token":"raw-top","nested":{"lease_token_hash":"hash-nested","safe":"kept"}}',
        '2026-07-16T03:55:00.000Z'
      ),
      (
        'STORE-1', 'ADMIN-0',
        'payroll_notification_delivery_claimed', 'PAYROLL-1',
        '{"attempt_id":"ATTEMPT-HISTORY","lease_token_hash":"hash-claim"}',
        '2026-07-16T03:56:00.000Z'
      ),
      (
        'STORE-1', 'ADMIN-0',
        'payroll_notification_delivery_renewed', 'PAYROLL-1',
        '{"attempt_id":"ATTEMPT-HISTORY","lease_token_hash":"hash-renew"}',
        '2026-07-16T03:57:00.000Z'
      );
  `);
  return {
    database,
    env: {
      ADMIN_IDS: '',
      BOT_TOKEN: 'test-token',
      DB: createD1(database),
      PAYROLL_PROOFS: {
        async get(key) {
          assert.equal(key, 'secret-r2-qr-key');
          return {
            body: new Uint8Array([1, 2, 3]),
            httpEtag: 'etag',
            writeHttpMetadata(headers) { headers.set('content-type', 'image/png'); }
          };
        }
      }
    }
  };
}

function request(env, path, { method = 'GET', body, csrf = true } = {}) {
  return worker.fetch(new Request(`https://staffbot.test${path}`, {
    method,
    headers: {
      cookie: 'staffbot_admin_session=SESSION-1',
      'content-type': 'application/json',
      ...(method === 'GET' || !csrf ? {} : { 'x-csrf-token': 'CSRF-1' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  }), env, { waitUntil() {} });
}

test('payroll list and dossier are store-scoped, masked, and include complete history', async () => {
  const fixture = setup();
  try {
    const listResponse = await request(
      fixture.env,
      '/api/manage/stores/STORE-1/payroll'
    );
    const list = await listResponse.json();
    assert.equal(listResponse.status, 200);
    assert.equal(list.payroll.length, 1);
    assert.equal(list.payroll[0].employee_name, 'Alice');

    const response = await request(
      fixture.env,
      '/api/manage/stores/STORE-1/payroll/PAYROLL-1'
    );
    const dossier = await response.json();
    assert.equal(response.status, 200);
    assert.equal(dossier.payroll.employee_name, 'Alice');
    assert.deepEqual(dossier.payroll.payment_profile, {
      accepts_bank: true,
      accepts_usdt: true,
      accepts_cash: true,
      bank: '••••5678',
      usdt: '••••EFGH',
      has_usdt_qr: true,
      usdt_qr_url: '/api/manage/stores/STORE-1/payroll/PAYROLL-1/usdt-qr'
    });
    assert.equal(dossier.attempts.length, 1);
    assert.equal(dossier.attempts[0].proofs[0].url,
      '/api/manage/stores/STORE-1/payroll/proofs/PROOF-1');
    assert.deepEqual(dossier.history.map((row) => row.action), [
      'save_payroll_payment_split'
    ]);
    assert.deepEqual(dossier.history[0].details, {
      version: 1,
      nested: { safe: 'kept' }
    });
    assert.doesNotMatch(JSON.stringify(dossier), /secret-r2|12345678|ABCDEFGH/);
    assert.doesNotMatch(JSON.stringify(dossier.history), /token|hash|raw-top|hash-nested/);

    const crossStore = await request(
      fixture.env,
      '/api/manage/stores/STORE-2/payroll/PAYROLL-1'
    );
    assert.equal(crossStore.status, 403);
  } finally {
    fixture.database.close();
  }
});

test('authorized USDT QR read stays private and does not expose its object key', async () => {
  const fixture = setup();
  try {
    const response = await request(
      fixture.env,
      '/api/manage/stores/STORE-1/payroll/PAYROLL-1/usdt-qr'
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('content-type'), 'image/png');
  } finally {
    fixture.database.close();
  }
});

test('draft and split routes require exact CSRF and the active payroll claim', async () => {
  const fixture = setup();
  try {
    const noCsrf = await request(
      fixture.env,
      '/api/manage/stores/STORE-1/payroll/PAYROLL-1/attempts/draft',
      { method: 'POST', body: {}, csrf: false }
    );
    assert.equal(noCsrf.status, 403);

    const noClaim = await request(
      fixture.env,
      '/api/manage/stores/STORE-1/payroll/PAYROLL-1/attempts/draft',
      { method: 'POST', body: {} }
    );
    assert.equal(noClaim.status, 409);
    assert.equal((await noClaim.json()).error, 'task_claim_required');

    fixture.database.exec(`
      INSERT INTO admin_task_claims (
        task_type, task_id, store_id, claimed_by,
        claimed_at, lease_expires_at, updated_at
      ) VALUES (
        'payroll', 'PAYROLL-1', 'STORE-1', 'ADMIN-1',
        '2026-07-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z',
        '2026-07-01T00:00:00.000Z'
      )
    `);
    const draftResponse = await request(
      fixture.env,
      '/api/manage/stores/STORE-1/payroll/PAYROLL-1/attempts/draft',
      { method: 'POST', body: {} }
    );
    const draftBody = await draftResponse.json();
    assert.equal(draftResponse.status, 200);
    assert.equal(draftBody.attempt.status, 'draft');
    assert.equal(draftBody.attempt.version, 2);

    const invalid = await request(
      fixture.env,
      `/api/manage/stores/STORE-1/payroll/PAYROLL-1/attempts/${draftBody.attempt.attempt_id}/split`,
      {
        method: 'PUT',
        body: { bank_micros: 50_000_000, usdt_micros: 0, cash_micros: 1 }
      }
    );
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, 'invalid_payroll_split');

    const saved = await request(
      fixture.env,
      `/api/manage/stores/STORE-1/payroll/PAYROLL-1/attempts/${draftBody.attempt.attempt_id}/split`,
      {
        method: 'PUT',
        body: { bank_micros: 70_000_000, usdt_micros: 30_000_000, cash_micros: 0 }
      }
    );
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).attempt.bank_micros, 70_000_000);

    const missing = await request(
      fixture.env,
      '/api/manage/stores/STORE-1/payroll/NOPE/attempts/draft',
      { method: 'POST', body: {} }
    );
    assert.equal(missing.status, 404);
  } finally {
    fixture.database.close();
  }
});
