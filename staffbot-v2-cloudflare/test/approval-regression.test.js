import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import worker from '../src/index.js';
import {
  approveAbsenceFineRequest,
  approveIncomeRequest,
  approveSalaryAdvanceRequest,
  approveSalaryRequest,
  insertSystemFine
} from '../src/approvals.js';
import { getTotalIncome } from '../src/payroll.js';
import { createD1 } from './helpers/d1.js';

const schema = readFileSync(
  new URL('../db/schema.sql', import.meta.url),
  'utf8'
);

function approvalFixture({ writeMode, hooks } = {}) {
  const database = new DatabaseSync(':memory:');
  database.exec(schema);
  database.exec(`
    INSERT INTO stores (
      store_id, name, status, timezone, currency, created_at, updated_at
    ) VALUES (
      'STORE1', 'Store One', 'active', 'Asia/Tokyo', '$',
      '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
    );
    INSERT INTO store_members (
      store_id, telegram_id, display_name, role, status, commission_rate,
      cycle_start, joined_at, absence_check_enabled, updated_at
    ) VALUES (
      'STORE1', 'EMP1', 'Employee One', 'employee', 'active', 0.6,
      '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 1,
      '2026-07-01T00:00:00.000Z'
    );
    INSERT INTO admin_sessions (
      token, telegram_id, expires_at, created_at
    ) VALUES (
      'TOKEN1', 'ADMIN1', '2099-01-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z'
    );
  `);
  return {
    database,
    env: {
      DB: createD1(database, hooks),
      ADMIN_IDS: 'ADMIN1',
      BOT_TOKEN: 'test-token',
      WEBHOOK_SECRET: 'test-secret',
      ENVIRONMENT: 'production',
      PAYROLL_LEDGER_WRITE_MODE: writeMode
    }
  };
}

function adminRequest(env, pathname) {
  return worker.fetch(new Request(`https://staffbot.test${pathname}`, {
    method: 'POST',
    headers: {
      cookie: 'staffbot_admin_session=TOKEN1',
      'content-type': 'application/json'
    }
  }), env, { waitUntil() {} });
}

test('direct income approval records income and fine in the current payroll total', async () => {
  const { database, env } = approvalFixture();
  database.prepare(`
    INSERT INTO pending_income (
      request_id, store_id, telegram_id, income, commission_rate,
      commission_income, fine, status, submitted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    'INC-DIRECT', 'STORE1', 'EMP1', 100, 0.6, 60, 5,
    '2026-07-15T00:00:00.000Z'
  );

  const result = await approveIncomeRequest(env, 'STORE1', 'INC-DIRECT', 'ADMIN1');

  assert.equal(result.ok, true);
  assert.equal(await getTotalIncome(env, 'STORE1', 'EMP1'), 55);
  assert.deepEqual(
    database.prepare(`
      SELECT type, source, commission_income, fine
      FROM income_records
      WHERE request_id = 'INC-DIRECT'
      ORDER BY type
    `).all().map((row) => ({ ...row })),
    [
      { type: 'fine', source: 'manual_fine', commission_income: 0, fine: 5 },
      { type: 'income', source: 'manual', commission_income: 60, fine: 0 }
    ]
  );
  assert.equal(
    database.prepare(`SELECT COUNT(*) AS total FROM payroll_entries`).get().total,
    0
  );
});

test('dual mode writes approved income and its fine to the immutable ledger', async () => {
  const { database, env } = approvalFixture({ writeMode: 'dual' });
  database.prepare(`
    INSERT INTO pending_income (
      request_id, store_id, telegram_id, income, commission_rate,
      commission_income, fine, status, submitted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    'INC-DUAL', 'STORE1', 'EMP1', 100, 0.6, 60, 5,
    '2026-07-15T00:00:00.000Z'
  );

  const result = await approveIncomeRequest(
    env,
    'STORE1',
    'INC-DUAL',
    'ADMIN1'
  );

  assert.equal(result.ok, true);
  assert.deepEqual(
    database.prepare(`
      SELECT type, amount_micros, currency, source, source_id
      FROM payroll_entries
      ORDER BY type
    `).all().map((row) => ({ ...row })),
    [
      {
        type: 'fine',
        amount_micros: -5_000_000,
        currency: '$',
        source: 'manual_fine',
        source_id: 'INC-DUAL'
      },
      {
        type: 'income',
        amount_micros: 60_000_000,
        currency: '$',
        source: 'manual',
        source_id: 'INC-DUAL'
      }
    ]
  );
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS total
      FROM admin_audit_logs
      WHERE action = 'approve_income' AND target_id = 'INC-DUAL'
    `).get().total,
    1
  );
});

test('dual income approval rolls back request, legacy, ledger, and audit together', async () => {
  const { database, env } = approvalFixture({
    writeMode: 'dual',
    hooks: {
      beforeBatchStatement(sql) {
        if (sql.includes('INSERT INTO payroll_entries')) {
          throw new Error('injected ledger failure');
        }
      }
    }
  });
  database.prepare(`
    INSERT INTO pending_income (
      request_id, store_id, telegram_id, income, commission_rate,
      commission_income, fine, status, submitted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    'INC-ROLLBACK', 'STORE1', 'EMP1', 100, 0.6, 60, 5,
    '2026-07-15T00:00:00.000Z'
  );

  await assert.rejects(
    approveIncomeRequest(env, 'STORE1', 'INC-ROLLBACK', 'ADMIN1'),
    /injected ledger failure/
  );

  assert.equal(
    database.prepare(`
      SELECT status FROM pending_income WHERE request_id = 'INC-ROLLBACK'
    `).get().status,
    'pending'
  );
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS total
      FROM income_records WHERE request_id = 'INC-ROLLBACK'
    `).get().total,
    0
  );
  assert.equal(
    database.prepare(`SELECT COUNT(*) AS total FROM payroll_entries`).get().total,
    0
  );
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS total
      FROM admin_audit_logs WHERE target_id = 'INC-ROLLBACK'
    `).get().total,
    0
  );
});

