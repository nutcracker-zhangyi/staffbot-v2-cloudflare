import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import worker from '../src/index.js';
import { deliverPaymentAttempt } from '../src/payroll-notifications.js';
import { sendPhotoBytes } from '../src/telegram-client.js';
import { createD1 } from './helpers/d1.js';

const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

function pngBytes() {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(bytes.buffer).setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(bytes.buffer).setUint32(16, 1);
  new DataView(bytes.buffer).setUint32(20, 1);
  return bytes;
}

function fixture({
  attemptStatus = 'submitted',
  claim = false,
  idempotencyHash = null
} = {}) {
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
    INSERT INTO user_preferences (telegram_id, language, updated_at)
    VALUES ('EMP-1', 'zh', '2026-07-01T00:00:00.000Z');
    INSERT INTO admin_sessions (
      token, telegram_id, expires_at, created_at, csrf_token
    ) VALUES (
      'SESSION-1', 'ADMIN-1', '2099-01-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z', 'CSRF-1'
    );
    INSERT INTO payroll_disbursements (
      payroll_id, store_id, telegram_id, payroll_start_date,
      scheduled_date, cycle_day, period_start, cutoff_at,
      amount_snapshot_micros, currency, status,
      accepts_bank, accepts_usdt, accepts_cash,
      bank_micros, usdt_micros, cash_micros,
      current_admin_id, current_payment_attempt_id,
      created_at, updated_at
    ) VALUES (
      'PAYROLL-1', 'STORE-1', 'EMP-1', '2026-07-01',
      '2026-07-16', 16, '2026-07-01T03:00:00.000Z',
      '2026-07-16T03:00:00.000Z', 100000000, '$',
      '${attemptStatus === 'draft' ? 'awaiting_admin_payment' : 'awaiting_employee_confirmation'}',
      1, 1, 1, 70000000, 30000000, 0,
      'ADMIN-1', 'ATTEMPT-1',
      '2026-07-16T03:10:00.000Z', '2026-07-16T03:10:00.000Z'
    );
    INSERT INTO payroll_payment_attempts (
      attempt_id, payroll_id, version, status,
      bank_micros, usdt_micros, cash_micros,
      idempotency_key_hash,
      created_at, updated_at
    ) VALUES (
      'ATTEMPT-1', 'PAYROLL-1', 2, '${attemptStatus}',
      70000000, 30000000, 0,
      ${idempotencyHash ? `'${idempotencyHash}'` : 'NULL'},
      '2026-07-16T03:20:00.000Z', '2026-07-16T03:20:00.000Z'
    );
    INSERT INTO payroll_payment_proofs (
      proof_id, payroll_id, attempt_id, method, object_key,
      telegram_file_id, mime_type, size_bytes, sort_order,
      uploaded_by, uploaded_at
    ) VALUES
      ('PROOF-BANK', 'PAYROLL-1', 'ATTEMPT-1', 'bank', 'bank-key',
       'TG-EXISTING', 'image/jpeg', 4, 1, 'ADMIN-1',
       '2026-07-16T03:30:00.000Z'),
      ('PROOF-USDT', 'PAYROLL-1', 'ATTEMPT-1', 'usdt', 'usdt-key',
       NULL, 'image/png', 33, 1, 'ADMIN-1',
       '2026-07-16T03:31:00.000Z');
  `);
  if (claim) {
    database.exec(`
      INSERT INTO admin_task_claims (
        task_type, task_id, store_id, claimed_by,
        claimed_at, lease_expires_at, updated_at
      ) VALUES (
        'payroll', 'PAYROLL-1', 'STORE-1', 'ADMIN-1',
        '2026-07-16T03:40:00.000Z', '2099-01-01T00:00:00.000Z',
        '2026-07-16T03:40:00.000Z'
      );
    `);
  }
  const objects = new Map([
    ['bank-key', new Uint8Array([1, 2, 3, 4])],
    ['usdt-key', pngBytes()]
  ]);
  return {
    database,
    objects,
    env: {
      ADMIN_IDS: '',
      BOT_TOKEN: 'PRIVATE-BOT-TOKEN',
      DB: createD1(database),
      ENVIRONMENT: 'production',
      PAYROLL_PROOFS: {
        async get(key) {
          const bytes = objects.get(key);
          return bytes ? {
            body: bytes,
            size: bytes.byteLength,
            async arrayBuffer() { return bytes.buffer; }
          } : null;
        }
      }
    }
  };
}

function installTelegram({
  failSummary = false,
  failPhoto = false,
  waitForFirstPhoto = null
} = {}) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const method = String(url).split('/').pop();
    const body = options.body;
    calls.push({ url: String(url), method, body });
    if (method === 'sendPhoto' && failPhoto) {
      return { json: async () => ({
        ok: false,
        error_code: 400,
        description: 'private Telegram proof detail'
      }) };
    }
    if (method === 'sendPhoto' && body instanceof FormData) {
      if (waitForFirstPhoto) await waitForFirstPhoto();
      const photo = body.get('photo');
      return { json: async () => ({
        ok: true,
        result: { photo: [
          { file_id: 'TG-SMALL', file_size: 2, width: 10, height: 10 },
          { file_id: 'TG-LARGEST', file_size: 5, width: 20, height: 20 }
        ] }
      }) };
    }
    const payload = JSON.parse(body);
    if (method === 'sendMessage' && failSummary) {
      return { json: async () => ({ ok: false, error_code: 500, description: 'private upstream detail' }) };
    }
    return { json: async () => ({ ok: true, result: { message_id: 10 }, payload }) };
  };
  return { calls, restore() { globalThis.fetch = originalFetch; } };
}

function manageRequest(env, path, { idempotencyKey, csrf = true } = {}) {
  return worker.fetch(new Request(`https://staffbot.test${path}`, {
    method: 'POST',
    headers: {
      cookie: 'staffbot_admin_session=SESSION-1',
      ...(csrf ? { 'x-csrf-token': 'CSRF-1' } : {}),
      ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey })
    }
  }), env, { waitUntil() {} });
}

