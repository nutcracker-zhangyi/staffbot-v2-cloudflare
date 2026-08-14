import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import worker from '../src/index.js';
import { createD1 } from './helpers/d1.js';

const schema = readFileSync(
  new URL('../db/schema.sql', import.meta.url),
  'utf8'
);

function adminFixture() {
  const database = new DatabaseSync(':memory:');
  database.exec(schema);
  database.exec(`
    INSERT INTO stores (
      store_id, name, status, timezone, currency, created_at, updated_at
    ) VALUES (
      'STORE-1', 'Tokyo Club', 'active', 'Asia/Tokyo', '¥',
      '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
    );
    INSERT INTO users (
      telegram_id, name, username, role, status,
      cycle_start, created_at, updated_at
    ) VALUES (
      'EMP-1', 'Alice', 'alice', 'employee', 'active',
      '2026-06-01T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z'
    );
    INSERT INTO store_members (
      store_id, telegram_id, display_name, role, status,
      commission_rate, cycle_start, joined_at,
      absence_check_enabled, absence_check_enabled_at, updated_at
    ) VALUES (
      'STORE-1', 'EMP-1', 'Alice', 'employee', 'active',
      0.6, '2026-06-01T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
      1, '2026-06-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z'
    );
    INSERT INTO admin_sessions (
      token, telegram_id, expires_at, created_at
    ) VALUES (
      'session-1', 'ADMIN-1',
      '2099-01-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z'
    );
  `);
  return {
    database,
    env: {
      ENVIRONMENT: 'staging',
      BOT_TOKEN: 'test-token',
      WEBHOOK_SECRET: 'test-secret',
      ADMIN_IDS: 'ADMIN-1',
      DB: createD1(database)
    }
  };
}

