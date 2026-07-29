import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const schema = readFileSync(
  new URL('../db/schema.sql', import.meta.url),
  'utf8'
);

function canonicalDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec(schema);
  return database;
}

function columnNames(database, table) {
  return database.prepare(`PRAGMA table_info(${table})`).all()
    .map((column) => column.name);
}

test('canonical schema contains the personal payroll contract', () => {
  const database = canonicalDatabase();

  assert.ok(
    columnNames(database, 'store_members').includes('payroll_start_date')
  );
  assert.ok(
    columnNames(database, 'store_members')
      .includes('payroll_automation_started_at')
  );
  assert.deepEqual(
    columnNames(database, 'payroll_disbursements'),
    [
      'payroll_id',
      'store_id',
      'telegram_id',
      'payroll_start_date',
      'scheduled_date',
      'cycle_day',
      'period_start',
      'cutoff_at',
      'amount_snapshot_micros',
      'currency',
      'status',
      'accepts_bank',
      'accepts_usdt',
      'accepts_cash',
      'bank_details_snapshot',
      'usdt_details_snapshot',
      'bank_micros',
      'usdt_micros',
      'cash_micros',
      'current_admin_id',
      'negative_carry_entry_id',
      'salary_record_id',
      'employee_notified_at',
      'employee_reminded_at',
      'employee_notification_error',
      'payment_sent_at',
      'disputed_at',
      'confirmed_at',
      'created_at',
      'updated_at'
    ]
  );
  assert.deepEqual(
    columnNames(database, 'payroll_payment_profiles'),
    [
      'store_id',
      'telegram_id',
      'accepts_bank',
      'accepts_usdt',
      'accepts_cash',
      'bank_details',
      'usdt_details',
      'created_at',
      'updated_at'
    ]
  );
  assert.deepEqual(
    columnNames(database, 'payroll_payment_proofs'),
    [
      'proof_id',
      'payroll_id',
      'method',
      'object_key',
      'telegram_file_id',
      'file_name',
      'mime_type',
      'size_bytes',
      'sort_order',
      'uploaded_by',
      'superseded_at',
      'uploaded_at'
    ]
  );
  assert.deepEqual(
    columnNames(database, 'payroll_email_outbox'),
    [
      'payroll_id',
      'recipient',
      'status',
      'attempt_count',
      'last_error',
      'claimed_at',
      'sent_at',
      'created_at',
      'updated_at'
    ]
  );
});

test('migration 021 preserves existing members without inventing payroll dates', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE store_members (
      store_id TEXT NOT NULL,
      telegram_id TEXT NOT NULL,
      display_name TEXT,
      role TEXT NOT NULL DEFAULT 'employee',
      status TEXT NOT NULL DEFAULT 'active',
      commission_rate REAL NOT NULL DEFAULT 0.6,
      cycle_start TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      absence_check_enabled INTEGER NOT NULL DEFAULT 1,
      absence_check_enabled_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (store_id, telegram_id)
    );
    INSERT INTO store_members (
      store_id, telegram_id, display_name, cycle_start, joined_at, updated_at
    ) VALUES (
      'STORE-1', 'EMP-1', 'Employee One',
      '2026-07-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z',
      '2026-07-28T00:00:00.000Z'
    );
  `);

  const migration = readFileSync(
    new URL(
      '../db/migrations/021_personal_payroll_cycle.sql',
      import.meta.url
    ),
    'utf8'
  );
  database.exec(migration);

  assert.deepEqual(
    { ...database.prepare(`
      SELECT
        cycle_start,
        payroll_start_date,
        payroll_automation_started_at
      FROM store_members
      WHERE store_id = 'STORE-1' AND telegram_id = 'EMP-1'
    `).get() },
    {
      cycle_start: '2026-07-01T00:00:00.000Z',
      payroll_start_date: null,
      payroll_automation_started_at: null
    }
  );
  for (const table of [
    'payroll_payment_profiles',
    'payroll_disbursements',
    'payroll_payment_proofs',
    'payroll_email_outbox'
  ]) {
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS total
        FROM sqlite_master
        WHERE type = 'table' AND name = ?
      `).get(table).total,
      1
    );
  }
});
