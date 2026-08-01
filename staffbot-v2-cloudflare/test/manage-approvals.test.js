import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import worker from '../src/index.js';
import { createD1 } from './helpers/d1.js';

const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
const ids = {
  income: 'INC-1',
  leave: 'LEAVE-1',
  absence: 'ABS-1',
  advance: 'ADV-1'
};
const tables = {
  income: 'pending_income',
  leave: 'leave_requests',
  absence: 'absence_fine_requests',
  advance: 'salary_advance_requests'
};

function setup() {
  const database = new DatabaseSync(':memory:');
  database.exec(schema);
  database.exec(`
    INSERT INTO stores (
      store_id, name, status, timezone, currency, created_at, updated_at
    ) VALUES
      ('STORE-1', 'Tokyo Club', 'active', 'Asia/Tokyo', '$',
        '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z'),
      ('STORE-2', 'Osaka Club', 'active', 'Asia/Tokyo', '$',
        '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z');

    INSERT INTO store_members (
      store_id, telegram_id, display_name, role, status, commission_rate,
      cycle_start, joined_at, absence_check_enabled, updated_at
    ) VALUES
      ('STORE-1', 'ADMIN-1', 'Manager', 'admin', 'active', 0.6,
        '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 1,
        '2026-07-01T00:00:00.000Z'),
      ('STORE-1', 'EMP-INCOME', 'Alice', 'employee', 'active', 0.6,
        '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 1,
        '2026-07-01T00:00:00.000Z'),
      ('STORE-1', 'EMP-LEAVE', 'Bob', 'employee', 'active', 0.6,
        '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 1,
        '2026-07-01T00:00:00.000Z'),
      ('STORE-1', 'EMP-ABSENCE', 'Carol', 'employee', 'active', 0.6,
        '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 1,
        '2026-07-01T00:00:00.000Z'),
      ('STORE-1', 'EMP-ADVANCE', 'Dan', 'employee', 'active', 0.6,
        '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 1,
        '2026-07-01T00:00:00.000Z');

    INSERT INTO user_preferences (telegram_id, language, updated_at) VALUES
      ('EMP-INCOME', 'en', '2026-07-29T00:00:00.000Z'),
      ('EMP-LEAVE', 'en', '2026-07-29T00:00:00.000Z'),
      ('EMP-ABSENCE', 'en', '2026-07-29T00:00:00.000Z'),
      ('EMP-ADVANCE', 'en', '2026-07-29T00:00:00.000Z');

    INSERT INTO admin_sessions (
      token, telegram_id, expires_at, created_at, csrf_token
    ) VALUES (
      'SESSION-1', 'ADMIN-1', '2099-01-01T00:00:00.000Z',
      '2026-07-29T00:00:00.000Z', 'CSRF-1'
    );

    INSERT INTO pending_income (
      request_id, store_id, telegram_id, income, commission_rate,
      commission_income, fine, status, submitted_at
    ) VALUES (
      'INC-1', 'STORE-1', 'EMP-INCOME', 100, 0.6,
      60, 0, 'pending', '2026-07-29T01:00:00.000Z'
    );

    INSERT INTO leave_requests (
      request_id, store_id, telegram_id, leave_date, status, requested_at
    ) VALUES (
      'LEAVE-1', 'STORE-1', 'EMP-LEAVE', '2026-08-03', 'pending',
      '2026-07-29T01:01:00.000Z'
    );

    INSERT INTO absence_fine_requests (
      request_id, store_id, telegram_id, business_date,
      original_fine, fine, status, created_at
    ) VALUES (
      'ABS-1', 'STORE-1', 'EMP-ABSENCE', '2026-07-28',
      10, 10, 'pending', '2026-07-29T01:02:00.000Z'
    );

    INSERT INTO income_records (
      record_id, store_id, telegram_id, income, commission_rate,
      commission_income, original_fine, fine, type, source,
      request_id, approved_at, admin_id
    ) VALUES (
      'REC-ADVANCE-SEED', 'STORE-1', 'EMP-ADVANCE', 100, 0.6,
      60, 0, 0, 'income', 'manual', 'INC-ADVANCE-SEED',
      '2026-07-29T00:30:00.000Z', 'SEED'
    );

    INSERT INTO salary_advance_requests (
      request_id, store_id, telegram_id, amount, status, requested_at
    ) VALUES (
      'ADV-1', 'STORE-1', 'EMP-ADVANCE', 20, 'pending',
      '2026-07-29T01:03:00.000Z'
    );

    INSERT INTO admin_audit_logs (
      store_id, admin_id, action, target_id, details_json, created_at
    ) VALUES (
      'STORE-1', 'ADMIN-0', 'approval_opened', 'INC-1',
      '{"source":"seed"}', '2026-07-29T01:05:00.000Z'
    );
  `);
  return {
    database,
    env: {
      ADMIN_IDS: 'GLOBAL-ADMIN',
      BOT_TOKEN: 'test-token',
      ENVIRONMENT: 'production',
      DB: createD1(database)
    }
  };
}