function memberRequest(body) {
  return new Request(
    'https://example.com/api/admin/stores/STORE-1/members',
    {
      method: 'POST',
      headers: {
        cookie: 'staffbot_admin_session=session-1',
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    }
  );
}

function memberBody(payrollStartDate) {
  return {
    telegram_id: 'EMP-1',
    name: 'Alice',
    username: 'alice',
    role: 'employee',
    status: 'active',
    commission_rate: 0.6,
    absence_check_enabled: true,
    payroll_start_date: payrollStartDate
  };
}

test('admin member list exposes payroll start and automation dates', async () => {
  const fixture = adminFixture();
  try {
    const response = await worker.fetch(new Request(
      'https://example.com/api/admin/stores/STORE-1/members?all=1',
      { headers: { cookie: 'staffbot_admin_session=session-1' } }
    ), fixture.env, { waitUntil() {} });
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.equal(result.members.length, 1);
    assert.equal(result.members[0].payroll_start_date, null);
    assert.equal(result.members[0].payroll_automation_started_at, null);
  } finally {
    fixture.database.close();
  }
});

test('admin starts payroll automation without replacing the current cycle boundary', async () => {
  const fixture = adminFixture();
  try {
    const before = new Date().toISOString();
    const response = await worker.fetch(
      memberRequest(memberBody('2026-04-03')),
      fixture.env,
      { waitUntil() {} }
    );
    const after = new Date().toISOString();
    const member = fixture.database.prepare(`
      SELECT
        cycle_start,
        payroll_start_date,
        payroll_automation_started_at
      FROM store_members
      WHERE store_id = 'STORE-1' AND telegram_id = 'EMP-1'
    `).get();

    assert.equal(response.status, 200);
    assert.equal(member.cycle_start, '2026-06-01T00:00:00.000Z');
    assert.equal(member.payroll_start_date, '2026-04-03');
    assert.ok(member.payroll_automation_started_at >= before);
    assert.ok(member.payroll_automation_started_at <= after);

    const firstStartedAt = member.payroll_automation_started_at;
    const secondResponse = await worker.fetch(
      memberRequest(memberBody('2026-04-03')),
      fixture.env,
      { waitUntil() {} }
    );
    assert.equal(secondResponse.status, 200);
    assert.equal(
      fixture.database.prepare(`
        SELECT payroll_automation_started_at
        FROM store_members
        WHERE store_id = 'STORE-1' AND telegram_id = 'EMP-1'
      `).get().payroll_automation_started_at,
      firstStartedAt
    );
  } finally {
    fixture.database.close();
  }
});

test('admin cannot clear or corrupt an active payroll start date', async () => {
  const fixture = adminFixture();
  try {
    fixture.database.prepare(`
      UPDATE store_members
      SET payroll_start_date = '2026-04-03',
          payroll_automation_started_at = '2026-07-01T00:00:00.000Z'
      WHERE store_id = 'STORE-1' AND telegram_id = 'EMP-1'
    `).run();

    for (const value of ['', '2026-02-30', 'not-a-date']) {
      const response = await worker.fetch(
        memberRequest(memberBody(value)),
        fixture.env,
        { waitUntil() {} }
      );
      assert.equal(response.status, 400);
    }
    assert.deepEqual(
      {
        ...fixture.database.prepare(`
          SELECT payroll_start_date, payroll_automation_started_at
          FROM store_members
          WHERE store_id = 'STORE-1' AND telegram_id = 'EMP-1'
        `).get()
      },
      {
        payroll_start_date: '2026-04-03',
        payroll_automation_started_at: '2026-07-01T00:00:00.000Z'
      }
    );
  } finally {
    fixture.database.close();
  }
});

test('admin document provides a first work date editor', async () => {
  const response = await worker.fetch(
    new Request('https://example.com/admin'),
    { ENVIRONMENT: 'staging' },
    { waitUntil() {} }
  );
  const document = await response.text();

  assert.match(document, /id="memberPayrollStartDate"/);
  assert.match(document, /payroll_start_date/);
  assert.match(document, /payroll_automation_started_at/);
  assert.match(document, /automatic_payroll/);
  assert.match(document, /legacy_salary_requests/);
  assert.match(document, /legacy_salary_records/);
  assert.match(document, /\/payroll\?page=/);
  assert.match(document, /data-payroll-detail/);
  assert.match(document, /savePayrollSplit/);
});

test('authorized admin reads a payroll proof with private cache headers', async () => {
  const fixture = adminFixture();
  try {
    fixture.database.exec(`
      INSERT INTO payroll_disbursements (
        payroll_id, store_id, telegram_id, payroll_start_date,
        scheduled_date, cycle_day, period_start, cutoff_at,
        amount_snapshot_micros, currency, status,
        created_at, updated_at
      ) VALUES (
        'PAYROLL-1', 'STORE-1', 'EMP-1', '2026-07-01',
        '2026-07-16', 16,
        '2026-07-01T00:00:00.000Z',
        '2026-07-16T03:00:00.000Z',
        1000000, '¥', 'awaiting_employee_confirmation',
        '2026-07-16T03:00:00.000Z',
        '2026-07-16T03:00:00.000Z'
      );
      INSERT INTO payroll_payment_proofs (
        proof_id, payroll_id, method, object_key,
        telegram_file_id, mime_type, size_bytes,
        sort_order, uploaded_by, uploaded_at
      ) VALUES (
        'PROOF-1', 'PAYROLL-1', 'bank', 'proof-key',
        'TG-FILE', 'image/jpeg', 2, 1,
        'ADMIN-1', '2026-07-16T04:00:00.000Z'
      );
    `);
    fixture.env.PAYROLL_PROOFS = {
      async get(key) {
        assert.equal(key, 'proof-key');
        return {
          body: new Uint8Array([1, 2]),
          writeHttpMetadata(headers) {
            headers.set('content-type', 'image/jpeg');
          }
        };
      }
    };
    const response = await worker.fetch(new Request(
      'https://example.com/api/admin/stores/STORE-1/payroll/proofs/PROOF-1',
      {
        headers: {
          cookie: 'staffbot_admin_session=session-1'
        }
      }
    ), fixture.env, { waitUntil() {} });

    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get('cache-control'),
      'private, no-store'
    );
    assert.equal(response.headers.get('content-type'), 'image/jpeg');
  } finally {
    fixture.database.close();
  }
});

