import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import worker from '../src/index.js';
import {
  approveAbsenceFineRequest,
  approveIncomeRequest,
  approveLeaveRequest,
  approveSalaryAdvanceRequest,
  approveSalaryRequest,
  insertSystemFine,
  rejectAbsenceFineRequest,
  rejectIncomeRequest
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

function adminMutationRequest(env, pathname, method, body) {
  return worker.fetch(new Request(`https://staffbot.test${pathname}`, {
    method,
    headers: {
      cookie: 'staffbot_admin_session=TOKEN1',
      'content-type': 'application/json'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  }), env, { waitUntil() {} });
}

function rejectLedgerMutation(sql) {
  if (/^\s*(UPDATE|DELETE)\s+(FROM\s+)?payroll_entries/i.test(sql)) {
    throw new Error('ledger history was mutated');
  }
}

function concurrentPendingReads(tableName) {
  let reads = 0;
  let releaseReads;
  const bothRead = new Promise((resolve) => {
    releaseReads = resolve;
  });
  return {
    async afterFirst(sql) {
      if (!sql.includes(`SELECT * FROM ${tableName}`)) return;
      reads += 1;
      if (reads === 2) releaseReads();
      await bothRead;
    }
  };
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

test('concurrent dual income approvals produce one winning write set', async () => {
  const { database, env } = approvalFixture({
    writeMode: 'dual',
    hooks: concurrentPendingReads('pending_income')
  });
  database.prepare(`
    INSERT INTO pending_income (
      request_id, store_id, telegram_id, income, commission_rate,
      commission_income, fine, status, submitted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    'INC-RACE', 'STORE1', 'EMP1', 100, 0.6, 60, 5,
    '2026-07-15T00:00:00.000Z'
  );

  const results = await Promise.all([
    approveIncomeRequest(env, 'STORE1', 'INC-RACE', 'ADMIN1'),
    approveIncomeRequest(env, 'STORE1', 'INC-RACE', 'ADMIN2')
  ]);

  assert.deepEqual(
    results.map((result) => result.ok).sort(),
    [false, true]
  );
  assert.equal(
    results.find((result) => !result.ok).error,
    'already_decided'
  );
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS total FROM income_records WHERE request_id = 'INC-RACE'
    `).get().total,
    2
  );
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS total FROM payroll_entries WHERE source_id = 'INC-RACE'
    `).get().total,
    2
  );
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS total FROM admin_audit_logs
      WHERE action = 'approve_income' AND target_id = 'INC-RACE'
    `).get().total,
    1
  );
});