function manageRequest(env, path, { method = 'GET', body } = {}) {
  return worker.fetch(new Request(`https://staffbot.test${path}`, {
    method,
    headers: {
      cookie: 'staffbot_admin_session=SESSION-1',
      'content-type': 'application/json',
      ...(method === 'GET' ? {} : { 'x-csrf-token': 'CSRF-1' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  }), env, { waitUntil() {} });
}

function managePost(env, path, body = {}) {
  return manageRequest(env, path, { method: 'POST', body });
}

async function claim(env, type, id = ids[type]) {
  const response = await managePost(
    env,
    `/api/manage/tasks/${type}/${id}/claim`
  );
  assert.equal(response.status, 200);
}

function telegramFetch(result = { ok: true, result: { message_id: 1 } }) {
  return async () => new Response(JSON.stringify(result), {
    headers: { 'content-type': 'application/json' }
  });
}

test('authorized approval detail includes source facts and audit history', async () => {
  const fixture = setup();
  try {
    const response = await manageRequest(
      fixture.env,
      '/api/manage/stores/STORE-1/approvals/income/INC-1'
    );
    const detail = await response.json();

    assert.equal(response.status, 200);
    assert.equal(detail.task.task_type, 'income');
    assert.equal(detail.task.task_id, 'INC-1');
    assert.equal(detail.request.income, 100);
    assert.equal(detail.request.commission_income, 60);
    assert.deepEqual(detail.employee, {
      telegram_id: 'EMP-INCOME',
      display_name: 'Alice',
      language: 'en'
    });
    assert.equal(detail.store.name, 'Tokyo Club');
    assert.deepEqual(detail.attachments, []);
    assert.deepEqual(detail.history.map((row) => row.action), ['approval_opened']);
    assert.equal(Object.hasOwn(detail.request, 'raw_storage_key'), false);
  } finally {
    fixture.database.close();
  }
});

test('approval detail refuses a store path that does not own the record', async () => {
  const fixture = setup();
  try {
    const response = await manageRequest(
      fixture.env,
      '/api/manage/stores/STORE-2/approvals/income/INC-1'
    );

    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, 'not_found');
  } finally {
    fixture.database.close();
  }
});

for (const type of ['income', 'leave', 'absence', 'advance']) {
  test(`${type} approval requires the current task claim`, async () => {
    const fixture = setup();
    try {
      const response = await managePost(
        fixture.env,
        `/api/manage/stores/STORE-1/approvals/${type}/${ids[type]}/approve`
      );

      assert.equal(response.status, 409);
      assert.equal((await response.json()).error, 'task_claim_required');
      assert.equal(
        fixture.database.prepare(`SELECT status FROM ${tables[type]} WHERE request_id = ?`).get(ids[type]).status,
        'pending'
      );
    } finally {
      fixture.database.close();
    }
  });
}

for (const type of ['income', 'leave', 'absence', 'advance']) {
  test(`${type} approval with a claim changes the business record exactly once`, async () => {
    const fixture = setup();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = telegramFetch();
    try {
      await claim(fixture.env, type);
      const response = await managePost(
        fixture.env,
        `/api/manage/stores/STORE-1/approvals/${type}/${ids[type]}/approve`
      );
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.notification.status, 'sent');
      assert.equal(
        fixture.database.prepare(`SELECT status FROM ${tables[type]} WHERE request_id = ?`).get(ids[type]).status,
        'approved'
      );
      assert.equal(
        fixture.database.prepare(`SELECT COUNT(*) AS total FROM admin_task_claims WHERE task_type = ? AND task_id = ?`).get(type, ids[type]).total,
        0
      );

      const replay = await managePost(
        fixture.env,
        `/api/manage/stores/STORE-1/approvals/${type}/${ids[type]}/approve`
      );
      assert.equal(replay.status, 409);
      assert.equal((await replay.json()).error, 'already_decided');
      assert.equal(
        fixture.database.prepare(`SELECT COUNT(*) AS total FROM ${tables[type]} WHERE request_id = ? AND status = 'approved'`).get(ids[type]).total,
        1
      );
    } finally {
      globalThis.fetch = originalFetch;
      fixture.database.close();
    }
  });
}

for (const type of ['income', 'leave', 'absence', 'advance']) {
  test(`${type} rejection requires a non-blank reason`, async () => {
    const fixture = setup();
    try {
      await claim(fixture.env, type);
      const response = await managePost(
        fixture.env,
        `/api/manage/stores/STORE-1/approvals/${type}/${ids[type]}/reject`,
        { reason: '   ' }
      );

      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, 'rejection_reason_required');
      assert.equal(
        fixture.database.prepare(`SELECT status FROM ${tables[type]} WHERE request_id = ?`).get(ids[type]).status,
        'pending'
      );
      assert.equal(
        fixture.database.prepare(`SELECT COUNT(*) AS total FROM admin_task_claims WHERE task_type = ? AND task_id = ?`).get(type, ids[type]).total,
        1
      );
    } finally {
      fixture.database.close();
    }
  });
}