async function hashKey(value) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value)
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

test('sendPhotoBytes uploads exact bytes and metadata without exposing the bot token', async () => {
  const fixtureValue = fixture();
  const telegram = installTelegram();
  try {
    const result = await sendPhotoBytes(
      fixtureValue.env, 'EMP-1', new Uint8Array([1, 2, 3]),
      'receipt.png', 'image/png', '银行卡 1'
    );
    assert.equal(result.ok, true);
    assert.equal(telegram.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE-BOT-TOKEN/);
    assert.doesNotMatch(JSON.stringify(fixtureValue.database.prepare(`
      SELECT * FROM bot_logs
    `).all()), /PRIVATE-BOT-TOKEN/);
    const form = telegram.calls[0].body;
    assert.equal(form.get('chat_id'), 'EMP-1');
    assert.equal(form.get('caption'), '银行卡 1');
    const file = form.get('photo');
    assert.equal(file.name, 'receipt.png');
    assert.equal(file.type, 'image/png');
    assert.equal(file.size, 3);
  } finally {
    telegram.restore();
    fixtureValue.database.close();
  }
});

test('delivery uses stored Telegram file IDs, uploads private R2 bytes, and checkpoints exactly once', async () => {
  const fixtureValue = fixture();
  const telegram = installTelegram();
  try {
    const delivered = await deliverPaymentAttempt(
      fixtureValue.env, 'ADMIN-1', 'ATTEMPT-1', new Date('2026-07-16T04:00:00.000Z')
    );
    assert.equal(delivered.status, 'sent');
    assert.equal(telegram.calls.filter((call) => call.method === 'sendPhoto').length, 2);
    assert.equal(telegram.calls.filter((call) => call.method === 'sendMessage').length, 1);
    const summary = JSON.parse(
      telegram.calls.find((call) => call.method === 'sendMessage').body
    );
    assert.match(summary.text, /工资周期：2026\/07\/01 12:00 - 2026\/07\/16 12:00/);
    assert.match(summary.text, /付款版本：2/);
    assert.match(summary.text, /工资 ID：PAYROLL-1/);
    assert.deepEqual(
      summary.reply_markup.inline_keyboard[0].map((button) => button.callback_data),
      ['pay:ok:PAYROLL-1', 'pay:x:PAYROLL-1']
    );
    const existingPayload = JSON.parse(
      telegram.calls.find((call) => call.method === 'sendPhoto' && typeof call.body === 'string').body
    );
    assert.equal(existingPayload.photo, 'TG-EXISTING');
    const rows = fixtureValue.database.prepare(`
      SELECT proof_id, telegram_file_id, telegram_delivered_at
      FROM payroll_payment_proofs ORDER BY proof_id
    `).all();
    assert.equal(rows[0].telegram_file_id, 'TG-EXISTING');
    assert.equal(rows[1].telegram_file_id, 'TG-LARGEST');
    assert.ok(rows.every((row) => row.telegram_delivered_at === '2026-07-16T04:00:00.000Z'));
    assert.equal(fixtureValue.database.prepare(`
      SELECT payment_sent_at FROM payroll_disbursements WHERE payroll_id = 'PAYROLL-1'
    `).get().payment_sent_at, '2026-07-16T04:00:00.000Z');

    const replay = await deliverPaymentAttempt(
      fixtureValue.env, 'ADMIN-1', 'ATTEMPT-1', new Date('2026-07-16T04:01:00.000Z')
    );
    assert.equal(replay.status, 'sent');
    assert.equal(telegram.calls.length, 3);
  } finally {
    telegram.restore();
    fixtureValue.database.close();
  }
});

