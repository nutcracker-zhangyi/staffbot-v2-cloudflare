import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { createD1 } from './helpers/d1.js';

import {
  DashboardInputError,
  dashboardAvailable,
  dashboardPeriods,
  dashboardPeriodsJson,
  dashboardSelection,
  loadDashboard,
  loadDashboardEntries,
  resolveDashboardFilters
} from '../src/dashboard.js';

const schema = readFileSync(
  new URL('../db/schema.sql', import.meta.url),
  'utf8'
);

function dashboardFixture(hooks = {}) {
  const database = new DatabaseSync(':memory:');
  database.exec(schema);
  const insert = (sql, ...values) => database.prepare(sql).run(...values);
  const now = '2026-07-01T00:00:00.000Z';

  for (const [storeId, name, timezone, currency] of [
    ['TOKYO', 'Tokyo', 'Asia/Tokyo', '¥'],
    ['NEW_YORK', 'New York', 'America/New_York', '$']
  ]) {
    insert(
      `INSERT INTO stores (
        store_id, name, timezone, currency, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      storeId, name, timezone, currency, now, now
    );
  }

  for (const [telegramId, name] of [
    ['EMP-1', 'Alice'],
    ['EMP-2', 'Bob'],
    ['ADMIN-1', 'Owner']
  ]) {
    insert(
      `INSERT INTO users (
        telegram_id, name, cycle_start, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)`,
      telegramId, name, '2026-07-01', now, now
    );
  }

  for (const [storeId, telegramId, displayName, role] of [
    ['TOKYO', 'EMP-1', 'Alice', 'employee'],
    ['TOKYO', 'ADMIN-1', 'Owner', 'owner'],
    ['NEW_YORK', 'EMP-2', 'Bob', 'employee'],
    ['NEW_YORK', 'ADMIN-1', 'Owner', 'owner']
  ]) {
    insert(
      `INSERT INTO store_members (
        store_id, telegram_id, display_name, role, cycle_start, joined_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      storeId, telegramId, displayName, role, '2026-07-01', now, now
    );
  }

  const income = (recordId, storeId, telegramId, amount, approvedAt) => insert(
    `INSERT INTO income_records (
      record_id, store_id, telegram_id, income, type, approved_at, admin_id
    ) VALUES (?, ?, ?, ?, 'income', ?, 'ADMIN-1')`,
    recordId, storeId, telegramId, amount, approvedAt
  );
  income('tokyo-income', 'TOKYO', 'EMP-1', 1000, '2026-06-30T15:00:00.000Z');
  income('tokyo-income-rounding-a', 'TOKYO', 'EMP-1', 0.0000006, '2026-06-30T15:00:00.000Z');
  income('tokyo-income-rounding-b', 'TOKYO', 'EMP-1', 0.0000006, '2026-06-30T15:00:00.000Z');
  income('tokyo-before-start', 'TOKYO', 'EMP-1', 999, '2026-06-30T14:59:59.999999Z');
  income('ny-income', 'NEW_YORK', 'EMP-2', 200, '2026-07-01T04:00:00.000Z');
  income('ny-before-start', 'NEW_YORK', 'EMP-2', 999, '2026-07-01T03:59:59.999999Z');

  const ledger = (entryId, storeId, telegramId, type, amountMicros, currency, effectiveAt, reverses = null) => insert(
    `INSERT INTO payroll_entries (
      entry_id, store_id, telegram_id, type, amount_micros, currency, effective_at,
      source, source_id, created_by, created_at, reverses_entry_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'test', ?, 'ADMIN-1', ?, ?)`,
    entryId, storeId, telegramId, type, amountMicros, currency, effectiveAt, entryId, now, reverses
  );
  ledger('tokyo-income-entry', 'TOKYO', 'EMP-1', 'income', 600_000_000, '¥', now);
  ledger('tokyo-fine-entry', 'TOKYO', 'EMP-1', 'fine', -50_000_000, '¥', now);
  ledger('tokyo-advance-entry', 'TOKYO', 'EMP-1', 'advance', -100_000_000, '¥', now);
  ledger('tokyo-adjustment-entry', 'TOKYO', 'EMP-1', 'adjustment', 25_000_000, '¥', now);
  ledger('tokyo-reversal-entry', 'TOKYO', 'EMP-1', 'reversal', 50_000_000, '¥', now, 'tokyo-fine-entry');
  ledger('tokyo-before-start', 'TOKYO', 'EMP-1', 'income', 999_000_000, '¥', '2026-06-30T14:59:59.999999Z');
  ledger('ny-income-entry', 'NEW_YORK', 'EMP-2', 'income', 120_000_000, '$', '2026-07-01T04:00:00.000Z');
  ledger('ny-before-start', 'NEW_YORK', 'EMP-2', 'income', 999_000_000, '$', '2026-07-01T03:59:59.999999Z');

  const payment = (recordId, storeId, telegramId, amount, approvedAt) => insert(
    `INSERT INTO salary_records (
      record_id, store_id, telegram_id, amount, period_start, period_end, approved_at, admin_id
    ) VALUES (?, ?, ?, ?, '2026-07-01', '2026-07-31', ?, 'ADMIN-1')`,
    recordId, storeId, telegramId, amount, approvedAt
  );
  payment('tokyo-payment', 'TOKYO', 'EMP-1', 400, now);
  payment('tokyo-payment-rounding-a', 'TOKYO', 'EMP-1', 0.0000006, now);
  payment('tokyo-payment-rounding-b', 'TOKYO', 'EMP-1', 0.0000006, now);
  payment('tokyo-payment-before-start', 'TOKYO', 'EMP-1', 999, '2026-06-30T14:59:59.999999Z');
  payment('ny-payment', 'NEW_YORK', 'EMP-2', 100, '2026-07-01T04:00:00.000Z');
  payment('ny-payment-before-start', 'NEW_YORK', 'EMP-2', 999, '2026-07-01T03:59:59.999999Z');

  return { database, env: { DB: createD1(database, hooks) } };
}

function dashboardFixtureWithManyEntries() {
  const { database, env } = dashboardFixture();
  const now = '2026-07-01T00:00:00.000Z';
  database.exec('DELETE FROM payroll_entries');
  database.prepare(`
    INSERT INTO store_members (
      store_id, telegram_id, display_name, role, cycle_start, joined_at, updated_at
    ) VALUES ('TOKYO', 'EMP-2', 'Bob', 'employee', '2026-07-01', ?, ?)
  `).run(now, now);
  const ledger = (entryId, telegramId, type, amountMicros, effectiveAt, reverses = null) => {
    database.prepare(`
      INSERT INTO payroll_entries (
        entry_id, store_id, telegram_id, type, amount_micros, currency, effective_at,
        source, source_id, created_by, created_at, reverses_entry_id, metadata_json
      ) VALUES (?, 'TOKYO', ?, ?, ?, '¥', ?, 'test', ?, 'ADMIN-1', ?, ?, '{"private":"excluded"}')
    `).run(entryId, telegramId, type, amountMicros, effectiveAt, entryId, now, reverses);
  };
  ledger('PAY-BEFORE-1', 'EMP-1', 'income', 1_000_000, '2026-06-30T14:59:59.999999Z');
  ledger('PAY-FINE-1', 'EMP-1', 'fine', -1_000_000, now);
  ledger('PAY-REVERSAL-1', 'EMP-1', 'reversal', 1_000_000, now, 'PAY-FINE-1');
  for (let index = 1; index <= 99; index += 1) {
    ledger(
      `PAY-ENTRY-${String(index).padStart(3, '0')}`,
      'EMP-1',
      'income',
      index * 1_000_000,
      now
    );
  }
  ledger('PAY-OTHER-1', 'EMP-2', 'income', 2_000_000, now);
  return { database, env };
}

const stores = [
  {
    store_id: 'TOKYO',
    timezone: 'Asia/Tokyo',
    currency: '¥'
  },
  {
    store_id: 'NEW_YORK',
    timezone: 'America/New_York',
    currency: '$'
  }
];

test('enables Dashboard only in staging', () => {
  assert.equal(dashboardAvailable({ ENVIRONMENT: 'staging' }), true);
  assert.equal(dashboardAvailable({ ENVIRONMENT: 'production' }), false);
  assert.equal(dashboardAvailable({}), false);
});

test('defaults Dashboard to the fallback store local current month', () => {
  assert.deepEqual(
    dashboardSelection('', '', 'Asia/Tokyo', new Date('2026-07-31T16:00:00.000Z')),
    { date_from: '2026-08-01', date_to: '2026-08-31' }
  );
});

test('requires two valid ordered Dashboard dates', () => {
  for (const pair of [
    ['2026-07-01', ''],
    ['', '2026-07-31'],
    ['2026-07-32', '2026-08-01'],
    ['2026-08-01', '2026-07-31']
  ]) {
    assert.throws(
      () => dashboardSelection(pair[0], pair[1], 'Asia/Tokyo'),
      (error) => error instanceof DashboardInputError
        && error.code === 'invalid_date_range'
    );
  }
});

test('builds one UTC range per store local month', () => {
  const periods = dashboardPeriods(stores, {
    date_from: '2026-07-01',
    date_to: '2026-07-31'
  });

  assert.deepEqual(periods, [
    {
      store_id: 'TOKYO',
      store_currency: '¥',
      timezone: 'Asia/Tokyo',
      month_key: '2026-07',
      start_iso: '2026-06-30T15:00:00.000Z',
      end_iso: '2026-07-31T15:00:00.000Z'
    },
    {
      store_id: 'NEW_YORK',
      store_currency: '$',
      timezone: 'America/New_York',
      month_key: '2026-07',
      start_iso: '2026-07-01T04:00:00.000Z',
      end_iso: '2026-08-01T04:00:00.000Z'
    }
  ]);
  assert.deepEqual(JSON.parse(dashboardPeriodsJson(periods)), periods);
});

test('clips a two-month selection into non-overlapping monthly store ranges', () => {
  const periods = dashboardPeriods(stores, {
    date_from: '2026-07-15',
    date_to: '2026-08-10'
  });

  assert.deepEqual(periods, [
    {
      store_id: 'TOKYO',
      store_currency: '¥',
      timezone: 'Asia/Tokyo',
      month_key: '2026-07',
      start_iso: '2026-07-14T15:00:00.000Z',
      end_iso: '2026-07-31T15:00:00.000Z'
    },
    {
      store_id: 'NEW_YORK',
      store_currency: '$',
      timezone: 'America/New_York',
      month_key: '2026-07',
      start_iso: '2026-07-15T04:00:00.000Z',
      end_iso: '2026-08-01T04:00:00.000Z'
    },
    {
      store_id: 'TOKYO',
      store_currency: '¥',
      timezone: 'Asia/Tokyo',
      month_key: '2026-08',
      start_iso: '2026-07-31T15:00:00.000Z',
      end_iso: '2026-08-10T15:00:00.000Z'
    },
    {
      store_id: 'NEW_YORK',
      store_currency: '$',
      timezone: 'America/New_York',
      month_key: '2026-08',
      start_iso: '2026-08-01T04:00:00.000Z',
      end_iso: '2026-08-11T04:00:00.000Z'
    }
  ]);
  assert.equal(periods[0].end_iso, periods[2].start_iso);
  assert.equal(periods[1].end_iso, periods[3].start_iso);
});

test('aggregates gross sales, ledger types, payments, and currencies exactly', async () => {
  const { env } = dashboardFixture();
  const url = new URL(
    'https://staffbot.test/api/admin/stores/TOKYO/dashboard'
      + '?stores=TOKYO,NEW_YORK'
      + '&date_from=2026-07-01'
      + '&date_to=2026-07-31'
  );
  const filters = await resolveDashboardFilters(
    env,
    url,
    'TOKYO',
    'ADMIN-1'
  );
  const result = await loadDashboard(env, filters);

  assert.equal(result.ok, true);
  assert.equal(result.groups.length, 2);

  const yen = result.groups.find((group) => group.currency === '¥');
  assert.deepEqual(yen.summary, {
    gross_income_micros: 1_000_000_002,
    commission_micros: 600_000_000,
    fine_micros: -50_000_000,
    advance_micros: -100_000_000,
    bonus_micros: 0,
    adjustment_micros: 25_000_000,
    negative_carry_micros: 0,
    reversal_micros: 50_000_000,
    net_payroll_micros: 525_000_000,
    paid_salary_micros: 400_000_002,
    employee_count: 2
  });
  assert.deepEqual(yen.composition, [
    { type: 'income', amount_micros: 600_000_000 },
    { type: 'fine', amount_micros: -50_000_000 },
    { type: 'advance', amount_micros: -100_000_000 },
    { type: 'bonus', amount_micros: 0 },
    { type: 'adjustment', amount_micros: 25_000_000 },
    { type: 'negative_carry', amount_micros: 0 },
    { type: 'reversal', amount_micros: 50_000_000 }
  ]);

  const dollars = result.groups.find((group) => group.currency === '$');
  assert.equal(dollars.summary.gross_income_micros, 200_000_000);
  assert.equal(dollars.summary.net_payroll_micros, 120_000_000);
  assert.equal(dollars.summary.paid_salary_micros, 100_000_000);
});

test('sorts each currency employee list by the selected metric for chart order', async () => {
  const { env } = dashboardFixture();
  const url = new URL(
    'https://staffbot.test/api/admin/stores/TOKYO/dashboard'
      + '?stores=TOKYO,NEW_YORK'
      + '&date_from=2026-07-01'
      + '&date_to=2026-07-31'
      + '&employees_sort=gross_income_micros'
      + '&employees_dir=asc'
  );
  const filters = await resolveDashboardFilters(env, url, 'TOKYO', 'ADMIN-1');
  const result = await loadDashboard(env, filters);

  assert.deepEqual(
    result.groups.find((group) => group.currency === '¥').employees
      .map((employee) => employee.telegram_id),
    ['ADMIN-1', 'EMP-1']
  );
  assert.deepEqual(
    result.groups.find((group) => group.currency === '$').employees
      .map((employee) => employee.telegram_id),
    ['ADMIN-1', 'EMP-2']
  );
});

test('rejects invalid employee sort input', async () => {
  const { env } = dashboardFixture();
  const url = new URL(
    'https://staffbot.test/api/admin/stores/TOKYO/dashboard'
      + '?employees_sort=role'
  );

  await assert.rejects(
    () => resolveDashboardFilters(env, url, 'TOKYO', 'ADMIN-1'),
    (error) => error instanceof DashboardInputError && error.code === 'invalid_sort'
  );
});

test('filters employees while retaining only matching active member counts', async () => {
  const { env } = dashboardFixture();
  const url = new URL(
    'https://staffbot.test/api/admin/stores/TOKYO/dashboard'
      + '?stores=TOKYO,NEW_YORK'
      + '&date_from=2026-07-01'
      + '&date_to=2026-07-31'
      + '&employee=EMP-1'
  );
  const filters = await resolveDashboardFilters(env, url, 'TOKYO', 'ADMIN-1');
  const result = await loadDashboard(env, filters);

  assert.deepEqual(result.groups.map((group) => group.currency), ['¥']);
  assert.equal(result.groups[0].summary.employee_count, 1);
  assert.deepEqual(result.groups[0].employees.map((employee) => employee.telegram_id), ['EMP-1']);
});

test('excludes records one microsecond before each store local July start', async () => {
  const { env } = dashboardFixture();
  const url = new URL(
    'https://staffbot.test/api/admin/stores/TOKYO/dashboard'
      + '?stores=TOKYO,NEW_YORK'
      + '&date_from=2026-07-01'
      + '&date_to=2026-07-31'
  );
  const result = await loadDashboard(
    env,
    await resolveDashboardFilters(env, url, 'TOKYO', 'ADMIN-1')
  );

  const yen = result.groups.find((group) => group.currency === '¥').summary;
  const dollars = result.groups.find((group) => group.currency === '$').summary;
  assert.deepEqual(
    [yen.gross_income_micros, yen.commission_micros, yen.paid_salary_micros],
    [1_000_000_002, 600_000_000, 400_000_002]
  );
  assert.deepEqual(
    [dollars.gross_income_micros, dollars.commission_micros, dollars.paid_salary_micros],
    [200_000_000, 120_000_000, 100_000_000]
  );
});

test('uses four aggregate reads even with 100 extra active members', async () => {
  let allCalls = 0;
  const { database, env } = dashboardFixture({
    beforeAll() {
      allCalls += 1;
    }
  });
  const now = '2026-07-01T00:00:00.000Z';
  for (let index = 0; index < 100; index += 1) {
    const telegramId = `EXTRA-${index}`;
    database.prepare(`
      INSERT INTO users (telegram_id, name, cycle_start, created_at, updated_at)
      VALUES (?, ?, '2026-07-01', ?, ?)
    `).run(telegramId, telegramId, now, now);
    database.prepare(`
      INSERT INTO store_members (
        store_id, telegram_id, display_name, cycle_start, joined_at, updated_at
      ) VALUES ('TOKYO', ?, ?, '2026-07-01', ?, ?)
    `).run(telegramId, telegramId, now, now);
  }
  const url = new URL(
    'https://staffbot.test/api/admin/stores/TOKYO/dashboard'
      + '?stores=TOKYO,NEW_YORK'
      + '&date_from=2026-07-01'
      + '&date_to=2026-07-31'
  );
  const filters = await resolveDashboardFilters(env, url, 'TOKYO', 'ADMIN-1');
  allCalls = 0;

  await loadDashboard(env, filters);

  assert.equal(allCalls, 4);
});

test('merges a third selected store with the same currency into one group', async () => {
  const { database, env } = dashboardFixture();
  const now = '2026-07-01T00:00:00.000Z';
  database.prepare(`
    INSERT INTO stores (store_id, name, timezone, currency, created_at, updated_at)
    VALUES ('OSAKA', 'Osaka', 'Asia/Tokyo', '¥', ?, ?)
  `).run(now, now);
  for (const [telegramId, displayName, role] of [
    ['EMP-3', 'Cara', 'employee'],
    ['ADMIN-1', 'Owner', 'owner']
  ]) {
    database.prepare(`
      INSERT INTO store_members (
        store_id, telegram_id, display_name, role, cycle_start, joined_at, updated_at
      ) VALUES ('OSAKA', ?, ?, ?, '2026-07-01', ?, ?)
    `).run(telegramId, displayName, role, now, now);
  }
  database.prepare(`
    INSERT INTO income_records (
      record_id, store_id, telegram_id, income, type, approved_at, admin_id
    ) VALUES ('osaka-income', 'OSAKA', 'EMP-3', 10, 'income', ?, 'ADMIN-1')
  `).run(now);
  const url = new URL(
    'https://staffbot.test/api/admin/stores/TOKYO/dashboard'
      + '?stores=TOKYO,NEW_YORK,OSAKA'
      + '&date_from=2026-07-01'
      + '&date_to=2026-07-31'
  );
  const result = await loadDashboard(
    env,
    await resolveDashboardFilters(env, url, 'TOKYO', 'ADMIN-1')
  );

  assert.equal(result.groups.filter((group) => group.currency === '¥').length, 1);
  assert.equal(
    result.groups.find((group) => group.currency === '¥').summary.gross_income_micros,
    1_010_000_002
  );
});

test('returns active-member currency groups with zero money for an empty range', async () => {
  const { env } = dashboardFixture();
  const url = new URL(
    'https://staffbot.test/api/admin/stores/TOKYO/dashboard'
      + '?stores=TOKYO,NEW_YORK'
      + '&date_from=2026-08-01'
      + '&date_to=2026-08-31'
  );
  const result = await loadDashboard(
    env,
    await resolveDashboardFilters(env, url, 'TOKYO', 'ADMIN-1')
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.groups.map((group) => group.currency), ['$', '¥']);
  for (const group of result.groups) {
    assert.equal(group.summary.employee_count, 2);
    for (const field of Object.keys(group.summary).filter((field) => field !== 'employee_count')) {
      assert.equal(group.summary[field], 0);
    }
  }
});

test('keeps disabled historical employees visible without counting them as active', async () => {
  const { database, env } = dashboardFixture();
  const now = '2026-07-01T00:00:00.000Z';
  database.prepare(`
    INSERT INTO users (telegram_id, name, cycle_start, created_at, updated_at)
    VALUES ('FORMER-1', 'Former Alice', '2026-07-01', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO store_members (
      store_id, telegram_id, display_name, status, cycle_start, joined_at, updated_at
    ) VALUES ('TOKYO', 'FORMER-1', 'Former Alice', 'disabled', '2026-07-01', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO income_records (
      record_id, store_id, telegram_id, income, type, approved_at, admin_id
    ) VALUES ('former-income', 'TOKYO', 'FORMER-1', 10, 'income', ?, 'ADMIN-1')
  `).run(now);
  const url = new URL(
    'https://staffbot.test/api/admin/stores/TOKYO/dashboard'
      + '?stores=TOKYO'
      + '&date_from=2026-07-01'
      + '&date_to=2026-07-31'
      + '&employee=FORMER-1'
  );
  const result = await loadDashboard(
    env,
    await resolveDashboardFilters(env, url, 'TOKYO', 'ADMIN-1')
  );

  assert.deepEqual(result.groups[0].employees.map((employee) => employee.display_name), ['Former Alice']);
  assert.equal(result.groups[0].summary.employee_count, 0);
});

test('rejects an intermediate unsafe payroll accumulation before cancellation can hide it', async () => {
  const { database, env } = dashboardFixture();
  const now = '2026-07-01T00:00:00.000Z';
  database.exec('DELETE FROM payroll_entries');
  for (const [entryId, type, amountMicros] of [
    ['overflow-adjustment', 'adjustment', Number.MAX_SAFE_INTEGER],
    ['overflow-bonus', 'bonus', 2],
    ['overflow-fine', 'fine', -Number.MAX_SAFE_INTEGER]
  ]) {
    database.prepare(`
      INSERT INTO payroll_entries (
        entry_id, store_id, telegram_id, type, amount_micros, currency, effective_at,
        source, source_id, created_by, created_at
      ) VALUES (?, 'TOKYO', 'EMP-1', ?, ?, '¥', ?, 'test', ?, 'ADMIN-1', ?)
    `).run(entryId, type, amountMicros, now, entryId, now);
  }
  const url = new URL(
    'https://staffbot.test/api/admin/stores/TOKYO/dashboard'
      + '?stores=TOKYO'
      + '&date_from=2026-07-01'
      + '&date_to=2026-07-31'
  );

  await assert.rejects(
    async () => loadDashboard(env, await resolveDashboardFilters(env, url, 'TOKYO', 'ADMIN-1')),
    RangeError
  );
});

test('returns immutable ledger detail with reversal and stable pagination', async () => {
  const { env } = dashboardFixtureWithManyEntries();
  const url = new URL(
    'https://staffbot.test/api/admin/stores/TOKYO/dashboard/entries'
      + '?stores=TOKYO'
      + '&date_from=2026-07-01'
      + '&date_to=2026-07-31'
      + '&employee=EMP-1'
      + '&entries_page=1'
  );
  const filters = await resolveDashboardFilters(env, url, 'TOKYO', 'ADMIN-1');
  const result = await loadDashboardEntries(env, url, filters);

  assert.equal(result.ok, true);
  assert.equal(result.entries.length, 100);
  assert.deepEqual(result.pagination.entries, {
    page: 1,
    page_size: 100,
    total: 101,
    total_pages: 2,
    has_prev: false,
    has_next: true,
    limit: 100,
    offset: 0
  });
  assert.deepEqual(
    result.entries.slice(0, 3).map((entry) => entry.entry_id),
    ['PAY-REVERSAL-1', 'PAY-FINE-1', 'PAY-ENTRY-099']
  );
  assert.equal(result.entries.at(-1).entry_id, 'PAY-ENTRY-002');
  assert.ok(result.entries.some((entry) =>
    entry.type === 'reversal'
      && entry.reverses_entry_id === 'PAY-FINE-1'
  ));
  assert.ok(result.entries.every((entry) => entry.currency === '¥'));
  assert.equal(
    Object.prototype.hasOwnProperty.call(result.entries[0], 'metadata_json'),
    false
  );
});

test('returns the final stable entry on page two', async () => {
  const { env } = dashboardFixtureWithManyEntries();
  const url = new URL(
    'https://staffbot.test/api/admin/stores/TOKYO/dashboard/entries'
      + '?stores=TOKYO'
      + '&date_from=2026-07-01'
      + '&date_to=2026-07-31'
      + '&employee=EMP-1'
      + '&entries_page=2'
  );
  const result = await loadDashboardEntries(
    env,
    url,
    await resolveDashboardFilters(env, url, 'TOKYO', 'ADMIN-1')
  );

  assert.deepEqual(result.entries.map((entry) => entry.entry_id), ['PAY-ENTRY-001']);
  assert.deepEqual(result.pagination.entries, {
    page: 2,
    page_size: 100,
    total: 101,
    total_pages: 2,
    has_prev: true,
    has_next: false,
    limit: 100,
    offset: 100
  });
});

test('returns an empty immutable ledger page for a selected range with no entries', async () => {
  const { env } = dashboardFixtureWithManyEntries();
  const url = new URL(
    'https://staffbot.test/api/admin/stores/TOKYO/dashboard/entries'
      + '?stores=TOKYO'
      + '&date_from=2026-08-01'
      + '&date_to=2026-08-31'
      + '&employee=EMP-1'
      + '&entries_page=2'
  );
  const result = await loadDashboardEntries(
    env,
    url,
    await resolveDashboardFilters(env, url, 'TOKYO', 'ADMIN-1')
  );

  assert.deepEqual(result.entries, []);
  assert.deepEqual(result.pagination.entries, {
    page: 1,
    page_size: 100,
    total: 0,
    total_pages: 1,
    has_prev: false,
    has_next: false,
    limit: 100,
    offset: 0
  });
});

test('rejects an unknown ledger employee before running the detail query', async () => {
  const { env } = dashboardFixtureWithManyEntries();
  const url = new URL(
    'https://staffbot.test/api/admin/stores/TOKYO/dashboard/entries?employee=UNKNOWN'
  );

  await assert.rejects(
    () => resolveDashboardFilters(env, url, 'TOKYO', 'ADMIN-1'),
    (error) => error instanceof DashboardInputError && error.code === 'unknown_employee'
  );
});

test('keeps other employees out of a selected employee ledger drill-down', async () => {
  const { env } = dashboardFixtureWithManyEntries();
  const url = new URL(
    'https://staffbot.test/api/admin/stores/TOKYO/dashboard/entries'
      + '?stores=TOKYO'
      + '&date_from=2026-07-01'
      + '&date_to=2026-07-31'
      + '&employee=EMP-1'
  );
  const result = await loadDashboardEntries(
    env,
    url,
    await resolveDashboardFilters(env, url, 'TOKYO', 'ADMIN-1')
  );

  assert.equal(result.pagination.entries.total, 101);
  assert.ok(result.entries.every((entry) => entry.telegram_id === 'EMP-1'));
});