test('admin payroll list returns fixed micros, proof count, and masked accounts', async () => {
  const fixture = adminFixture();
  try {
    fixture.database.exec(`
      INSERT INTO payroll_disbursements (
        payroll_id, store_id, telegram_id, payroll_start_date,
        scheduled_date, cycle_day, period_start, cutoff_at,
        amount_snapshot_micros, currency, status,
        accepts_bank, bank_details_snapshot,
        bank_micros, current_admin_id, created_at, updated_at
      ) VALUES (
        'PAYROLL-LIST', 'STORE-1', 'EMP-1', '2026-07-01',
        '2026-07-16', 16,
        '2026-07-01T00:00:00.000Z',
        '2026-07-16T03:00:00.000Z',
        100000000, '¥', 'awaiting_employee_confirmation',
        1, 'Bank account 12345678',
        100000000, 'ADMIN-1',
        '2026-07-16T03:00:00.000Z',
        '2026-07-16T04:00:00.000Z'
      );
      INSERT INTO payroll_payment_proofs (
        proof_id, payroll_id, method, object_key,
        telegram_file_id, mime_type, size_bytes,
        sort_order, uploaded_by, uploaded_at
      ) VALUES (
        'PROOF-LIST', 'PAYROLL-LIST', 'bank', 'private-key',
        'TG-FILE-SECRET', 'image/jpeg', 2, 1,
        'ADMIN-1', '2026-07-16T04:00:00.000Z'
      );
      INSERT INTO payroll_payment_qr_codes (
        qr_id, store_id, telegram_id, object_key,
        telegram_file_id, mime_type, size_bytes, uploaded_at
      ) VALUES (
        'QR-LIST', 'STORE-1', 'EMP-1', 'qr-list-private-key',
        'QR-TG-FILE-SECRET', 'image/png', 3,
        '2026-07-16T03:30:00.000Z'
      );
      UPDATE payroll_disbursements
      SET usdt_qr_id_snapshot = 'QR-LIST'
      WHERE payroll_id = 'PAYROLL-LIST';
    `);
    const response = await worker.fetch(new Request(
      'https://example.com/api/admin/stores/STORE-1/payroll',
      {
        headers: {
          cookie: 'staffbot_admin_session=session-1'
        }
      }
    ), fixture.env, { waitUntil() {} });
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.equal(result.payroll.length, 1);
    assert.deepEqual(
      {
        employee: result.payroll[0].employee,
        amount_snapshot_micros:
          result.payroll[0].amount_snapshot_micros,
        bank_micros: result.payroll[0].bank_micros,
        proof_count: result.payroll[0].proof_count,
        has_usdt_qr: result.payroll[0].has_usdt_qr,
        email_status: result.payroll[0].email_status,
        bank_details_snapshot:
          result.payroll[0].bank_details_snapshot
      },
      {
        employee: 'Alice',
        amount_snapshot_micros: 100000000,
        bank_micros: 100000000,
        proof_count: 1,
        has_usdt_qr: true,
        email_status: '',
        bank_details_snapshot: '••••5678'
      }
    );
    assert.equal('object_key' in result.payroll[0], false);
    assert.equal('telegram_file_id' in result.payroll[0], false);
    assert.equal('usdt_qr_url' in result.payroll[0], false);
    assert.equal(result.pagination.total, 1);
  } finally {
    fixture.database.close();
  }
});