test('summary failure preserves proof checkpoints and retry sends only the summary', async () => {
  const fixtureValue = fixture();
  const firstTelegram = installTelegram({ failSummary: true });
  try {
    await assert.rejects(
      deliverPaymentAttempt(
        fixtureValue.env, 'ADMIN-1', 'ATTEMPT-1', new Date('2026-07-16T04:00:00.000Z')
      ),
      /payroll notification failed/
    );
    assert.equal(fixtureValue.database.prepare(`
      SELECT payment_sent_at FROM payroll_disbursements WHERE payroll_id = 'PAYROLL-1'
    `).get().payment_sent_at, null);
    assert.equal(fixtureValue.database.prepare(`
      SELECT COUNT(*) AS count FROM payroll_payment_proofs
      WHERE attempt_id = 'ATTEMPT-1' AND telegram_delivered_at IS NOT NULL
    `).get().count, 2);
  } finally {
    firstTelegram.restore();
  }

  const retryTelegram = installTelegram();
  try {
    const retried = await deliverPaymentAttempt(
      fixtureValue.env, 'ADMIN-1', 'ATTEMPT-1', new Date('2026-07-16T04:01:00.000Z')
    );
    assert.equal(retried.status, 'sent');
    assert.deepEqual(retryTelegram.calls.map((call) => call.method), ['sendMessage']);
  } finally {
    retryTelegram.restore();
    fixtureValue.database.close();
  }
});

test('submit commits payment before a failed Telegram notification and exposes a retryable result', async () => {
  const fixtureValue = fixture({ attemptStatus: 'draft', claim: true });
  const telegram = installTelegram({ failSummary: true });
  try {
    const response = await manageRequest(
      fixtureValue.env,
      '/api/manage/stores/STORE-1/payroll/PAYROLL-1/attempts/ATTEMPT-1/submit',
      { idempotencyKey: 'submit-1' }
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.notification, { status: 'failed', retryable: true });
    assert.equal(fixtureValue.database.prepare(`
      SELECT status FROM payroll_payment_attempts WHERE attempt_id = 'ATTEMPT-1'
    `).get().status, 'submitted');
    const payroll = fixtureValue.database.prepare(`
      SELECT status, employee_notification_error FROM payroll_disbursements
      WHERE payroll_id = 'PAYROLL-1'
    `).get();
    assert.equal(payroll.status, 'awaiting_employee_confirmation');
    assert.ok(payroll.employee_notification_error);
    assert.doesNotMatch(payroll.employee_notification_error, /private upstream detail|PRIVATE-BOT-TOKEN|submit-1/);
  } finally {
    telegram.restore();
  }

  const retryTelegram = installTelegram();
  try {
    const retry = await manageRequest(
      fixtureValue.env,
      '/api/manage/stores/STORE-1/payroll/PAYROLL-1/attempts/ATTEMPT-1/notify/retry'
    );
    assert.equal(retry.status, 200);
    assert.deepEqual((await retry.json()).notification, {
      status: 'sent', retryable: false
    });
    assert.deepEqual(retryTelegram.calls.map((call) => call.method), ['sendMessage']);

    const replay = await manageRequest(
      fixtureValue.env,
      '/api/manage/stores/STORE-1/payroll/PAYROLL-1/attempts/ATTEMPT-1/notify/retry'
    );
    assert.equal(replay.status, 200);
    assert.equal(retryTelegram.calls.length, 1);
  } finally {
    retryTelegram.restore();
    fixtureValue.database.close();
  }
});