test('direct salary advance approval writes one payroll deduction', async () => {
  const { database, env } = approvalFixture();
  database.exec(`
    INSERT INTO income_records (
      record_id, store_id, telegram_id, income, commission_rate,
      commission_income, original_fine, fine, type, source,
      request_id, approved_at, admin_id
    ) VALUES (
      'REC-DIRECT-INCOME', 'STORE1', 'EMP1', 100, 0.6,
      60, 0, 0, 'income', 'manual',
      'INC-DIRECT-SEED', '2026-07-15T00:00:00.000Z', 'ADMIN1'
    );
    INSERT INTO salary_advance_requests (
      request_id, store_id, telegram_id, amount, status, requested_at
    ) VALUES (
      'ADV-DIRECT', 'STORE1', 'EMP1', 20, 'pending',
      '2026-07-16T00:00:00.000Z'
    );
  `);

  const result = await approveSalaryAdvanceRequest(
    env,
    'STORE1',
    'ADV-DIRECT',
    'ADMIN1'
  );

  assert.equal(result.ok, true);
  assert.equal(await getTotalIncome(env, 'STORE1', 'EMP1'), 40);
  assert.deepEqual(
    { ...database.prepare(`
      SELECT type, source, commission_income, original_fine, fine
      FROM income_records WHERE request_id = 'ADV-DIRECT'
    `).get() },
    {
      type: 'advance',
      source: 'salary_advance',
      commission_income: 0,
      original_fine: 20,
      fine: 20
    }
  );
});