test('concurrent income approval and rejection produce one final decision', async () => {
  const { database, env } = approvalFixture({
    writeMode: 'dual',
    hooks: concurrentPendingReads('pending_income')
  });
  database.prepare(`
    INSERT INTO pending_income (
      request_id, store_id, telegram_id, income, commission_rate,
      commission_income, fine, status, submitted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    'INC-DECISION-RACE', 'STORE1', 'EMP1', 100, 0.6, 60, 5,
    '2026-07-15T00:00:00.000Z'
  );

  const results = await Promise.all([
    approveIncomeRequest(
      env,
      'STORE1',
      'INC-DECISION-RACE',
      'ADMIN1'
    ),
    rejectIncomeRequest(
      env,
      'STORE1',
      'INC-DECISION-RACE',
      'ADMIN2',
      'Rejected concurrently'
    )
  ]);

  assert.deepEqual(
    results.map((result) => result.ok).sort(),
    [false, true]
  );
  assert.equal(
    results.find((result) => !result.ok).error,
    'already_decided'
  );
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS total FROM admin_audit_logs
      WHERE target_id = 'INC-DECISION-RACE'
    `).get().total,
    1
  );
  const status = database.prepare(`
    SELECT status FROM pending_income WHERE request_id = 'INC-DECISION-RACE'
  `).get().status;
  assert.ok(status === 'approved' || status === 'rejected');
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS total FROM income_records
      WHERE request_id = 'INC-DECISION-RACE'
    `).get().total,
    status === 'approved' ? 2 : 0
  );
});

test('non-financial approval services identify decided replays', async () => {
  const { database, env } = approvalFixture();
  database.exec(`
    INSERT INTO leave_requests (
      request_id, store_id, telegram_id, leave_date, status, requested_at
    ) VALUES (
      'LEAVE-REPLAY', 'STORE1', 'EMP1', '2026-08-03', 'pending',
      '2026-07-29T00:00:00.000Z'
    );
    INSERT INTO absence_fine_requests (
      request_id, store_id, telegram_id, business_date,
      original_fine, fine, status, created_at
    ) VALUES (
      'ABS-REPLAY', 'STORE1', 'EMP1', '2026-07-28',
      5, 5, 'pending', '2026-07-29T00:00:00.000Z'
    );
  `);

  assert.equal((await approveLeaveRequest(
    env,
    'STORE1',
    'LEAVE-REPLAY',
    'ADMIN1'
  )).ok, true);
  assert.deepEqual(
    await approveLeaveRequest(env, 'STORE1', 'LEAVE-REPLAY', 'ADMIN2'),
    { ok: false, error: 'already_decided' }
  );

  assert.equal((await rejectAbsenceFineRequest(
    env,
    'ABS-REPLAY',
    'ADMIN1',
    'Approved exception',
    'STORE1'
  )).ok, true);
  assert.deepEqual(
    await rejectAbsenceFineRequest(
      env,
      'ABS-REPLAY',
      'ADMIN2',
      'Replay',
      'STORE1'
    ),
    { ok: false, error: 'already_decided' }
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

test('concurrent salary advance approvals produce one legacy deduction', async () => {
  const { database, env } = approvalFixture({
    writeMode: 'dual',
    hooks: concurrentPendingReads('salary_advance_requests')
  });
  database.exec(`
    INSERT INTO income_records (
      record_id, store_id, telegram_id, income, commission_rate,
      commission_income, original_fine, fine, type, source,
      request_id, approved_at, admin_id
    ) VALUES (
      'REC-RACE-INCOME', 'STORE1', 'EMP1', 100, 0.6,
      60, 0, 0, 'income', 'manual',
      'INC-RACE-SEED', '2026-07-15T00:00:00.000Z', 'ADMIN1'
    );
    INSERT INTO salary_advance_requests (
      request_id, store_id, telegram_id, amount, status, requested_at
    ) VALUES (
      'ADV-RACE', 'STORE1', 'EMP1', 20, 'pending',
      '2026-07-16T00:00:00.000Z'
    );
  `);

  const results = await Promise.all([
    approveSalaryAdvanceRequest(env, 'STORE1', 'ADV-RACE', 'ADMIN1'),
    approveSalaryAdvanceRequest(env, 'STORE1', 'ADV-RACE', 'ADMIN2')
  ]);

  assert.deepEqual(
    results.map((result) => result.ok).sort(),
    [false, true]
  );
  assert.equal(
    results.find((result) => !result.ok).error,
    'already_decided'
  );
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS total
      FROM income_records WHERE request_id = 'ADV-RACE'
    `).get().total,
    1
  );
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS total
      FROM payroll_entries WHERE source_id = 'ADV-RACE'
    `).get().total,
    1
  );
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS total FROM admin_audit_logs
      WHERE action = 'approve_salary_advance' AND target_id = 'ADV-RACE'
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

test('keeps direct legacy fine edits and deletes while ledger writes are off', async () => {
  const { database, env } = approvalFixture({ writeMode: 'off' });
  database.exec(`
    INSERT INTO income_records (
      record_id, store_id, telegram_id, income, commission_rate,
      commission_income, original_fine, fine, type, source,
      request_id, approved_at, admin_id
    ) VALUES (
      'REC-LEGACY-FINE', 'STORE1', 'EMP1', 0, 0.6,
      0, 5, 5, 'fine', 'manual_fine',
      'FINE-LEGACY', '2026-07-15T00:00:00.000Z', 'ADMIN1'
    );
  `);

  const updateResponse = await adminMutationRequest(
    env,
    '/api/admin/stores/STORE1/income/records/REC-LEGACY-FINE',
    'PATCH',
    { fine: 3 }
  );

  assert.equal(updateResponse.status, 200);
  assert.deepEqual(await updateResponse.json(), { ok: true });
  assert.equal(
    database.prepare(`
      SELECT fine FROM income_records WHERE record_id = 'REC-LEGACY-FINE'
    `).get().fine,
    3
  );

  const deleteResponse = await adminMutationRequest(
    env,
    '/api/admin/stores/STORE1/income/records/REC-LEGACY-FINE',
    'DELETE'
  );

  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(await deleteResponse.json(), { ok: true });
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS total
      FROM income_records WHERE record_id = 'REC-LEGACY-FINE'
    `).get().total,
    0
  );
});

