import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  amountToMicros,
  legacyIncomeRecordToPayrollEntry,
  legacyPayrollImpactMicros,
  validatePayrollEntry
} from '../src/payroll-ledger.js';

const schema = readFileSync(
  new URL('../db/schema.sql', import.meta.url),
  'utf8'
);
const payrollLedgerMigration = readFileSync(
  new URL('../db/migrations/019_payroll_entries.sql', import.meta.url),
  'utf8'
);

function ledgerFixture() {
  const database = new DatabaseSync(':memory:');
  database.exec(schema);
  return database;
}

function insertLedgerEntry(database, entry) {
  return database.prepare(`
    INSERT INTO payroll_entries (
      entry_id, store_id, telegram_id, type, amount_micros, currency,
      effective_at, source, source_id, created_by, created_at,
      reverses_entry_id, metadata_json
    ) VALUES (
      :entry_id, :store_id, :telegram_id, :type, :amount_micros, :currency,
      :effective_at, :source, :source_id, :created_by, :created_at,
      :reverses_entry_id, :metadata_json
    )
  `).run(entry);
}

test('converts store currency amounts to six-decimal integer micros', () => {
  assert.equal(amountToMicros(12.34), 12_340_000);
  assert.equal(amountToMicros('0.000001'), 1);
  assert.equal(amountToMicros(1_200_000_000), 1_200_000_000_000_000);
});

test('rejects non-numeric and unsafe micros values', () => {
  assert.throws(() => amountToMicros('nope'), /finite number/);
  assert.throws(
    () => amountToMicros(Number.MAX_SAFE_INTEGER),
    /safe integer/
  );
});

test('maps supported legacy payroll types to signed micros', () => {
  assert.equal(legacyPayrollImpactMicros({
    type: 'income',
    commission_income: 12.34,
    fine: 0
  }), 12_340_000);

  assert.equal(legacyPayrollImpactMicros({
    type: 'fine',
    commission_income: 0,
    fine: 1.5
  }), -1_500_000);

  assert.equal(legacyPayrollImpactMicros({
    type: 'advance',
    commission_income: 0,
    fine: 20
  }), -20_000_000);
});

test('stops legacy migration when a type is unknown', () => {
  assert.throws(
    () => legacyPayrollImpactMicros({ type: 'mystery' }),
    /unsupported legacy payroll type: mystery/
  );
});

test('builds a deterministic immutable ledger draft from a legacy row', () => {
  const entry = legacyIncomeRecordToPayrollEntry({
    record_id: 'REC-1',
    store_id: 'STORE-1',
    telegram_id: 'EMP-1',
    income: 100,
    commission_rate: 0.6,
    commission_income: 60,
    original_fine: 0,
    fine: 0,
    type: 'income',
    source: 'manual',
    request_id: 'INC-1',
    approved_at: '2026-07-15T03:10:00.000Z',
    admin_id: 'ADMIN-1'
  }, '₫', '2026-07-28T00:00:00.000Z');

  assert.deepEqual({
    ...entry,
    metadata_json: JSON.parse(entry.metadata_json)
  }, {
    entry_id: 'PAY-MIG-REC-1',
    store_id: 'STORE-1',
    telegram_id: 'EMP-1',
    type: 'income',
    amount_micros: 60_000_000,
    currency: '₫',
    effective_at: '2026-07-15T03:10:00.000Z',
    source: 'manual',
    source_id: 'REC-1',
    created_by: 'ADMIN-1',
    created_at: '2026-07-28T00:00:00.000Z',
    reverses_entry_id: null,
    metadata_json: {
      legacy_record_id: 'REC-1',
      legacy_request_id: 'INC-1',
      legacy_income: 100,
      legacy_commission_rate: 0.6,
      legacy_commission_income: 60,
      legacy_original_fine: 0,
      legacy_fine: 0
    }
  });
});

test('reports a supported zero-effect legacy row by skipping its ledger draft', () => {
  assert.equal(legacyIncomeRecordToPayrollEntry({
    record_id: 'REC-ZERO',
    store_id: 'STORE-1',
    telegram_id: 'EMP-1',
    commission_income: 0,
    original_fine: 1.5,
    fine: 0,
    type: 'fine',
    source: 'attendance_late',
    request_id: 'ATT-1',
    approved_at: '2026-07-15T03:10:00.000Z',
    admin_id: 'ADMIN-1'
  }, '₫', '2026-07-28T00:00:00.000Z'), null);
});

test('validates the sign contract for normal ledger entries', () => {
  const validFine = {
    entry_id: 'PAY-1',
    store_id: 'STORE-1',
    telegram_id: 'EMP-1',
    type: 'fine',
    amount_micros: -1_500_000,
    currency: '₫',
    effective_at: '2026-07-15T03:10:00.000Z',
    source: 'attendance_late',
    source_id: 'ATT-1',
    created_by: 'ADMIN-1',
    created_at: '2026-07-15T03:10:01.000Z',
    reverses_entry_id: null,
    metadata_json: '{}'
  };

  assert.equal(validatePayrollEntry(validFine), validFine);
  assert.throws(
    () => validatePayrollEntry({ ...validFine, type: 'income' }),
    /income amount_micros must be positive/
  );
  assert.throws(
    () => validatePayrollEntry({
      ...validFine,
      type: 'adjustment',
      amount_micros: 0
    }),
    /adjustment amount_micros must be non-zero/
  );
  assert.throws(
    () => validatePayrollEntry({
      ...validFine,
      amount_micros: Number.MAX_SAFE_INTEGER + 1
    }),
    /safe integer/
  );
});