test('dual mode writes an approved salary advance as one negative ledger entry', async () => {
  const { database, env } = approvalFixture({ writeMode: 'dual' });
  database.exec(`
    INSERT INTO income_records (
      record_id, store_id, telegram_id, income, commission_rate,
      commission_income, original_fine, fine, type, source,
      request_id, approved_at, admin_id
    ) VALUES (
      'REC-DUAL-INCOME', 'STORE1', 'EMP1', 100, 0.6,
      60, 0, 0, 'income', 'manual',
      'INC-DUAL-SEED', '2026-07-15T00:00:00.000Z', 'ADMIN1'
    );
    INSERT INTO salary_advance_requests (
      request_id, store_id, telegram_id, amount, status, requested_at
    ) VALUES (
      'ADV-DUAL', 'STORE1', 'EMP1', 20, 'pending',
      '2026-07-16T00:00:00.000Z'
    );
  `);

  const result = await approveSalaryAdvanceRequest(
    env,
    'STORE1',
    'ADV-DUAL',
    'ADMIN1'
  );

  assert.equal(result.ok, true);
  assert.deepEqual(
    { ...database.prepare(`
      SELECT type, amount_micros, currency, source, source_id
      FROM payroll_entries
    `).get() },
    {
      type: 'advance',
      amount_micros: -20_000_000,
      currency: '$',
      source: 'salary_advance',
      source_id: 'ADV-DUAL'
    }
  );
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS total
      FROM admin_audit_logs
      WHERE action = 'approve_salary_advance' AND target_id = 'ADV-DUAL'
    `).get().total,
    1
  );
});

test('dual mode writes approved absence and system fines but skips zero fines', async () => {
  const { database, env } = approvalFixture({ writeMode: 'dual' });
  database.exec(`
    INSERT INTO absence_fine_requests (
      request_id, store_id, telegram_id, business_date,
      original_fine, fine, status, created_at
    ) VALUES (
      'ABS-DUAL', 'STORE1', 'EMP1', '2026-07-14',
      1.5, 1.5, 'pending', '2026-07-15T00:00:00.000Z'
    );
  `);

  const absence = await approveAbsenceFineRequest(
    env,
    'ABS-DUAL',
    'ADMIN1',
    'STORE1'
  );
  await insertSystemFine(
    env,
    'STORE1',
    'EMP1',
    5,
    'attendance_late',
    'ATT-DUAL',
    'ADMIN1',
    5
  );
  await insertSystemFine(
    env,
    'STORE1',
    'EMP1',
    0,
    'attendance_early',
    'ATT-ZERO',
    'ADMIN1',
    5
  );

  assert.equal(absence.ok, true);
  assert.deepEqual(
    database.prepare(`
      SELECT type, amount_micros, source, source_id
      FROM payroll_entries
      ORDER BY source
    `).all().map((row) => ({ ...row })),
    [
      {
        type: 'fine',
        amount_micros: -1_500_000,
        source: 'attendance_absence',
        source_id: 'ABS-DUAL'
      },
      {
        type: 'fine',
        amount_micros: -5_000_000,
        source: 'attendance_late',
        source_id: 'ATT-DUAL'
      }
    ]
  );
});

test('direct salary approval freezes the net total and starts a new cycle', async () => {
  const { database, env } = approvalFixture();
  database.exec(`
    INSERT INTO income_records (
      record_id, store_id, telegram_id, income, commission_rate,
      commission_income, original_fine, fine, type, source,
      request_id, approved_at, admin_id
    ) VALUES
      (
        'REC-DIRECT-SALARY-INCOME', 'STORE1', 'EMP1', 100, 0.6,
        60, 0, 0, 'income', 'manual',
        'INC-DIRECT-SALARY', '2026-07-15T00:00:00.000Z', 'ADMIN1'
      ),
      (
        'REC-DIRECT-SALARY-FINE', 'STORE1', 'EMP1', 0, 0.6,
        0, 5, 5, 'fine', 'manual_fine',
        'FINE-DIRECT-SALARY', '2026-07-16T00:00:00.000Z', 'ADMIN1'
      ),
      (
        'REC-DIRECT-SALARY-ADVANCE', 'STORE1', 'EMP1', 0, 0.6,
        0, 20, 20, 'advance', 'salary_advance',
        'ADV-DIRECT-SALARY', '2026-07-17T00:00:00.000Z', 'ADMIN1'
      );
    INSERT INTO salary_requests (
      request_id, store_id, telegram_id, amount_snapshot, status, requested_at
    ) VALUES (
      'SALREQ-DIRECT', 'STORE1', 'EMP1', 35, 'pending',
      '2026-07-18T00:00:00.000Z'
    );
  `);

  const result = await approveSalaryRequest(
    env,
    'STORE1',
    'SALREQ-DIRECT',
    'ADMIN1'
  );

  assert.equal(result.ok, true);
  assert.equal(result.amount, 35);
  assert.equal(await getTotalIncome(env, 'STORE1', 'EMP1'), 0);
  assert.equal(
    database.prepare(`
      SELECT cycle_start FROM store_members
      WHERE store_id = 'STORE1' AND telegram_id = 'EMP1'
    `).get().cycle_start,
    result.periodEnd
  );
});

test('approves income and its linked fine once across sequential replay', async () => {
  const { database, env } = approvalFixture();
  database.prepare(`
    INSERT INTO pending_income (
      request_id, store_id, telegram_id, income, commission_rate,
      commission_income, fine, status, submitted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    'INC1', 'STORE1', 'EMP1', 100, 0.6, 60, 5,
    '2026-07-15T00:00:00.000Z'
  );

  const response = await adminRequest(
    env,
    '/api/admin/stores/STORE1/income/INC1/approve'
  );
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.ok, true);
  assert.deepEqual(
    database.prepare(`
      SELECT type, source, income, commission_income, fine, request_id
      FROM income_records
      WHERE request_id = 'INC1'
      ORDER BY type
    `).all().map((row) => ({ ...row })),
    [
      {
        type: 'fine',
        source: 'manual_fine',
        income: 0,
        commission_income: 0,
        fine: 5,
        request_id: 'INC1'
      },
      {
        type: 'income',
        source: 'manual',
        income: 100,
        commission_income: 60,
        fine: 0,
        request_id: 'INC1'
      }
    ]
  );

  const replay = await adminRequest(
    env,
    '/api/admin/stores/STORE1/income/INC1/approve'
  );

  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { ok: false });
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS total FROM income_records WHERE request_id = 'INC1'
    `).get().total,
    2
  );
});

test('approves a salary advance as one payroll deduction', async () => {
  const { database, env } = approvalFixture();
  database.exec(`
    INSERT INTO income_records (
      record_id, store_id, telegram_id, income, commission_rate,
      commission_income, original_fine, fine, type, source,
      request_id, approved_at, admin_id
    ) VALUES (
      'REC-INCOME', 'STORE1', 'EMP1', 100, 0.6,
      60, 0, 0, 'income', 'manual',
      'INC-SEED', '2026-07-15T00:00:00.000Z', 'ADMIN1'
    );
    INSERT INTO salary_advance_requests (
      request_id, store_id, telegram_id, amount, status, requested_at
    ) VALUES (
      'ADV1', 'STORE1', 'EMP1', 20, 'pending',
      '2026-07-16T00:00:00.000Z'
    );
  `);

  const response = await adminRequest(
    env,
    '/api/admin/stores/STORE1/advances/ADV1/approve'
  );
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.ok, true);
  assert.deepEqual(
    { ...database.prepare(`
      SELECT type, source, commission_income, original_fine, fine, request_id
      FROM income_records WHERE request_id = 'ADV1'
    `).get() },
    {
      type: 'advance',
      source: 'salary_advance',
      commission_income: 0,
      original_fine: 20,
      fine: 20,
      request_id: 'ADV1'
    }
  );

  const replay = await adminRequest(
    env,
    '/api/admin/stores/STORE1/advances/ADV1/approve'
  );

  assert.deepEqual(await replay.json(), { ok: false });
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS total FROM income_records WHERE request_id = 'ADV1'
    `).get().total,
    1
  );
});