test('invalid ledger write mode blocks destructive legacy corrections', async () => {
  const { database, env } = approvalFixture({ writeMode: 'unexpected' });
  database.exec(`
    INSERT INTO income_records (
      record_id, store_id, telegram_id, income, commission_rate,
      commission_income, original_fine, fine, type, source,
      request_id, approved_at, admin_id
    ) VALUES (
      'REC-INVALID-MODE', 'STORE1', 'EMP1', 0, 0.6,
      0, 5, 5, 'fine', 'manual_fine',
      'FINE-INVALID-MODE', '2026-07-15T00:00:00.000Z', 'ADMIN1'
    );
  `);
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const updateResponse = await adminMutationRequest(
      env,
      '/api/admin/stores/STORE1/income/records/REC-INVALID-MODE',
      'PATCH',
      { fine: 3 }
    );
    assert.equal(updateResponse.status, 409);
    assert.equal((await updateResponse.json()).error, 'invalid_write_mode');

    const deleteResponse = await adminMutationRequest(
      env,
      '/api/admin/stores/STORE1/income/records/REC-INVALID-MODE',
      'DELETE'
    );
    assert.equal(deleteResponse.status, 409);
    assert.equal((await deleteResponse.json()).error, 'invalid_write_mode');
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(
    database.prepare(`
      SELECT fine FROM income_records WHERE record_id = 'REC-INVALID-MODE'
    `).get().fine,
    5
  );
});

test('dual mode deletes an effective record with one immutable reversal', async () => {
  const { database, env } = approvalFixture({
    writeMode: 'dual',
    hooks: {
      beforeRun: rejectLedgerMutation,
      beforeBatchStatement: rejectLedgerMutation
    }
  });
  database.exec(`
    INSERT INTO income_records (
      record_id, store_id, telegram_id, income, commission_rate,
      commission_income, original_fine, fine, type, source,
      request_id, approved_at, admin_id
    ) VALUES (
      'REC-DELETE-FINE', 'STORE1', 'EMP1', 0, 0.6,
      0, 5, 5, 'fine', 'manual_fine',
      'FINE-DELETE', '2026-07-15T00:00:00.000Z', 'ADMIN1'
    );
    INSERT INTO payroll_entries (
      entry_id, store_id, telegram_id, type, amount_micros, currency,
      effective_at, source, source_id, created_by, created_at,
      reverses_entry_id, metadata_json
    ) VALUES (
      'PAY-DELETE-FINE', 'STORE1', 'EMP1', 'fine', -5000000, '$',
      '2026-07-15T00:00:00.000Z', 'manual_fine', 'FINE-DELETE',
      'ADMIN1', '2026-07-15T00:00:00.000Z', NULL, '{}'
    );
  `);

  const response = await adminMutationRequest(
    env,
    '/api/admin/stores/STORE1/income/records/REC-DELETE-FINE',
    'DELETE'
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.equal(
    database.prepare(`
      SELECT fine FROM income_records WHERE record_id = 'REC-DELETE-FINE'
    `).get().fine,
    5
  );
  assert.deepEqual(
    database.prepare(`
      SELECT type, amount_micros, reverses_entry_id
      FROM payroll_entries ORDER BY effective_at, entry_id
    `).all().map((row) => ({ ...row })),
    [
      {
        type: 'fine',
        amount_micros: -5_000_000,
        reverses_entry_id: null
      },
      {
        type: 'reversal',
        amount_micros: 5_000_000,
        reverses_entry_id: 'PAY-DELETE-FINE'
      }
    ]
  );

  const replay = await adminMutationRequest(
    env,
    '/api/admin/stores/STORE1/income/records/REC-DELETE-FINE',
    'DELETE'
  );
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).error, 'already_reversed');
});