test('submit requires a bounded idempotency key and retry is current/store scoped', async () => {
  const fixtureValue = fixture({ attemptStatus: 'draft', claim: true });
  const telegram = installTelegram();
  try {
    const noCsrf = await manageRequest(
      fixtureValue.env,
      '/api/manage/stores/STORE-1/payroll/PAYROLL-1/attempts/ATTEMPT-1/submit',
      { idempotencyKey: 'csrf-key', csrf: false }
    );
    assert.equal(noCsrf.status, 403);
    const missing = await manageRequest(
      fixtureValue.env,
      '/api/manage/stores/STORE-1/payroll/PAYROLL-1/attempts/ATTEMPT-1/submit'
    );
    assert.equal(missing.status, 400);
    const oversized = await manageRequest(
      fixtureValue.env,
      '/api/manage/stores/STORE-1/payroll/PAYROLL-1/attempts/ATTEMPT-1/submit',
      { idempotencyKey: 'x'.repeat(257) }
    );
    assert.equal(oversized.status, 400);

    fixtureValue.database.exec(`
      DELETE FROM admin_task_claims
      WHERE task_type = 'payroll' AND task_id = 'PAYROLL-1';
    `);
    const lostClaim = await manageRequest(
      fixtureValue.env,
      '/api/manage/stores/STORE-1/payroll/PAYROLL-1/attempts/ATTEMPT-1/submit',
      { idempotencyKey: 'lost-claim-key' }
    );
    assert.equal(lostClaim.status, 409);

    const crossStoreRetry = await manageRequest(
      fixtureValue.env,
      '/api/manage/stores/STORE-2/payroll/PAYROLL-1/attempts/ATTEMPT-1/notify/retry'
    );
    assert.equal(crossStoreRetry.status, 403);
  } finally {
    telegram.restore();
    fixtureValue.database.close();
  }
});

test('staging recipient rejection performs no network request', async () => {
  const fixtureValue = fixture();
  fixtureValue.env.ENVIRONMENT = 'staging';
  fixtureValue.env.TELEGRAM_RECIPIENT_MODE = 'allowlist';
  fixtureValue.env.STAGING_ALLOWED_TELEGRAM_IDS = 'SOMEONE-ELSE';
  const telegram = installTelegram();
  try {
    const result = await sendPhotoBytes(
      fixtureValue.env, 'EMP-1', new Uint8Array([1]),
      'proof.jpg', 'image/jpeg', 'proof'
    );
    assert.equal(result.ok, false);
    assert.equal(result.description, 'staging_recipient_blocked');
    assert.equal(telegram.calls.length, 0);
  } finally {
    telegram.restore();
    fixtureValue.database.close();
  }
});

test('a missing private R2 proof records only a safe per-proof failure', async () => {
  const fixtureValue = fixture();
  fixtureValue.objects.delete('usdt-key');
  const telegram = installTelegram();
  try {
    await assert.rejects(
      deliverPaymentAttempt(
        fixtureValue.env, 'ADMIN-1', 'ATTEMPT-1', new Date('2026-07-16T04:00:00.000Z')
      ),
      /payroll notification failed/
    );
    assert.deepEqual(telegram.calls.map((call) => call.method), ['sendPhoto']);
    assert.deepEqual({ ...fixtureValue.database.prepare(`
      SELECT proof_id, telegram_delivered_at
      FROM payroll_payment_proofs ORDER BY proof_id
    `).all()[0] }, {
      proof_id: 'PROOF-BANK',
      telegram_delivered_at: '2026-07-16T04:00:00.000Z'
    });
    const error = fixtureValue.database.prepare(`
      SELECT employee_notification_error FROM payroll_disbursements
      WHERE payroll_id = 'PAYROLL-1'
    `).get().employee_notification_error;
    assert.deepEqual(JSON.parse(error), {
      code: 'proof_missing',
      proof_id: 'PROOF-USDT'
    });
    assert.doesNotMatch(error, /usdt-key|PRIVATE-BOT-TOKEN/);
  } finally {
    telegram.restore();
    fixtureValue.database.close();
  }
});

