import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  comparePayrollTotals,
  getLedgerTotalIncomeMicros,
  getLegacyTotalIncomeMicros,
  getTotalIncome
} from '../src/payroll.js';
import { createD1 } from './helpers/d1.js';

const schema = readFileSync(
  new URL('../db/schema.sql', import.meta.url),
  'utf8'
);

const START = '2020-01-01T00:00:00.000Z';
const END = '2020-02-01T00:00:00.000Z';
const LEGACY_MICROS = 11_345_679;
const CURRENT_MICROS = 20_345_679;

function shadowFixture({ mode = 'legacy', hooks } = {}) {
  const database = new DatabaseSync(':memory:');
  database.exec(schema);
  database.exec(`
    INSERT INTO stores (
      store_id, name, status, timezone, currency, created_at, updated_at
    ) VALUES (
      'STORE1', 'Store One', 'active', 'Asia/Tokyo', '$',
      '${START}', '${START}'
    );
    INSERT INTO store_members (
      store_id, telegram_id, display_name, role, status, commission_rate,
      cycle_start, joined_at, absence_check_enabled, updated_at
    ) VALUES (
      'STORE1', 'EMP1', 'Employee One', 'employee', 'active', 0.6,
      '${START}', '${START}', 1, '${START}'
    );

    INSERT INTO income_records (
      record_id, store_id, telegram_id, income, commission_rate,
      commission_income, original_fine, fine, type, source,
      request_id, approved_at, admin_id
    ) VALUES
      (
        'REC-INCOME', 'STORE1', 'EMP1', 20.5761306667, 0.6,
        12.3456784, 0, 0, 'income', 'manual',
        'INC-1', '2020-01-10T00:00:00.000Z', 'ADMIN1'
      ),
      (
        'REC-FINE', 'STORE1', 'EMP1', 0, 0.6,
        0, 1.0000006, 1.0000006, 'fine', 'manual_fine',
        'FINE-1', '2020-01-11T00:00:00.000Z', 'ADMIN1'
      ),
      (
        'REC-TINY-1', 'STORE1', 'EMP1', 0.000001, 0.6,
        0.0000006, 0, 0, 'income', 'manual',
        'INC-TINY-1', '2020-01-12T00:00:00.000Z', 'ADMIN1'
      ),
      (
        'REC-TINY-2', 'STORE1', 'EMP1', 0.000001, 0.6,
        0.0000006, 0, 0, 'income', 'manual',
        'INC-TINY-2', '2020-01-13T00:00:00.000Z', 'ADMIN1'
      ),
      (
        'REC-END', 'STORE1', 'EMP1', 15, 0.6,
        9, 0, 0, 'income', 'manual',
        'INC-END', '${END}', 'ADMIN1'
      );

    INSERT INTO payroll_entries (
      entry_id, store_id, telegram_id, type, amount_micros, currency,
      effective_at, source, source_id, created_by, created_at,
      reverses_entry_id, metadata_json
    ) VALUES
      (
        'PAY-INCOME', 'STORE1', 'EMP1', 'income', 12345678, '$',
        '2020-01-10T00:00:00.000Z', 'manual', 'REC-INCOME',
        'ADMIN1', '2020-01-10T00:00:00.000Z', NULL, '{}'
      ),
      (
        'PAY-FINE', 'STORE1', 'EMP1', 'fine', -1000001, '$',
        '2020-01-11T00:00:00.000Z', 'manual_fine', 'REC-FINE',
        'ADMIN1', '2020-01-11T00:00:00.000Z', NULL, '{}'
      ),
      (
        'PAY-TINY-1', 'STORE1', 'EMP1', 'income', 1, '$',
        '2020-01-12T00:00:00.000Z', 'manual', 'REC-TINY-1',
        'ADMIN1', '2020-01-12T00:00:00.000Z', NULL, '{}'
      ),
      (
        'PAY-TINY-2', 'STORE1', 'EMP1', 'income', 1, '$',
        '2020-01-13T00:00:00.000Z', 'manual', 'REC-TINY-2',
        'ADMIN1', '2020-01-13T00:00:00.000Z', NULL, '{}'
      ),
      (
        'PAY-END', 'STORE1', 'EMP1', 'income', 9000000, '$',
        '${END}', 'manual', 'REC-END',
        'ADMIN1', '${END}', NULL, '{}'
      );
  `);
  return {
    database,
    env: {
      DB: createD1(database, hooks),
      PAYROLL_LEDGER_READ_MODE: mode
    }
  };
}