test('Telegram failure does not undo a committed decision and is safely audited', async () => {
  const fixture = setup();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = telegramFetch({
    ok: false,
    error_code: 429,
    description: 'Too Many Requests: retry later'
  });
  try {
    await claim(fixture.env, 'income');
    const response = await managePost(
      fixture.env,
      '/api/manage/stores/STORE-1/approvals/income/INC-1/reject',
      { reason: 'Receipt unreadable' }
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      ok: true,
      notification: { status: 'failed', retryable: true }
    });
    assert.deepEqual(
      { ...fixture.database.prepare(`
        SELECT status, reject_reason FROM pending_income WHERE request_id = 'INC-1'
      `).get() },
      { status: 'rejected', reject_reason: 'Receipt unreadable' }
    );
    const audit = fixture.database.prepare(`
      SELECT action, details_json FROM admin_audit_logs
      WHERE target_id = 'INC-1' ORDER BY id DESC LIMIT 1
    `).get();
    assert.equal(audit.action, 'approval_notification_failed');
    assert.deepEqual(JSON.parse(audit.details_json), {
      task_type: 'income',
      recipient: 'EMP-INCOME',
      decision: 'rejected',
      telegram: {
        error_code: 429,
        description: 'Too Many Requests: retry later'
      }
    });
    assert.equal(
      fixture.database.prepare(`
        SELECT COUNT(*) AS total FROM bot_logs
        WHERE event = 'approval_notification_failed'
      `).get().total,
      1
    );
  } finally {
    globalThis.fetch = originalFetch;
    fixture.database.close();
  }
});

test('failed result delivery retries from the decided row', async () => {
  const fixture = setup();
  const originalFetch = globalThis.fetch;
  const messages = [];
  const results = [
    { ok: false, error_code: 500, description: 'temporary failure' },
    { ok: true, result: { message_id: 2 } }
  ];
  globalThis.fetch = async (_url, init) => {
    messages.push(JSON.parse(init.body).text);
    return new Response(JSON.stringify(results.shift()), {
      headers: { 'content-type': 'application/json' }
    });
  };
  try {
    await claim(fixture.env, 'leave');
    const decided = await managePost(
      fixture.env,
      '/api/manage/stores/STORE-1/approvals/leave/LEAVE-1/reject',
      { reason: 'Coverage unavailable' }
    );
    assert.equal((await decided.json()).notification.status, 'failed');

    const retry = await managePost(
      fixture.env,
      '/api/manage/stores/STORE-1/approvals/leave/LEAVE-1/notify/retry'
    );
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), {
      ok: true,
      notification: { status: 'sent', retryable: false }
    });
    assert.equal(messages.length, 2);
    assert.equal(messages[1], messages[0]);
    assert.match(messages[1], /Coverage unavailable/);
    assert.equal(
      fixture.database.prepare(`
        SELECT COUNT(*) AS total FROM admin_audit_logs
        WHERE action = 'approval_notification_retried'
          AND target_id = 'LEAVE-1'
      `).get().total,
      1
    );
  } finally {
    globalThis.fetch = originalFetch;
    fixture.database.close();
  }
});