test('admin reads a snapshotted USDT QR through the private store route', async () => {
  const fixture = adminFixture();
  try {
    fixture.database.exec(`
      INSERT INTO stores (
        store_id, name, created_at, updated_at
      ) VALUES (
        'STORE-2', 'Other Store',
        '2026-07-01T00:00:00.000Z',
        '2026-07-01T00:00:00.000Z'
      );
      INSERT INTO store_members (
        store_id, telegram_id, display_name, role, status,
        cycle_start, joined_at, updated_at
      ) VALUES (
        'STORE-1', 'STORE-ADMIN', 'Store Admin', 'admin', 'active',
        '2026-07-01T00:00:00.000Z',
        '2026-07-01T00:00:00.000Z',
        '2026-07-01T00:00:00.000Z'
      );
      INSERT INTO admin_sessions (
        token, telegram_id, expires_at, created_at
      ) VALUES (
        'store-session', 'STORE-ADMIN',
        '2099-01-01T00:00:00.000Z',
        '2026-07-01T00:00:00.000Z'
      );
      INSERT INTO payroll_payment_qr_codes (
        qr_id, store_id, telegram_id, object_key,
        telegram_file_id, mime_type, size_bytes, uploaded_at
      ) VALUES (
        'QR-PRIVATE', 'STORE-1', 'EMP-1', 'qr-private-key',
        'QR-TELEGRAM-SECRET', 'image/png', 3,
        '2026-07-16T03:30:00.000Z'
      );
      INSERT INTO payroll_disbursements (
        payroll_id, store_id, telegram_id, payroll_start_date,
        scheduled_date, cycle_day, period_start, cutoff_at,
        amount_snapshot_micros, currency, status,
        accepts_usdt, usdt_qr_id_snapshot,
        created_at, updated_at
      ) VALUES (
        'PAYROLL-QR', 'STORE-1', 'EMP-1', '2026-07-01',
        '2026-07-16', 16,
        '2026-07-01T00:00:00.000Z',
        '2026-07-16T03:00:00.000Z',
        1000000, '¥', 'awaiting_admin_payment',
        1, 'QR-PRIVATE',
        '2026-07-16T03:00:00.000Z',
        '2026-07-16T03:30:00.000Z'
      );
    `);
    fixture.env.PAYROLL_PROOFS = {
      async get(key) {
        assert.equal(key, 'qr-private-key');
        return {
          body: new Uint8Array([1, 2, 3]),
          writeHttpMetadata(headers) {
            headers.set('content-type', 'image/png');
          }
        };
      }
    };
    const path = [
      'https://example.com/api/admin/stores/STORE-1/payroll',
      'PAYROLL-QR',
      'usdt-qr'
    ].join('/');
    const authorized = await worker.fetch(
      new Request(path, {
        headers: {
          cookie: 'staffbot_admin_session=store-session'
        }
      }),
      fixture.env,
      { waitUntil() {} }
    );
    const crossStore = await worker.fetch(
      new Request(path.replace('STORE-1', 'STORE-2'), {
        headers: {
          cookie: 'staffbot_admin_session=store-session'
        }
      }),
      fixture.env,
      { waitUntil() {} }
    );
    const unauthenticated = await worker.fetch(
      new Request(path),
      fixture.env,
      { waitUntil() {} }
    );
    const detailResponse = await worker.fetch(
      new Request(
        'https://example.com/api/admin/stores/STORE-1/payroll/PAYROLL-QR',
        {
          headers: {
            cookie: 'staffbot_admin_session=store-session'
          }
        }
      ),
      fixture.env,
      { waitUntil() {} }
    );
    const detail = await detailResponse.json();

    assert.equal(authorized.status, 200);
    assert.equal(crossStore.status, 403);
    assert.equal(unauthenticated.status, 401);
    assert.equal(
      authorized.headers.get('cache-control'),
      'private, no-store'
    );
    assert.equal(authorized.headers.get('content-type'), 'image/png');
    assert.equal(detail.payroll.has_usdt_qr, true);
    assert.equal(
      detail.payroll.usdt_qr_url,
      '/api/admin/stores/STORE-1/payroll/PAYROLL-QR/usdt-qr'
    );
    assert.equal('object_key' in detail.payroll, false);
    assert.equal('telegram_file_id' in detail.payroll, false);
    assert.doesNotMatch(
      JSON.stringify(detail),
      /qr-private-key|QR-TELEGRAM-SECRET/
    );
  } finally {
    fixture.database.close();
  }
});