test('a Telegram proof API error is checkpointed only as a safe retryable code', async () => {
  const fixtureValue = fixture();
  const telegram = installTelegram({ failPhoto: true });
  try {
    await assert.rejects(
      deliverPaymentAttempt(
        fixtureValue.env, 'ADMIN-1', 'ATTEMPT-1', new Date('2026-07-16T04:00:00.000Z')
      ),
      /payroll notification failed/
    );
    assert.equal(fixtureValue.database.prepare(`
      SELECT COUNT(*) AS count FROM payroll_payment_proofs
      WHERE telegram_delivered_at IS NOT NULL
    `).get().count, 0);
    const error = fixtureValue.database.prepare(`
      SELECT employee_notification_error FROM payroll_disbursements
      WHERE payroll_id = 'PAYROLL-1'
    `).get().employee_notification_error;
    assert.deepEqual(JSON.parse(error), {
      code: 'proof_telegram_failed',
      proof_id: 'PROOF-BANK'
    });
    assert.doesNotMatch(error, /private Telegram proof detail|PRIVATE-BOT-TOKEN/);
    assert.doesNotMatch(JSON.stringify(fixtureValue.database.prepare(`
      SELECT * FROM bot_logs
    `).all()), /private Telegram proof detail|PRIVATE-BOT-TOKEN/);
  } finally {
    telegram.restore();
    fixtureValue.database.close();
  }
});

test('a persistent delivery lease prevents concurrent proof and summary sends', async () => {
  const fixtureValue = fixture();
  let enteredResolve;
  let releaseResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  const telegram = installTelegram({
    async waitForFirstPhoto() {
      enteredResolve();
      await release;
    }
  });
  try {
    const first = deliverPaymentAttempt(
      fixtureValue.env, 'ADMIN-1', 'ATTEMPT-1', new Date('2026-07-16T04:00:00.000Z')
    );
    await entered;
    await assert.rejects(
      deliverPaymentAttempt(
        fixtureValue.env, 'ADMIN-1', 'ATTEMPT-1', new Date('2026-07-16T04:00:01.000Z')
      ),
      /delivery in progress/
    );
    releaseResolve();
    assert.equal((await first).status, 'sent');
    assert.equal(telegram.calls.filter((call) => call.method === 'sendPhoto').length, 2);
    assert.equal(telegram.calls.filter((call) => call.method === 'sendMessage').length, 1);
  } finally {
    telegram.restore();
    fixtureValue.database.close();
  }
});

test('an expired worker is fenced after an in-flight photo while its successor completes', async () => {
  const fixtureValue = fixture();
  let nowIso = '2026-07-16T04:00:00.000Z';
  let firstPhotoResolve;
  let releaseFirstResolve;
  const firstPhoto = new Promise((resolve) => { firstPhotoResolve = resolve; });
  const releaseFirst = new Promise((resolve) => { releaseFirstResolve = resolve; });
  let callNumber = 0;
  let successorFinished = false;
  let staleWrites = 0;
  fixtureValue.env.DB = createD1(fixtureValue.database, {
    beforeRun() {
      if (successorFinished) staleWrites += 1;
    },
    beforeBatchStatement() {
      if (successorFinished) staleWrites += 1;
    }
  });
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    callNumber += 1;
    const method = String(url).split('/').pop();
    calls.push(method);
    if (callNumber === 1) {
      firstPhotoResolve();
      await releaseFirst;
    }
    if (method === 'sendPhoto' && options.body instanceof FormData) {
      return { json: async () => ({
        ok: true,
        result: { photo: [{ file_id: 'TG-B', file_size: 33 }] }
      }) };
    }
    return { json: async () => ({ ok: true, result: { message_id: callNumber } }) };
  };
  try {
    const staleWorker = deliverPaymentAttempt(
      fixtureValue.env,
      'ADMIN-1',
      'ATTEMPT-1',
      () => new Date(nowIso)
    );
    await firstPhoto;
    nowIso = '2026-07-16T04:16:00.000Z';
    let successor;
    let successorError = null;
    try {
      successor = await deliverPaymentAttempt(
        fixtureValue.env,
        'ADMIN-1',
        'ATTEMPT-1',
        () => new Date(nowIso)
      );
    } catch (error) {
      successorError = error;
    }
    successorFinished = true;
    releaseFirstResolve();
    const staleOutcome = await staleWorker.then(
      (value) => ({ value }),
      (error) => ({ error })
    );
    if (successorError) throw successorError;
    assert.equal(successor.status, 'sent');
    assert.match(staleOutcome.error && staleOutcome.error.message || '', /delivery lease lost/);

    assert.deepEqual(calls, ['sendPhoto', 'sendPhoto', 'sendPhoto', 'sendMessage']);
    assert.equal(staleWrites, 0);
    assert.equal(fixtureValue.database.prepare(`
      SELECT employee_notification_error FROM payroll_disbursements
      WHERE payroll_id = 'PAYROLL-1'
    `).get().employee_notification_error, null);
    const deliveryActions = fixtureValue.database.prepare(`
      SELECT action FROM admin_audit_logs
      WHERE target_id = 'PAYROLL-1'
      ORDER BY id
    `).all().map((row) => row.action);
    assert.equal(deliveryActions.at(-1), 'payroll_notification_sent');
    assert.equal(deliveryActions.includes('payroll_notification_failed'), false);
    assert.ok(fixtureValue.database.prepare(`
      SELECT COUNT(DISTINCT json_extract(details_json, '$.lease_token')) AS tokens
      FROM admin_audit_logs
      WHERE action = 'payroll_notification_delivery_claimed'
    `).get().tokens === 2);
  } finally {
    globalThis.fetch = originalFetch;
    fixtureValue.database.close();
  }
});