test('notification retry refuses pending and cross-store records', async () => {
  const fixture = setup();
  try {
    const pending = await managePost(
      fixture.env,
      '/api/manage/stores/STORE-1/approvals/income/INC-1/notify/retry'
    );
    const crossStore = await managePost(
      fixture.env,
      '/api/manage/stores/STORE-2/approvals/income/INC-1/notify/retry'
    );

    assert.equal(pending.status, 409);
    assert.equal((await pending.json()).error, 'decision_required');
    assert.equal(crossStore.status, 404);
    assert.equal((await crossStore.json()).error, 'not_found');
  } finally {
    fixture.database.close();
  }
});

for (const type of ['income', 'leave', 'absence', 'advance']) {
  test(`${type} decision cannot commit after its validated claim is taken over`, async () => {
    const fixture = setup();
    const originalFetch = globalThis.fetch;
    let sends = 0;
    globalThis.fetch = async (...args) => {
      sends += 1;
      return telegramFetch()(...args);
    };
    try {
      await claim(fixture.env, type);
      let takenOver = false;
      fixture.env.DB = createD1(fixture.database, {
        afterFirst(sql) {
          if (
            takenOver
            || !sql.includes('SELECT * FROM admin_task_claims')
            || !sql.includes('AND claimed_by = ?')
          ) return;
          takenOver = true;
          fixture.database.prepare(`
            UPDATE admin_task_claims
            SET claimed_by = 'ADMIN-2',
                claimed_at = '2026-08-01T01:00:00.000Z',
                lease_expires_at = '2099-01-01T01:15:00.000Z',
                updated_at = '2026-08-01T01:00:00.000Z'
            WHERE task_type = ? AND task_id = ?
          `).run(type, ids[type]);
        }
      });

      const response = await managePost(
        fixture.env,
        `/api/manage/stores/STORE-1/approvals/${type}/${ids[type]}/approve`
      );

      assert.equal(response.status, 409);
      assert.equal((await response.json()).error, 'task_claim_required');
      assert.equal(
        fixture.database.prepare(`
          SELECT status FROM ${tables[type]} WHERE request_id = ?
        `).get(ids[type]).status,
        'pending'
      );
      assert.equal(
        fixture.database.prepare(`
          SELECT claimed_by FROM admin_task_claims
          WHERE task_type = ? AND task_id = ?
        `).get(type, ids[type]).claimed_by,
        'ADMIN-2'
      );
      assert.equal(sends, 0);
    } finally {
      globalThis.fetch = originalFetch;
      fixture.database.close();
    }
  });
}

test('income decision cannot commit after its validated claim expires', async () => {
  const fixture = setup();
  const originalFetch = globalThis.fetch;
  let sends = 0;
  globalThis.fetch = async (...args) => {
    sends += 1;
    return telegramFetch()(...args);
  };
  try {
    await claim(fixture.env, 'income');
    let expired = false;
    fixture.env.DB = createD1(fixture.database, {
      async afterFirst(sql) {
        if (
          expired
          || !sql.includes('SELECT * FROM admin_task_claims')
          || !sql.includes('AND claimed_by = ?')
        ) return;
        expired = true;
        fixture.database.prepare(`
          UPDATE admin_task_claims
          SET lease_expires_at = ?
          WHERE task_type = 'income' AND task_id = 'INC-1'
        `).run(new Date(Date.now() + 5).toISOString());
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    });

    const response = await managePost(
      fixture.env,
      '/api/manage/stores/STORE-1/approvals/income/INC-1/approve'
    );

    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'task_claim_required');
    assert.equal(
      fixture.database.prepare(`
        SELECT status FROM pending_income WHERE request_id = 'INC-1'
      `).get().status,
      'pending'
    );
    assert.equal(sends, 0);
  } finally {
    globalThis.fetch = originalFetch;
    fixture.database.close();
  }
});

test('notification retry is unavailable after an already successful delivery', async () => {
  const fixture = setup();
  const originalFetch = globalThis.fetch;
  let sends = 0;
  globalThis.fetch = async (...args) => {
    sends += 1;
    return telegramFetch()(...args);
  };
  try {
    await claim(fixture.env, 'income');
    const decided = await managePost(
      fixture.env,
      '/api/manage/stores/STORE-1/approvals/income/INC-1/approve'
    );
    assert.equal(decided.status, 200);
    assert.equal((await decided.json()).notification.status, 'sent');

    const retry = await managePost(
      fixture.env,
      '/api/manage/stores/STORE-1/approvals/income/INC-1/notify/retry'
    );

    assert.equal(retry.status, 409);
    assert.equal((await retry.json()).error, 'notification_retry_not_available');
    assert.equal(sends, 1);
  } finally {
    globalThis.fetch = originalFetch;
    fixture.database.close();
  }
});