test('validates reversals against the exact original entry', () => {
  const original = {
    entry_id: 'PAY-ORIGINAL',
    store_id: 'STORE-1',
    telegram_id: 'EMP-1',
    type: 'fine',
    amount_micros: -1_500_000,
    currency: '₫',
    effective_at: '2026-07-15T03:10:00.000Z',
    source: 'attendance_late',
    source_id: 'ATT-1',
    created_by: 'ADMIN-1',
    created_at: '2026-07-15T03:10:01.000Z',
    reverses_entry_id: null,
    metadata_json: '{}'
  };
  const reversal = {
    ...original,
    entry_id: 'PAY-REVERSAL',
    type: 'reversal',
    amount_micros: 1_500_000,
    source: 'admin_reversal',
    source_id: null,
    created_by: 'ADMIN-2',
    created_at: '2026-07-16T03:10:01.000Z',
    reverses_entry_id: 'PAY-ORIGINAL'
  };

  assert.equal(validatePayrollEntry(reversal, original), reversal);
  assert.throws(
    () => validatePayrollEntry({ ...reversal, amount_micros: 1_499_999 }, original),
    /exact opposite/
  );
  assert.throws(
    () => validatePayrollEntry({ ...reversal, currency: '$' }, original),
    /same currency/
  );
  assert.throws(
    () => validatePayrollEntry(reversal),
    /original entry/
  );
});

test('canonical schema contains the complete payroll ledger contract', () => {
  const database = ledgerFixture();
  const columns = database.prepare(`PRAGMA table_info(payroll_entries)`).all();

  assert.deepEqual(
    columns.map((column) => column.name),
    [
      'entry_id',
      'store_id',
      'telegram_id',
      'type',
      'amount_micros',
      'currency',
      'effective_at',
      'source',
      'source_id',
      'created_by',
      'created_at',
      'reverses_entry_id',
      'metadata_json'
    ]
  );
});

test('migration 019 creates the ledger without requiring existing payroll data', () => {
  const database = new DatabaseSync(':memory:');

  database.exec(payrollLedgerMigration);

  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS total
      FROM sqlite_master
      WHERE type = 'table' AND name = 'payroll_entries'
    `).get().total,
    1
  );
  assert.equal(
    database.prepare(`SELECT COUNT(*) AS total FROM payroll_entries`).get().total,
    0
  );
});

test('ledger schema rejects invalid types, zero amounts, and invalid signs', () => {
  const database = ledgerFixture();
  const base = {
    entry_id: 'PAY-1',
    store_id: 'STORE-1',
    telegram_id: 'EMP-1',
    type: 'income',
    amount_micros: 60_000_000,
    currency: '₫',
    effective_at: '2026-07-15T03:10:00.000Z',
    source: 'manual',
    source_id: 'REC-1',
    created_by: 'ADMIN-1',
    created_at: '2026-07-28T00:00:00.000Z',
    reverses_entry_id: null,
    metadata_json: '{}'
  };

  assert.throws(
    () => insertLedgerEntry(database, {
      ...base,
      entry_id: 'PAY-UNKNOWN',
      type: 'mystery'
    }),
    /CHECK constraint failed/
  );
  assert.throws(
    () => insertLedgerEntry(database, {
      ...base,
      entry_id: 'PAY-ZERO',
      amount_micros: 0
    }),
    /CHECK constraint failed/
  );
  assert.throws(
    () => insertLedgerEntry(database, {
      ...base,
      entry_id: 'PAY-WRONG-SIGN',
      type: 'fine'
    }),
    /CHECK constraint failed/
  );
});

test('ledger schema prevents duplicate sources and duplicate reversals', () => {
  const database = ledgerFixture();
  const original = {
    entry_id: 'PAY-ORIGINAL',
    store_id: 'STORE-1',
    telegram_id: 'EMP-1',
    type: 'fine',
    amount_micros: -1_500_000,
    currency: '₫',
    effective_at: '2026-07-15T03:10:00.000Z',
    source: 'attendance_late',
    source_id: 'ATT-1',
    created_by: 'ADMIN-1',
    created_at: '2026-07-28T00:00:00.000Z',
    reverses_entry_id: null,
    metadata_json: '{}'
  };
  insertLedgerEntry(database, original);

  assert.throws(
    () => insertLedgerEntry(database, {
      ...original,
      entry_id: 'PAY-DUPLICATE'
    }),
    /UNIQUE constraint failed/
  );

  const reversal = {
    ...original,
    entry_id: 'PAY-REVERSAL-1',
    type: 'reversal',
    amount_micros: 1_500_000,
    source: 'admin_reversal',
    source_id: null,
    reverses_entry_id: 'PAY-ORIGINAL'
  };
  insertLedgerEntry(database, reversal);

  assert.throws(
    () => insertLedgerEntry(database, {
      ...reversal,
      entry_id: 'PAY-REVERSAL-2'
    }),
    /UNIQUE constraint failed/
  );
});
