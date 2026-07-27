import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  amountToMicros,
  legacyIncomeRecordToPayrollEntry,
  legacyPayrollImpactMicros,
  payrollLedgerWritesEnabled,
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
const payrollLedgerPreflight = readFileSync(
  new URL('../db/audits/019_payroll_ledger_preflight.sql', import.meta.url),
  'utf8'
);
const payrollLedgerBackfill = readFileSync(
  new URL('../db/migrations/020_backfill_payroll_entries.sql', import.meta.url),
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

function legacyMigrationFixture() {
  const database = ledgerFixture();
  database.exec(`
    INSERT INTO stores (
      store_id, name, status, timezone, currency, created_at, updated_at
    ) VALUES (
      'STORE-1', 'Store One', 'active', 'Asia/Tokyo', '₫',
      '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
    );
    INSERT INTO store_members (
      store_id, telegram_id, display_name, role, status, commission_rate,
      cycle_start, joined_at, updated_at
    ) VALUES (
      'STORE-1', 'EMP-1', 'Employee One', 'employee', 'active', 0.6,
      '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z'
    );
  `);
  return database;
}

function insertLegacyRecord(database, record) {
  database.prepare(`
    INSERT INTO income_records (
      record_id, store_id, telegram_id, income, commission_rate,
      commission_income, original_fine, fine, type, source,
      request_id, approved_at, admin_id
    ) VALUES (
      :record_id, 'STORE-1', 'EMP-1', :income, 0.6,
      :commission_income, :original_fine, :fine, :type, :source,
      :request_id, :approved_at, 'ADMIN-1'
    )
  `).run({
    income: 0,
    commission_income: 0,
    original_fine: 0,
    fine: 0,
    source: 'manual',
    request_id: null,
    approved_at: '2026-07-15T03:10:00.000Z',
    ...record
  });
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

test('enables ledger writes only for explicit dual mode', () => {
  assert.equal(payrollLedgerWritesEnabled({}), false);
  assert.equal(payrollLedgerWritesEnabled({
    PAYROLL_LEDGER_WRITE_MODE: 'off'
  }), false);
  assert.equal(payrollLedgerWritesEnabled({
    PAYROLL_LEDGER_WRITE_MODE: 'dual'
  }), true);

  const originalConsoleError = console.error;
  let errorMessage = '';
  console.error = (message) => {
    errorMessage = message;
  };
  try {
    assert.equal(payrollLedgerWritesEnabled({
      PAYROLL_LEDGER_WRITE_MODE: 'unexpected'
    }), false);
  } finally {
    console.error = originalConsoleError;
  }
  assert.match(errorMessage, /Invalid PAYROLL_LEDGER_WRITE_MODE: unexpected/);
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

test('preflight reports unknown and zero-effect legacy rows separately', () => {
  const database = legacyMigrationFixture();
  insertLegacyRecord(database, {
    record_id: 'REC-INCOME',
    type: 'income',
    income: 100,
    commission_income: 60,
    request_id: 'INC-1'
  });
  insertLegacyRecord(database, {
    record_id: 'REC-ZERO-FINE',
    type: 'fine',
    original_fine: 1.5,
    fine: 0,
    source: 'attendance_late',
    request_id: 'ATT-1'
  });
  insertLegacyRecord(database, {
    record_id: 'REC-UNKNOWN',
    type: 'mystery',
    request_id: 'UNKNOWN-1'
  });

  assert.deepEqual({ ...database.prepare(payrollLedgerPreflight).get() }, {
    unknown_type_rows: 1,
    missing_required_rows: 0,
    sub_micro_precision_rows: 0,
    unsafe_integer_rows: 0,
    missing_store_rows: 0,
    missing_member_rows: 0,
    duplicate_identity_rows: 0,
    zero_effect_rows: 1
  });
});

test('backfill stops before inserting when a legacy type is unknown', () => {
  const database = legacyMigrationFixture();
  insertLegacyRecord(database, {
    record_id: 'REC-INCOME',
    type: 'income',
    income: 100,
    commission_income: 60,
    request_id: 'INC-1'
  });
  insertLegacyRecord(database, {
    record_id: 'REC-UNKNOWN',
    type: 'mystery',
    request_id: 'UNKNOWN-1'
  });

  assert.throws(
    () => database.exec(payrollLedgerBackfill),
    /CHECK constraint failed/
  );
  assert.equal(
    database.prepare(`SELECT COUNT(*) AS total FROM payroll_entries`).get().total,
    0
  );
});

test('backfill maps supported non-zero rows exactly and is idempotent', () => {
  const database = legacyMigrationFixture();
  insertLegacyRecord(database, {
    record_id: 'REC-INCOME',
    type: 'income',
    income: 100,
    commission_income: 60,
    request_id: 'INC-1'
  });
  insertLegacyRecord(database, {
    record_id: 'REC-FINE',
    type: 'fine',
    original_fine: 5,
    fine: 5,
    source: 'manual_fine',
    request_id: 'FINE-1'
  });
  insertLegacyRecord(database, {
    record_id: 'REC-ADVANCE',
    type: 'advance',
    original_fine: 20,
    fine: 20,
    source: 'salary_advance',
    request_id: 'ADV-1'
  });
  insertLegacyRecord(database, {
    record_id: 'REC-ZERO-FINE',
    type: 'fine',
    original_fine: 1.5,
    fine: 0,
    source: 'attendance_late',
    request_id: 'ATT-1'
  });

  database.exec(payrollLedgerBackfill);
  database.exec(payrollLedgerBackfill);

  assert.deepEqual(
    database.prepare(`
      SELECT entry_id, type, amount_micros, currency, source, source_id
      FROM payroll_entries
      ORDER BY entry_id
    `).all().map((row) => ({ ...row })),
    [
      {
        entry_id: 'PAY-MIG-REC-ADVANCE',
        type: 'advance',
        amount_micros: -20_000_000,
        currency: '₫',
        source: 'salary_advance',
        source_id: 'REC-ADVANCE'
      },
      {
        entry_id: 'PAY-MIG-REC-FINE',
        type: 'fine',
        amount_micros: -5_000_000,
        currency: '₫',
        source: 'manual_fine',
        source_id: 'REC-FINE'
      },
      {
        entry_id: 'PAY-MIG-REC-INCOME',
        type: 'income',
        amount_micros: 60_000_000,
        currency: '₫',
        source: 'manual',
        source_id: 'REC-INCOME'
      }
    ]
  );
});
