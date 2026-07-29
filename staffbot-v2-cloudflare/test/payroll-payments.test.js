import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const schema = readFileSync(
  new URL('../db/schema.sql', import.meta.url),
  'utf8'
);

function databaseFixture() {
  const database = new DatabaseSync(':memory:');
  database.exec(schema);
  return database;
}

function payroll(overrides = {}) {
  return {
    payroll_id: 'PAYROLL-1',
    store_id: 'STORE-1',
    telegram_id: 'EMP-1',
    payroll_start_date: '2026-07-01',
    scheduled_date: '2026-07-16',
    cycle_day: 16,
    period_start: '2026-07-01T03:00:00.000Z',
    cutoff_at: '2026-07-16T03:00:00.000Z',
    amount_snapshot_micros: 100_000_000,
    currency: '₫',
    status: 'awaiting_employee_details',
    bank_micros: 0,
    usdt_micros: 0,
    cash_micros: 0,
    created_at: '2026-07-16T03:10:00.000Z',
    updated_at: '2026-07-16T03:10:00.000Z',
    ...overrides
  };
}

function insertPayroll(database, row) {
  return database.prepare(`
    INSERT INTO payroll_disbursements (
      payroll_id, store_id, telegram_id, payroll_start_date,
      scheduled_date, cycle_day, period_start, cutoff_at,
      amount_snapshot_micros, currency, status,
      bank_micros, usdt_micros, cash_micros,
      created_at, updated_at
    ) VALUES (
      :payroll_id, :store_id, :telegram_id, :payroll_start_date,
      :scheduled_date, :cycle_day, :period_start, :cutoff_at,
      :amount_snapshot_micros, :currency, :status,
      :bank_micros, :usdt_micros, :cash_micros,
      :created_at, :updated_at
    )
  `).run(row);
}

test('rejects blank personal payroll identities', () => {
  const database = databaseFixture();

  assert.throws(
    () => insertPayroll(database, payroll({ payroll_id: '  ' })),
    /CHECK constraint failed/
  );
  assert.throws(
    () => insertPayroll(database, payroll({ store_id: '' })),
    /CHECK constraint failed/
  );
  assert.throws(
    () => insertPayroll(database, payroll({ telegram_id: '' })),
    /CHECK constraint failed/
  );
});

test('accepts positive zero and negative immutable snapshots', () => {
  const database = databaseFixture();

  insertPayroll(database, payroll());
  insertPayroll(database, payroll({
    payroll_id: 'PAYROLL-2',
    scheduled_date: '2026-07-30',
    cycle_day: 30,
    amount_snapshot_micros: 0,
    status: 'skipped_zero'
  }));
  insertPayroll(database, payroll({
    payroll_id: 'PAYROLL-3',
    scheduled_date: '2026-08-15',
    amount_snapshot_micros: -25_000_000,
    status: 'carried_negative'
  }));

  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS total FROM payroll_disbursements
    `).get().total,
    3
  );
});

test('rejects invalid payroll states and split amounts', () => {
  const database = databaseFixture();

  assert.throws(
    () => insertPayroll(database, payroll({ status: 'mystery' })),
    /CHECK constraint failed/
  );
  assert.throws(
    () => insertPayroll(database, payroll({ bank_micros: -1 })),
    /CHECK constraint failed/
  );
  assert.throws(
    () => insertPayroll(database, payroll({ cash_micros: 0.5 })),
    /CHECK constraint failed/
  );
});

test('prevents duplicate employee cutoffs and payment profiles', () => {
  const database = databaseFixture();
  insertPayroll(database, payroll());

  assert.throws(
    () => insertPayroll(database, payroll({ payroll_id: 'PAYROLL-OTHER' })),
    /UNIQUE constraint failed/
  );

  database.prepare(`
    INSERT INTO payroll_payment_profiles (
      store_id, telegram_id, created_at, updated_at
    ) VALUES ('STORE-1', 'EMP-1', ?, ?)
  `).run(
    '2026-07-16T03:00:00.000Z',
    '2026-07-16T03:00:00.000Z'
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO payroll_payment_profiles (
        store_id, telegram_id, created_at, updated_at
      ) VALUES ('STORE-1', 'EMP-1', ?, ?)
    `).run(
      '2026-07-16T03:00:00.000Z',
      '2026-07-16T03:00:00.000Z'
    ),
    /UNIQUE constraint failed/
  );
});

test('prevents duplicate proof order object keys and email rows', () => {
  const database = databaseFixture();
  insertPayroll(database, payroll());
  const insertProof = (proofId, objectKey, sortOrder) => database.prepare(`
    INSERT INTO payroll_payment_proofs (
      proof_id, payroll_id, method, object_key, telegram_file_id,
      mime_type, size_bytes, sort_order, uploaded_by, uploaded_at
    ) VALUES (?, 'PAYROLL-1', 'bank', ?, 'TG-FILE', 'image/jpeg', 100, ?, 'ADMIN-1', ?)
  `).run(
    proofId,
    objectKey,
    sortOrder,
    '2026-07-16T04:00:00.000Z'
  );

  insertProof('PROOF-1', 'payroll/STORE-1/PAYROLL-1/bank/PROOF-1.jpg', 1);
  assert.throws(
    () => insertProof(
      'PROOF-2',
      'payroll/STORE-1/PAYROLL-1/bank/PROOF-2.jpg',
      1
    ),
    /UNIQUE constraint failed/
  );
  assert.throws(
    () => insertProof(
      'PROOF-3',
      'payroll/STORE-1/PAYROLL-1/bank/PROOF-1.jpg',
      2
    ),
    /UNIQUE constraint failed/
  );

  database.prepare(`
    INSERT INTO payroll_email_outbox (
      payroll_id, recipient, created_at, updated_at
    ) VALUES ('PAYROLL-1', 'finance@example.com', ?, ?)
  `).run(
    '2026-07-16T05:00:00.000Z',
    '2026-07-16T05:00:00.000Z'
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO payroll_email_outbox (
        payroll_id, recipient, created_at, updated_at
      ) VALUES ('PAYROLL-1', 'finance@example.com', ?, ?)
    `).run(
      '2026-07-16T05:00:00.000Z',
      '2026-07-16T05:00:00.000Z'
    ),
    /UNIQUE constraint failed/
  );
});