test('freezes the current net salary and advances the member cycle once', async () => {
  const { database, env } = approvalFixture();
  database.exec(`
    INSERT INTO income_records (
      record_id, store_id, telegram_id, income, commission_rate,
      commission_income, original_fine, fine, type, source,
      request_id, approved_at, admin_id
    ) VALUES
      (
        'REC-INCOME', 'STORE1', 'EMP1', 100, 0.6,
        60, 0, 0, 'income', 'manual',
        'INC1', '2026-07-15T00:00:00.000Z', 'ADMIN1'
      ),
      (
        'REC-FINE', 'STORE1', 'EMP1', 0, 0.6,
        0, 5, 5, 'fine', 'manual_fine',
        'FINE1', '2026-07-16T00:00:00.000Z', 'ADMIN1'
      ),
      (
        'REC-ADVANCE', 'STORE1', 'EMP1', 0, 0.6,
        0, 20, 20, 'advance', 'salary_advance',
        'ADV1', '2026-07-17T00:00:00.000Z', 'ADMIN1'
      );
    INSERT INTO salary_requests (
      request_id, store_id, telegram_id, amount_snapshot, status, requested_at
    ) VALUES (
      'SALREQ1', 'STORE1', 'EMP1', 35, 'pending',
      '2026-07-18T00:00:00.000Z'
    );
  `);

  const response = await adminRequest(
    env,
    '/api/admin/stores/STORE1/salary/SALREQ1/approve'
  );
  const result = await response.json();
  const salary = database.prepare(`
    SELECT amount, period_start, period_end, request_id
    FROM salary_records WHERE request_id = 'SALREQ1'
  `).get();

  assert.equal(response.status, 200);
  assert.equal(result.ok, true);
  assert.deepEqual({
    amount: salary.amount,
    period_start: salary.period_start,
    request_id: salary.request_id
  }, {
    amount: 35,
    period_start: '2026-07-01T00:00:00.000Z',
    request_id: 'SALREQ1'
  });
  assert.equal(
    database.prepare(`
      SELECT cycle_start FROM store_members
      WHERE store_id = 'STORE1' AND telegram_id = 'EMP1'
    `).get().cycle_start,
    salary.period_end
  );

  const replay = await adminRequest(
    env,
    '/api/admin/stores/STORE1/salary/SALREQ1/approve'
  );

  assert.deepEqual(await replay.json(), { ok: false });
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS total FROM salary_records
      WHERE request_id = 'SALREQ1'
    `).get().total,
    1
  );
  assert.equal(
    database.prepare(`
      SELECT cycle_start FROM store_members
      WHERE store_id = 'STORE1' AND telegram_id = 'EMP1'
    `).get().cycle_start,
    salary.period_end
  );
});