test('admin payroll detail is store scoped and exposes no storage location', async () => {
  const fixture = adminFixture();
  try {
    fixture.database.exec(`
      INSERT INTO stores (
        store_id, name, created_at, updated_at
      ) VALUES (
        'STORE-2', 'Other Store',
        '2026-07-01T00:00:00.000Z',
        '2026-07-01T00:00:00.000Z'
      );
      INSERT INTO payroll_disbursements (
        payroll_id, store_id, telegram_id, payroll_start_date,
        scheduled_date, cycle_day, period_start, cutoff_at,
        amount_snapshot_micros, currency, status,
        created_at, updated_at
      ) VALUES (
        'PAYROLL-OTHER', 'STORE-2', 'EMP-1', '2026-07-01',
        '2026-07-16', 16,
        '2026-07-01T00:00:00.000Z',
        '2026-07-16T03:00:00.000Z',
        1000000, '¥', 'awaiting_admin_payment',
        '2026-07-16T03:00:00.000Z',
        '2026-07-16T03:00:00.000Z'
      );
    `);

    const response = await worker.fetch(new Request(
      'https://example.com/api/admin/stores/STORE-1/payroll/PAYROLL-OTHER',
      {
        headers: {
          cookie: 'staffbot_admin_session=session-1'
        }
      }
    ), fixture.env, { waitUntil() {} });

    assert.equal(response.status, 404);
    const splitResponse = await worker.fetch(new Request(
      'https://example.com/api/admin/stores/STORE-1/payroll/PAYROLL-OTHER/split',
      {
        method: 'POST',
        headers: {
          cookie: 'staffbot_admin_session=session-1',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          bank_micros: 1000000,
          usdt_micros: 0,
          cash_micros: 0
        })
      }
    ), fixture.env, { waitUntil() {} });
    assert.equal(splitResponse.status, 404);
  } finally {
    fixture.database.close();
  }
});

test('admin payroll split endpoint validates the authoritative micros total', async () => {
  const fixture = adminFixture();
  try {
    fixture.database.exec(`
      INSERT INTO payroll_disbursements (
        payroll_id, store_id, telegram_id, payroll_start_date,
        scheduled_date, cycle_day, period_start, cutoff_at,
        amount_snapshot_micros, currency, status,
        accepts_bank, accepts_cash, created_at, updated_at
      ) VALUES (
        'PAYROLL-SPLIT', 'STORE-1', 'EMP-1', '2026-07-01',
        '2026-07-16', 16,
        '2026-07-01T00:00:00.000Z',
        '2026-07-16T03:00:00.000Z',
        100000000, '¥', 'awaiting_admin_payment',
        1, 1,
        '2026-07-16T03:00:00.000Z',
        '2026-07-16T03:00:00.000Z'
      );
    `);
    const response = await worker.fetch(new Request(
      'https://example.com/api/admin/stores/STORE-1/payroll/PAYROLL-SPLIT/split',
      {
        method: 'POST',
        headers: {
          cookie: 'staffbot_admin_session=session-1',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          bank_micros: 70000000,
          usdt_micros: 0,
          cash_micros: 30000000
        })
      }
    ), fixture.env, { waitUntil() {} });
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.equal(result.payroll.bank_micros, 70000000);
    assert.equal(result.payroll.cash_micros, 30000000);
  } finally {
    fixture.database.close();
  }
});
