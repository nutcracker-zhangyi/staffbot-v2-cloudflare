import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const schema = readFileSync(
  new URL('../db/schema.sql', import.meta.url),
  'utf8'
);
const backfill = readFileSync(
  new URL('../db/migrations/020_backfill_payroll_entries.sql', import.meta.url),
  'utf8'
);
const reconciliation = readFileSync(
  new URL('../db/audits/020_payroll_ledger_reconcile.sql', import.meta.url),
  'utf8'
);

function reconciliationFixture() {
  const database = new DatabaseSync(':memory:');
  database.exec(schema);
  database.exec(`
    INSERT INTO stores (
      store_id, name, status, timezone, currency, created_at, updated_at
    ) VALUES
      (
        'STORE-USD', 'Dollar Store', 'active', 'Asia/Tokyo', '$',
        '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
      ),
      (
        'STORE-VND', 'Dong Store', 'active', 'Asia/Ho_Chi_Minh', '₫',
        '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
      );

    INSERT INTO store_members (
      store_id, telegram_id, display_name, role, status, commission_rate,
      cycle_start, joined_at, updated_at
    ) VALUES
      (
        'STORE-USD', 'EMP-USD', 'Dollar Employee', 'employee', 'active', 0.6,
        '2026-07-16T00:00:00.000Z', '2026-07-01T00:00:00.000Z',
        '2026-07-01T00:00:00.000Z'
      ),
      (
        'STORE-VND', 'EMP-VND', 'Dong Employee', 'employee', 'active', 0.6,
        '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z',
        '2026-07-01T00:00:00.000Z'
      );

    INSERT INTO income_records (
      record_id, store_id, telegram_id, income, commission_rate,
      commission_income, original_fine, fine, type, source,
      request_id, approved_at, admin_id
    ) VALUES
      (
        'REC-USD-HISTORY-INCOME', 'STORE-USD', 'EMP-USD', 100, 0.6,
        60, 0, 0, 'income', 'manual',
        'INC-USD-HISTORY', '2026-07-10T00:00:00.000Z', 'ADMIN-1'
      ),
      (
        'REC-USD-HISTORY-FINE', 'STORE-USD', 'EMP-USD', 0, 0.6,
        0, 5, 5, 'fine', 'manual_fine',
        'FINE-USD-HISTORY', '2026-07-12T00:00:00.000Z', 'ADMIN-1'
      ),
      (
        'REC-USD-BOUNDARY', 'STORE-USD', 'EMP-USD', 20, 0.6,
        12, 0, 0, 'income', 'manual',
        'INC-USD-BOUNDARY', '2026-07-16T00:00:00.000Z', 'ADMIN-1'
      ),
      (
        'REC-VND-CURRENT', 'STORE-VND', 'EMP-VND', 3000000, 0.6,
        1800000, 0, 0, 'income', 'manual',
        'INC-VND-CURRENT', '2026-07-20T00:00:00.000Z', 'ADMIN-2'
      ),
      (
        'REC-VND-ADVANCE', 'STORE-VND', 'EMP-VND', 0, 0.6,
        0, 500000, 500000, 'advance', 'salary_advance',
        'ADV-VND', '2026-07-21T00:00:00.000Z', 'ADMIN-2'
      );

    INSERT INTO salary_records (
      record_id, store_id, telegram_id, amount, period_start, period_end,
      approved_at, admin_id, request_id
    ) VALUES (
      'SAL-USD-1', 'STORE-USD', 'EMP-USD', 55,
      '2026-07-01T00:00:00.000Z', '2026-07-16T00:00:00.000Z',
      '2026-07-16T00:00:01.000Z', 'ADMIN-1', 'SALREQ-USD-1'
    );
  `);
  database.exec(backfill);
  return database;
}

function discrepancies(database) {
  return database.prepare(reconciliation).all().map((row) => ({ ...row }));
}

test('reconciliation returns no differences after an exact historical backfill', () => {
  const database = reconciliationFixture();

  assert.deepEqual(discrepancies(database), []);
});

test('reconciliation locates a one-micro historical employee-period difference', () => {
  const database = reconciliationFixture();
  database.exec(`
    UPDATE payroll_entries
    SET amount_micros = amount_micros + 1
    WHERE entry_id = 'PAY-MIG-REC-USD-HISTORY-INCOME'
  `);

  const rows = discrepancies(database);
  const period = rows.find((row) => (
    row.scope === 'historical_period'
    && row.scope_id === 'SAL-USD-1'
  ));

  assert.deepEqual(period, {
    scope: 'historical_period',
    scope_id: 'SAL-USD-1',
    store_id: 'STORE-USD',
    telegram_id: 'EMP-USD',
    period_start: '2026-07-01T00:00:00.000Z',
    period_end: '2026-07-16T00:00:00.000Z',
    currency: '$',
    entry_type: null,
    legacy_micros: 55_000_000,
    ledger_micros: 55_000_001,
    difference_micros: 1
  });
  assert.ok(rows.some((row) => (
    row.scope === 'type_total'
    && row.store_id === 'STORE-USD'
    && row.currency === '$'
    && row.entry_type === 'income'
    && row.difference_micros === 1
  )));
  assert.ok(rows.some((row) => (
    row.scope === 'store_currency_total'
    && row.store_id === 'STORE-USD'
    && row.currency === '$'
    && row.difference_micros === 1
  )));
});

test('reconciliation uses a left-closed right-open payroll boundary', () => {
  const database = reconciliationFixture();
  database.exec(`
    UPDATE payroll_entries
    SET amount_micros = amount_micros + 1
    WHERE entry_id = 'PAY-MIG-REC-USD-BOUNDARY'
  `);

  const rows = discrepancies(database);

  assert.equal(
    rows.some((row) => row.scope === 'historical_period'),
    false
  );
  assert.ok(rows.some((row) => (
    row.scope === 'current_cycle'
    && row.store_id === 'STORE-USD'
    && row.telegram_id === 'EMP-USD'
    && row.period_start === '2026-07-16T00:00:00.000Z'
    && row.difference_micros === 1
  )));
});