test('dual mode fine correction reverses the old entry and adds the corrected fine', async () => {
  const { database, env } = approvalFixture({
    writeMode: 'dual',
    hooks: {
      beforeRun: rejectLedgerMutation,
      beforeBatchStatement: rejectLedgerMutation
    }
  });
  database.exec(`
    INSERT INTO income_records (
      record_id, store_id, telegram_id, income, commission_rate,
      commission_income, original_fine, fine, type, source,
      request_id, approved_at, admin_id
    ) VALUES (
      'REC-UPDATE-FINE', 'STORE1', 'EMP1', 0, 0.6,
      0, 5, 5, 'fine', 'manual_fine',
      'FINE-UPDATE', '2026-07-15T00:00:00.000Z', 'ADMIN1'
    );
    INSERT INTO payroll_entries (
      entry_id, store_id, telegram_id, type, amount_micros, currency,
      effective_at, source, source_id, created_by, created_at,
      reverses_entry_id, metadata_json
    ) VALUES (
      'PAY-UPDATE-FINE', 'STORE1', 'EMP1', 'fine', -5000000, '$',
      '2026-07-15T00:00:00.000Z', 'manual_fine', 'FINE-UPDATE',
      'ADMIN1', '2026-07-15T00:00:00.000Z', NULL, '{}'
    );
  `);

  const response = await adminMutationRequest(
    env,
    '/api/admin/stores/STORE1/income/records/REC-UPDATE-FINE',
    'PATCH',
    { fine: 3 }
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.equal(
    database.prepare(`
      SELECT fine FROM income_records WHERE record_id = 'REC-UPDATE-FINE'
    `).get().fine,
    5
  );
  assert.deepEqual(
    database.prepare(`
      SELECT type, amount_micros, source, reverses_entry_id
      FROM payroll_entries ORDER BY effective_at, entry_id
    `).all().map((row) => ({ ...row })),
    [
      {
        type: 'fine',
        amount_micros: -5_000_000,
        source: 'manual_fine',
        reverses_entry_id: null
      },
      {
        type: 'fine',
        amount_micros: -3_000_000,
        source: 'fine_correction',
        reverses_entry_id: null
      },
      {
        type: 'reversal',
        amount_micros: 5_000_000,
        source: 'admin_reversal',
        reverses_entry_id: 'PAY-UPDATE-FINE'
      }
    ]
  );
  assert.equal(
    database.prepare(`
      SELECT SUM(amount_micros) AS total_micros FROM payroll_entries
    `).get().total_micros,
    -3_000_000
  );

  const replay = await adminMutationRequest(
    env,
    '/api/admin/stores/STORE1/income/records/REC-UPDATE-FINE',
    'PATCH',
    { fine: 2 }
  );
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).error, 'already_reversed');
});