test('compares row-rounded legacy micros with ledger micros in [start, end)', async () => {
  const { env } = shadowFixture();

  assert.equal(
    await getLegacyTotalIncomeMicros(env, 'STORE1', 'EMP1', START, END),
    LEGACY_MICROS
  );
  assert.equal(
    await getLedgerTotalIncomeMicros(env, 'STORE1', 'EMP1', START, END),
    LEGACY_MICROS
  );
  assert.deepEqual(
    await comparePayrollTotals(env, 'STORE1', 'EMP1', START, END),
    {
      store_id: 'STORE1',
      telegram_id: 'EMP1',
      start: START,
      end: END,
      legacy_micros: LEGACY_MICROS,
      ledger_micros: LEGACY_MICROS,
      difference_micros: 0,
      matches: true
    }
  );
});

test('legacy mode returns the old result without querying payroll entries', async () => {
  const { env } = shadowFixture({
    mode: 'legacy',
    hooks: {
      beforeFirst(sql) {
        if (sql.includes('FROM payroll_entries')) {
          throw new Error('legacy mode queried payroll entries');
        }
      }
    }
  });

  assert.equal(await getTotalIncome(env, 'STORE1', 'EMP1'), 20.345679);
});

test('shadow mode returns the old result without logging equal totals', async () => {
  const { database, env } = shadowFixture({ mode: 'shadow' });

  assert.equal(await getTotalIncome(env, 'STORE1', 'EMP1'), 20.345679);
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS total
      FROM bot_logs WHERE event = 'payroll_shadow_mismatch'
    `).get().total,
    0
  );
});

test('shadow mode returns the old result and logs only redacted mismatch fields', async () => {
  const { database, env } = shadowFixture({ mode: 'shadow' });
  database.exec(`
    UPDATE payroll_entries
    SET amount_micros = amount_micros + 1
    WHERE entry_id = 'PAY-INCOME'
  `);

  assert.equal(await getTotalIncome(env, 'STORE1', 'EMP1'), 20.345679);
  const log = database.prepare(`
    SELECT level, event, telegram_id, message_text, payload_json
    FROM bot_logs WHERE event = 'payroll_shadow_mismatch'
  `).get();

  assert.equal(log.level, 'warn');
  assert.equal(log.event, 'payroll_shadow_mismatch');
  assert.equal(log.telegram_id, 'EMP1');
  assert.equal(log.message_text, null);
  const payload = JSON.parse(log.payload_json);
  const { end, ...payloadWithoutEnd } = payload;
  assert.match(end, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(payloadWithoutEnd, {
    store_id: 'STORE1',
    telegram_id: 'EMP1',
    start: START,
    legacy_micros: CURRENT_MICROS,
    ledger_micros: CURRENT_MICROS + 1,
    difference_micros: 1
  });
});

test('ledger mode returns the signed amount field without querying legacy rows', async () => {
  const { database, env } = shadowFixture({
    mode: 'ledger',
    hooks: {
      beforeFirst(sql) {
        if (sql.includes('FROM income_records')) {
          throw new Error('ledger mode queried legacy rows');
        }
      }
    }
  });
  database.exec(`
    UPDATE payroll_entries
    SET amount_micros = amount_micros + 1
    WHERE entry_id = 'PAY-INCOME'
  `);

  assert.equal(await getTotalIncome(env, 'STORE1', 'EMP1'), 20.34568);
});