test('a non-current same-key replay returns its stored delivery result without Telegram', async () => {
  const key = 'old-attempt-key';
  const fixtureValue = fixture({ idempotencyHash: await hashKey(key) });
  const telegram = installTelegram();
  try {
    fixtureValue.database.exec(`
      UPDATE payroll_payment_proofs
      SET telegram_delivered_at = '2026-07-16T04:00:00.000Z';
      INSERT INTO payroll_payment_attempts (
        attempt_id, payroll_id, version, status,
        bank_micros, usdt_micros, cash_micros, created_at, updated_at
      ) VALUES (
        'ATTEMPT-2', 'PAYROLL-1', 3, 'submitted',
        100000000, 0, 0,
        '2026-07-16T05:00:00.000Z', '2026-07-16T05:00:00.000Z'
      );
      UPDATE payroll_disbursements
      SET current_payment_attempt_id = 'ATTEMPT-2', payment_sent_at = NULL
      WHERE payroll_id = 'PAYROLL-1';
      INSERT INTO admin_audit_logs (
        store_id, admin_id, action, target_id, details_json, created_at
      ) VALUES (
        'STORE-1', 'ADMIN-1', 'payroll_notification_sent', 'PAYROLL-1',
        '{"attempt_id":"ATTEMPT-1","version":2}',
        '2026-07-16T04:00:00.000Z'
      );
    `);
    const response = await manageRequest(
      fixtureValue.env,
      '/api/manage/stores/STORE-1/payroll/PAYROLL-1/attempts/ATTEMPT-1/submit',
      { idempotencyKey: key }
    );
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).notification, {
      status: 'sent', retryable: false
    });
    assert.equal(telegram.calls.length, 0);
  } finally {
    telegram.restore();
    fixtureValue.database.close();
  }
});

test('a migrated non-current replay with no delivery state is safe and never retryable', async () => {
  const key = 'migrated-old-key';
  const fixtureValue = fixture({ idempotencyHash: await hashKey(key) });
  const telegram = installTelegram();
  try {
    fixtureValue.database.exec(`
      INSERT INTO payroll_payment_attempts (
        attempt_id, payroll_id, version, status,
        bank_micros, usdt_micros, cash_micros, created_at, updated_at
      ) VALUES (
        'ATTEMPT-2', 'PAYROLL-1', 3, 'draft',
        100000000, 0, 0,
        '2026-07-16T05:00:00.000Z', '2026-07-16T05:00:00.000Z'
      );
      UPDATE payroll_disbursements
      SET current_payment_attempt_id = 'ATTEMPT-2',
          status = 'awaiting_admin_payment', payment_sent_at = NULL
      WHERE payroll_id = 'PAYROLL-1';
    `);
    const response = await manageRequest(
      fixtureValue.env,
      '/api/manage/stores/STORE-1/payroll/PAYROLL-1/attempts/ATTEMPT-1/submit',
      { idempotencyKey: key }
    );
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).notification, {
      status: 'not_recorded', retryable: false
    });
    assert.equal(telegram.calls.length, 0);
  } finally {
    telegram.restore();
    fixtureValue.database.close();
  }
});