test('dual mode fine correction rolls back its reversal when replacement insert fails', async () => {
  let ledgerInserts = 0;
  const { database, env } = approvalFixture({
    writeMode: 'dual',
    hooks: {
      beforeBatchStatement(sql) {
        rejectLedgerMutation(sql);
        if (sql.includes('INSERT INTO payroll_entries')) {
          ledgerInserts += 1;
          if (ledgerInserts === 2) {
            throw new Error('injected corrected fine failure');
          }
        }
      }
    }
  });
  database.exec(`
    INSERT INTO income_records (
      record_id, store_id, telegram_id, income, commission_rate,
      commission_income, original_fine, fine, type, source,
      request_id, approved_at, admin_id
    ) VALUES (
      'REC-ROLLBACK-FINE', 'STORE1', 'EMP1', 0, 0.6,
      0, 5, 5, 'fine', 'manual_fine',
      'FINE-ROLLBACK', '2026-07-15T00:00:00.000Z', 'ADMIN1'
    );
    INSERT INTO payroll_entries (
      entry_id, store_id, telegram_id, type, amount_micros, currency,
      effective_at, source, source_id, created_by, created_at,
      reverses_entry_id, metadata_json
    ) VALUES (
      'PAY-ROLLBACK-FINE', 'STORE1', 'EMP1', 'fine', -5000000, '$',
      '2026-07-15T00:00:00.000Z', 'manual_fine', 'FINE-ROLLBACK',
      'ADMIN1', '2026-07-15T00:00:00.000Z', NULL, '{}'
    );
  `);

  await assert.rejects(
    () => adminMutationRequest(
      env,
      '/api/admin/stores/STORE1/income/records/REC-ROLLBACK-FINE',
      'PATCH',
      { fine: 3 }
    ),
    /injected corrected fine failure/
  );

  assert.equal(
    database.prepare(`
      SELECT fine FROM income_records WHERE record_id = 'REC-ROLLBACK-FINE'
    `).get().fine,
    5
  );
  assert.deepEqual(
    database.prepare(`
      SELECT entry_id, amount_micros, reverses_entry_id
      FROM payroll_entries
    `).all().map((row) => ({ ...row })),
    [
      {
        entry_id: 'PAY-ROLLBACK-FINE',
        amount_micros: -5_000_000,
        reverses_entry_id: null
      }
    ]
  );
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS total FROM admin_audit_logs
      WHERE action = 'reverse_payroll_entry'
    `).get().total,
    0
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

test('concurrent salary approvals freeze one record and advance the cycle once', async () => {
  const { database, env } = approvalFixture({
    hooks: concurrentPendingReads('salary_requests')
  });
  database.exec(`
    INSERT INTO income_records (
      record_id, store_id, telegram_id, income, commission_rate,
      commission_income, original_fine, fine, type, source,
      request_id, approved_at, admin_id
    ) VALUES (
      'REC-SALARY-RACE', 'STORE1', 'EMP1', 100, 0.6,
      60, 0, 0, 'income', 'manual',
      'INC-SALARY-RACE', '2026-07-15T00:00:00.000Z', 'ADMIN1'
    );
    INSERT INTO salary_requests (
      request_id, store_id, telegram_id, amount_snapshot, status, requested_at
    ) VALUES (
      'SALREQ-RACE', 'STORE1', 'EMP1', 60, 'pending',
      '2026-07-18T00:00:00.000Z'
    );
  `);

  const results = await Promise.all([
    approveSalaryRequest(env, 'STORE1', 'SALREQ-RACE', 'ADMIN1'),
    approveSalaryRequest(env, 'STORE1', 'SALREQ-RACE', 'ADMIN2')
  ]);

  assert.deepEqual(
    results.map((result) => result.ok).sort(),
    [false, true]
  );
  assert.equal(
    results.find((result) => !result.ok).error,
    'already_decided'
  );
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS total
      FROM salary_records WHERE request_id = 'SALREQ-RACE'
    `).get().total,
    1
  );
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS total FROM admin_audit_logs
      WHERE action = 'approve_salary' AND target_id = 'SALREQ-RACE'
    `).get().total,
    1
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

  assert.equal(replay.status, 409);
  assert.deepEqual(
    await replay.json(),
    { ok: false, error: 'already_decided' }
  );
  const rejectedReplay = await adminRequest(
    env,
    '/api/admin/stores/STORE1/income/INC1/reject'
  );
  assert.equal(rejectedReplay.status, 409);
  assert.deepEqual(
    await rejectedReplay.json(),
    { ok: false, error: 'already_decided' }
  );
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

  assert.equal(replay.status, 409);
  assert.deepEqual(
    await replay.json(),
    { ok: false, error: 'already_decided' }
  );
  const rejectedReplay = await adminRequest(
    env,
    '/api/admin/stores/STORE1/advances/ADV1/reject'
  );
  assert.equal(rejectedReplay.status, 409);
  assert.deepEqual(
    await rejectedReplay.json(),
    { ok: false, error: 'already_decided' }
  );
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

  assert.equal(replay.status, 409);
  assert.deepEqual(
    await replay.json(),
    { ok: false, error: 'already_decided' }
  );
  const rejectedReplay = await adminRequest(
    env,
    '/api/admin/stores/STORE1/salary/SALREQ1/reject'
  );
  assert.equal(rejectedReplay.status, 409);
  assert.deepEqual(
    await rejectedReplay.json(),
    { ok: false, error: 'already_decided' }
  );
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