test('concurrent notification retries atomically claim one employee delivery', async () => {
  const fixture = setup();
  const originalFetch = globalThis.fetch;
  let releaseFirst;
  let firstRetry;
  let firstStarted;
  const firstSendStarted = new Promise((resolve) => { firstStarted = resolve; });
  globalThis.fetch = telegramFetch({
    ok: false,
    error_code: 500,
    description: 'temporary failure'
  });
  try {
    await claim(fixture.env, 'leave');
    const decided = await managePost(
      fixture.env,
      '/api/manage/stores/STORE-1/approvals/leave/LEAVE-1/reject',
      { reason: 'Coverage unavailable' }
    );
    assert.equal((await decided.json()).notification.status, 'failed');

    let sends = 0;
    globalThis.fetch = async () => {
      sends += 1;
      if (sends === 1) {
        firstStarted();
        await new Promise((resolve) => { releaseFirst = resolve; });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: sends } }), {
        headers: { 'content-type': 'application/json' }
      });
    };

    firstRetry = managePost(
      fixture.env,
      '/api/manage/stores/STORE-1/approvals/leave/LEAVE-1/notify/retry'
    );
    await firstSendStarted;
    const concurrentRetry = await managePost(
      fixture.env,
      '/api/manage/stores/STORE-1/approvals/leave/LEAVE-1/notify/retry'
    );
    assert.deepEqual(await concurrentRetry.json(), {
      ok: true,
      notification: { status: 'retrying', retryable: false }
    });

    releaseFirst();
    const completed = await firstRetry;
    assert.equal((await completed.json()).notification.status, 'sent');

    const replay = await managePost(
      fixture.env,
      '/api/manage/stores/STORE-1/approvals/leave/LEAVE-1/notify/retry'
    );
    assert.deepEqual(await replay.json(), {
      ok: true,
      notification: { status: 'sent', retryable: false }
    });
    assert.equal(sends, 1);
    assert.equal(
      fixture.database.prepare(`
        SELECT COUNT(*) AS total FROM admin_audit_logs
        WHERE target_id = 'LEAVE-1'
          AND action = 'approval_notification_retry_claimed'
      `).get().total,
      1
    );
  } finally {
    if (releaseFirst) releaseFirst();
    if (firstRetry) await firstRetry.catch(() => {});
    globalThis.fetch = originalFetch;
    fixture.database.close();
  }
});

test('leave approval stays successful when its related absence was already cancelled', async () => {
  const fixture = setup();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = telegramFetch();
  try {
    fixture.database.prepare(`
      INSERT INTO absence_fine_requests (
        request_id, store_id, telegram_id, business_date,
        original_fine, fine, status, created_at
      ) VALUES (
        'ABS-LEAVE-RACE', 'STORE-1', 'EMP-LEAVE', '2026-08-03',
        10, 10, 'pending', '2026-07-29T01:04:00.000Z'
      )
    `).run();
    await claim(fixture.env, 'leave');
    let cancelled = false;
    fixture.env.DB = createD1(fixture.database, {
      beforeBatchStatement(sql) {
        if (cancelled || !sql.includes('UPDATE leave_requests SET status =')) return;
        cancelled = true;
        fixture.database.prepare(`
          UPDATE absence_fine_requests
          SET status = 'cancelled', cancellation_reason = 'Approved elsewhere'
          WHERE request_id = 'ABS-LEAVE-RACE'
        `).run();
      }
    });

    const response = await managePost(
      fixture.env,
      '/api/manage/stores/STORE-1/approvals/leave/LEAVE-1/approve'
    );

    assert.equal(response.status, 200);
    assert.equal((await response.json()).notification.status, 'sent');
    assert.equal(
      fixture.database.prepare(`
        SELECT status FROM leave_requests WHERE request_id = 'LEAVE-1'
      `).get().status,
      'approved'
    );
    assert.equal(
      fixture.database.prepare(`
        SELECT COUNT(*) AS total FROM admin_task_claims
        WHERE task_type = 'leave' AND task_id = 'LEAVE-1'
      `).get().total,
      0
    );
    assert.equal(
      fixture.database.prepare(`
        SELECT COUNT(*) AS total FROM admin_audit_logs
        WHERE action = 'cancel_absence_for_leave'
          AND target_id = 'ABS-LEAVE-RACE'
      `).get().total,
      0
    );
  } finally {
    globalThis.fetch = originalFetch;
    fixture.database.close();
  }
});