test('a non-current failed delivery replay stays failed and cannot be retried', async () => {
  const key = 'failed-old-key';
  const fixtureValue = fixture({ idempotencyHash: await hashKey(key) });
  const telegram = installTelegram();
  try {
    fixtureValue.database.exec(`
      INSERT INTO payroll_payment_attempts (
        attempt_id, payroll_id, version, status,
        bank_micros, usdt_micros, cash_micros, created_at, updated_at
      ) VALUES (
        'ATTEMPT-2', 'PAYROLL-1', 3, 'draft',
        100000000, 0, 0,
        '2026-07-16T05:00:00.000Z', '2026-07-16T05:00:00.000Z'
      );
      UPDATE payroll_disbursements
      SET current_payment_attempt_id = 'ATTEMPT-2',
          status = 'awaiting_admin_payment', payment_sent_at = NULL
      WHERE payroll_id = 'PAYROLL-1';
      INSERT INTO admin_audit_logs (
        store_id, admin_id, action, target_id, details_json, created_at
      ) VALUES (
        'STORE-1', 'ADMIN-1', 'payroll_notification_failed', 'PAYROLL-1',
        '{"attempt_id":"ATTEMPT-1","version":2,"code":"proof_missing"}',
        '2026-07-16T04:00:00.000Z'
      );
    `);
    const response = await manageRequest(
      fixtureValue.env,
      '/api/manage/stores/STORE-1/payroll/PAYROLL-1/attempts/ATTEMPT-1/submit',
      { idempotencyKey: key }
    );
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).notification, {
      status: 'failed', retryable: false
    });
    assert.equal(telegram.calls.length, 0);
  } finally {
    telegram.restore();
    fixtureValue.database.close();
  }
});

test('missing payment proofs return a stable client error and leave the draft claimed', async () => {
  const fixtureValue = fixture({ attemptStatus: 'draft', claim: true });
  const telegram = installTelegram();
  try {
    fixtureValue.database.exec(`
      DELETE FROM payroll_payment_proofs WHERE method = 'usdt';
    `);
    const response = await manageRequest(
      fixtureValue.env,
      '/api/manage/stores/STORE-1/payroll/PAYROLL-1/attempts/ATTEMPT-1/submit',
      { idempotencyKey: 'missing-proof-key' }
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: 'payroll_proofs_incomplete',
      missing_methods: ['usdt']
    });
    assert.equal(fixtureValue.database.prepare(`
      SELECT status FROM payroll_payment_attempts WHERE attempt_id = 'ATTEMPT-1'
    `).get().status, 'draft');
    assert.equal(fixtureValue.database.prepare(`
      SELECT COUNT(*) AS count FROM admin_task_claims
      WHERE task_type = 'payroll' AND task_id = 'PAYROLL-1'
    `).get().count, 1);
    assert.equal(telegram.calls.length, 0);
  } finally {
    telegram.restore();
    fixtureValue.database.close();
  }
});

test('R2 delivery rejects oversized streams, metadata mismatch, and invalid image bytes before Telegram', async (context) => {
  await context.test('bounded stream cancels after the database size', async () => {
    const fixtureValue = fixture();
    let cancelled = false;
    const chunks = [pngBytes(), new Uint8Array([1])];
    fixtureValue.env.PAYROLL_PROOFS.get = async () => ({
      body: {
        getReader() {
          return {
            async read() {
              return chunks.length
                ? { done: false, value: chunks.shift() }
                : { done: true, value: undefined };
            },
            async cancel() { cancelled = true; },
            releaseLock() {}
          };
        }
      }
    });
    const telegram = installTelegram();
    try {
      await assert.rejects(
        deliverPaymentAttempt(
          fixtureValue.env, 'ADMIN-1', 'ATTEMPT-1', new Date('2026-07-16T04:00:00.000Z')
        ),
        /payroll notification failed/
      );
      assert.equal(cancelled, true);
      assert.equal(telegram.calls.length, 1);
      assert.equal(fixtureValue.database.prepare(`
        SELECT telegram_delivered_at FROM payroll_payment_proofs
        WHERE proof_id = 'PROOF-USDT'
      `).get().telegram_delivered_at, null);
      assert.deepEqual(JSON.parse(fixtureValue.database.prepare(`
        SELECT employee_notification_error FROM payroll_disbursements
        WHERE payroll_id = 'PAYROLL-1'
      `).get().employee_notification_error), {
        code: 'proof_size_mismatch', proof_id: 'PROOF-USDT'
      });
    } finally {
      telegram.restore();
      fixtureValue.database.close();
    }
  });

  await context.test('invalid DB MIME avoids the private object read', async () => {
    const fixtureValue = fixture();
    fixtureValue.database.prepare(`
      UPDATE payroll_payment_proofs SET mime_type = 'application/octet-stream'
      WHERE proof_id = 'PROOF-USDT'
    `).run();
    let r2Reads = 0;
    fixtureValue.env.PAYROLL_PROOFS.get = async () => { r2Reads += 1; return null; };
    const telegram = installTelegram();
    try {
      await assert.rejects(
        deliverPaymentAttempt(
          fixtureValue.env, 'ADMIN-1', 'ATTEMPT-1', new Date('2026-07-16T04:00:00.000Z')
        ),
        /payroll notification failed/
      );
      assert.equal(r2Reads, 0);
      assert.equal(telegram.calls.length, 1);
    } finally {
      telegram.restore();
      fixtureValue.database.close();
    }
  });

  await context.test('reported object size and image magic must match metadata', async () => {
    const fixtureValue = fixture();
    let arrayBufferReads = 0;
    fixtureValue.env.PAYROLL_PROOFS.get = async () => ({
      size: 33,
      async arrayBuffer() {
        arrayBufferReads += 1;
        return new Uint8Array(33).buffer;
      }
    });
    const telegram = installTelegram();
    try {
      await assert.rejects(
        deliverPaymentAttempt(
          fixtureValue.env, 'ADMIN-1', 'ATTEMPT-1', new Date('2026-07-16T04:00:00.000Z')
        ),
        /payroll notification failed/
      );
      assert.equal(arrayBufferReads, 1);
      assert.equal(telegram.calls.length, 1);
      assert.deepEqual(JSON.parse(fixtureValue.database.prepare(`
        SELECT employee_notification_error FROM payroll_disbursements
        WHERE payroll_id = 'PAYROLL-1'
      `).get().employee_notification_error), {
        code: 'proof_bytes_invalid', proof_id: 'PROOF-USDT'
      });
    } finally {
      telegram.restore();
      fixtureValue.database.close();
    }
  });

  await context.test('arrayBuffer fallback requires a trusted reported size', async () => {
    const fixtureValue = fixture();
    let arrayBufferReads = 0;
    fixtureValue.env.PAYROLL_PROOFS.get = async () => ({
      async arrayBuffer() {
        arrayBufferReads += 1;
        return pngBytes().buffer;
      }
    });
    const telegram = installTelegram();
    try {
      await assert.rejects(
        deliverPaymentAttempt(
          fixtureValue.env, 'ADMIN-1', 'ATTEMPT-1', new Date('2026-07-16T04:00:00.000Z')
        ),
        /payroll notification failed/
      );
      assert.equal(arrayBufferReads, 0);
      assert.equal(telegram.calls.length, 1);
      assert.deepEqual(JSON.parse(fixtureValue.database.prepare(`
        SELECT employee_notification_error FROM payroll_disbursements
        WHERE payroll_id = 'PAYROLL-1'
      `).get().employee_notification_error), {
        code: 'proof_unreadable', proof_id: 'PROOF-USDT'
      });
    } finally {
      telegram.restore();
      fixtureValue.database.close();
    }
  });

  await context.test('reported size mismatch stops before reading object bytes', async () => {
    const fixtureValue = fixture();
    let arrayBufferReads = 0;
    fixtureValue.env.PAYROLL_PROOFS.get = async () => ({
      size: 34,
      async arrayBuffer() {
        arrayBufferReads += 1;
        return pngBytes().buffer;
      }
    });
    const telegram = installTelegram();
    try {
      await assert.rejects(
        deliverPaymentAttempt(
          fixtureValue.env, 'ADMIN-1', 'ATTEMPT-1', new Date('2026-07-16T04:00:00.000Z')
        ),
        /payroll notification failed/
      );
      assert.equal(arrayBufferReads, 0);
      assert.equal(telegram.calls.length, 1);
      assert.deepEqual(JSON.parse(fixtureValue.database.prepare(`
        SELECT employee_notification_error FROM payroll_disbursements
        WHERE payroll_id = 'PAYROLL-1'
      `).get().employee_notification_error), {
        code: 'proof_size_mismatch', proof_id: 'PROOF-USDT'
      });
    } finally {
      telegram.restore();
      fixtureValue.database.close();
    }
  });
});
