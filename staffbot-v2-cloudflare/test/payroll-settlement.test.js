import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { payrollCutoff } from '../src/payroll-cycle.js';
import {
  eligiblePayrollMembers,
  processPayrollSettlements,
  settlePayrollCutoff
} from '../src/payroll-settlement.js';
import { deliverPayrollNotifications } from '../src/payroll-notifications.js';
import { createD1 } from './helpers/d1.js';

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

function settlementFixture(member = {}) {
  const database = canonicalDatabase();
  database.exec(`
    INSERT INTO stores (
      store_id, name, status, timezone, currency, created_at, updated_at
    ) VALUES (
      'STORE-1', 'Tokyo Club', 'active', 'Asia/Tokyo', '¥',
      '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'
    );
  `);
  database.prepare(`
    INSERT INTO store_members (
      store_id, telegram_id, display_name, role, status,
      commission_rate, cycle_start, joined_at,
      absence_check_enabled, absence_check_enabled_at,
      payroll_start_date, payroll_automation_started_at, updated_at
    ) VALUES (
      'STORE-1', 'EMP-1', 'Alice', 'employee', :status,
      0.6, :cycle_start, '2026-06-30T15:00:00.000Z',
      1, '2026-06-30T15:00:00.000Z',
      :payroll_start_date, :payroll_automation_started_at,
      '2026-07-01T00:00:00.000Z'
    )
  `).run({
    status: 'active',
    cycle_start: '2026-06-30T15:00:00.000Z',
    payroll_start_date: '2026-07-01',
    payroll_automation_started_at: '2026-06-30T15:00:00.000Z',
    ...member
  });
  return {
    database,
    env: { DB: createD1(database) }
  };
}

function insertEntry(database, {
  entryId,
  effectiveAt,
  amountMicros,
  type = amountMicros > 0 ? 'income' : 'fine'
}) {
  database.prepare(`
    INSERT INTO payroll_entries (
      entry_id, store_id, telegram_id, type, amount_micros, currency,
      effective_at, source, source_id, created_by, created_at,
      reverses_entry_id, metadata_json
    ) VALUES (
      ?, 'STORE-1', 'EMP-1', ?, ?, '¥',
      ?, 'settlement_test', ?, 'ADMIN-1', ?,
      NULL, '{}'
    )
  `).run(
    entryId,
    type,
    amountMicros,
    effectiveAt,
    entryId,
    effectiveAt
  );
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

test('includes an active store admin in their own automatic payroll', async () => {
  const fixture = settlementFixture();
  try {
    fixture.database.exec(`
      UPDATE store_members
      SET role = 'admin'
      WHERE store_id = 'STORE-1' AND telegram_id = 'EMP-1'
    `);

    const members = await eligiblePayrollMembers(fixture.env);

    assert.deepEqual(
      members.map((member) => ({
        store_id: member.store_id,
        telegram_id: member.telegram_id
      })),
      [{ store_id: 'STORE-1', telegram_id: 'EMP-1' }]
    );
  } finally {
    fixture.database.close();
  }
});

test('settles only ledger entries strictly before the fixed local-noon cutoff', async () => {
  const fixture = settlementFixture();
  try {
    insertEntry(fixture.database, {
      entryId: 'BEFORE',
      effectiveAt: '2026-07-16T02:59:59.999Z',
      amountMicros: 10_000_000
    });
    insertEntry(fixture.database, {
      entryId: 'AT-CUTOFF',
      effectiveAt: '2026-07-16T03:00:00.000Z',
      amountMicros: 20_000_000
    });
    const [member] = await eligiblePayrollMembers(fixture.env);
    const cutoff = payrollCutoff(
      member.payroll_start_date,
      16,
      0,
      member.timezone
    );

    const result = await settlePayrollCutoff(
      fixture.env,
      member,
      cutoff,
      new Date('2026-07-16T04:00:00.000Z')
    );

    assert.equal(result.created, true);
    assert.equal(result.payroll.amount_snapshot_micros, 10_000_000);
    assert.equal(result.payroll.status, 'awaiting_employee_details');
    assert.equal(
      fixture.database.prepare(`
        SELECT cycle_start FROM store_members
        WHERE store_id = 'STORE-1' AND telegram_id = 'EMP-1'
      `).get().cycle_start,
      cutoff.cutoff_at
    );
    assert.equal(
      fixture.database.prepare(`
        SELECT SUM(amount_micros) AS total
        FROM payroll_entries
        WHERE effective_at >= ?
      `).get(cutoff.cutoff_at).total,
      20_000_000
    );
  } finally {
    fixture.database.close();
  }
});

test('creates immutable zero and negative outcomes and carries one negative balance', async () => {
  const zeroFixture = settlementFixture();
  const negativeFixture = settlementFixture();
  try {
    const zeroMember = (await eligiblePayrollMembers(zeroFixture.env))[0];
    const cutoff = payrollCutoff('2026-07-01', 16, 0, 'Asia/Tokyo');
    const zeroResult = await settlePayrollCutoff(
      zeroFixture.env,
      zeroMember,
      cutoff,
      new Date('2026-07-16T04:00:00.000Z')
    );
    assert.equal(zeroResult.payroll.status, 'skipped_zero');
    assert.equal(
      zeroFixture.database.prepare(`
        SELECT cycle_start FROM store_members
        WHERE store_id = 'STORE-1' AND telegram_id = 'EMP-1'
      `).get().cycle_start,
      cutoff.cutoff_at
    );

    insertEntry(negativeFixture.database, {
      entryId: 'NEGATIVE',
      effectiveAt: '2026-07-15T03:00:00.000Z',
      amountMicros: -5_000_000
    });
    const negativeMember = (
      await eligiblePayrollMembers(negativeFixture.env)
    )[0];
    const first = await settlePayrollCutoff(
      negativeFixture.env,
      negativeMember,
      cutoff,
      new Date('2026-07-16T04:00:00.000Z')
    );
    const retry = await settlePayrollCutoff(
      negativeFixture.env,
      negativeMember,
      cutoff,
      new Date('2026-07-16T04:01:00.000Z')
    );

    assert.equal(first.created, true);
    assert.equal(first.payroll.status, 'carried_negative');
    assert.equal(first.payroll.amount_snapshot_micros, -5_000_000);
    assert.equal(retry.created, false);
    assert.equal(
      negativeFixture.database.prepare(`
        SELECT cycle_start FROM store_members
        WHERE store_id = 'STORE-1' AND telegram_id = 'EMP-1'
      `).get().cycle_start,
      cutoff.cutoff_at
    );
    assert.equal(
      negativeFixture.database.prepare(`
        SELECT COUNT(*) AS total FROM payroll_disbursements
      `).get().total,
      1
    );
    assert.deepEqual(
      {
        ...negativeFixture.database.prepare(`
          SELECT
            type,
            amount_micros,
            effective_at,
            source,
            source_id
          FROM payroll_entries
          WHERE source = 'payroll_negative_carry'
        `).get()
      },
      {
        type: 'negative_carry',
        amount_micros: -5_000_000,
        effective_at: cutoff.cutoff_at,
        source: 'payroll_negative_carry',
        source_id: first.payroll.payroll_id
      }
    );
  } finally {
    zeroFixture.database.close();
    negativeFixture.database.close();
  }
});

test('uses a valid saved payment profile for the initial positive status', async () => {
  const fixture = settlementFixture();
  try {
    fixture.database.exec(`
      INSERT INTO payroll_payment_profiles (
        store_id, telegram_id,
        accepts_bank, accepts_usdt, accepts_cash,
        bank_details, usdt_details, created_at, updated_at
      ) VALUES (
        'STORE-1', 'EMP-1', 1, 0, 1,
        'Bank account', NULL,
        '2026-07-01T00:00:00.000Z',
        '2026-07-01T00:00:00.000Z'
      );
    `);
    insertEntry(fixture.database, {
      entryId: 'POSITIVE',
      effectiveAt: '2026-07-15T03:00:00.000Z',
      amountMicros: 8_000_000
    });
    const member = (await eligiblePayrollMembers(fixture.env))[0];
    const result = await settlePayrollCutoff(
      fixture.env,
      member,
      payrollCutoff('2026-07-01', 16, 0, 'Asia/Tokyo'),
      new Date('2026-07-16T04:00:00.000Z')
    );

    assert.equal(result.payroll.status, 'awaiting_admin_payment');
    assert.equal(result.payroll.accepts_bank, 1);
    assert.equal(result.payroll.accepts_cash, 1);
    assert.equal(result.payroll.bank_details_snapshot, 'Bank account');
  } finally {
    fixture.database.close();
  }
});

test('catches up every missed cutoff without waiting for earlier payment completion', async () => {
  const fixture = settlementFixture();
  try {
    insertEntry(fixture.database, {
      entryId: 'FIRST-PERIOD',
      effectiveAt: '2026-07-15T03:00:00.000Z',
      amountMicros: 8_000_000
    });
    insertEntry(fixture.database, {
      entryId: 'SECOND-PERIOD',
      effectiveAt: '2026-07-20T03:00:00.000Z',
      amountMicros: 12_000_000
    });

    const summary = await processPayrollSettlements(
      fixture.env,
      new Date('2026-07-31T03:00:00.000Z')
    );
    const payrolls = fixture.database.prepare(`
      SELECT scheduled_date, period_start, cutoff_at,
             amount_snapshot_micros, status
      FROM payroll_disbursements
      ORDER BY cutoff_at
    `).all();

    assert.deepEqual(summary, {
      scanned: 2,
      created: 2,
      skipped_zero: 0,
      carried_negative: 0
    });
    assert.deepEqual(
      payrolls.map((row) => ({
        scheduled_date: row.scheduled_date,
        amount_snapshot_micros: row.amount_snapshot_micros,
        status: row.status
      })),
      [
        {
          scheduled_date: '2026-07-16',
          amount_snapshot_micros: 8_000_000,
          status: 'awaiting_employee_details'
        },
        {
          scheduled_date: '2026-07-30',
          amount_snapshot_micros: 12_000_000,
          status: 'awaiting_employee_details'
        }
      ]
    );
    assert.equal(payrolls[1].period_start, payrolls[0].cutoff_at);
  } finally {
    fixture.database.close();
  }
});

test('a disputed payroll does not block the next scheduled cutoff', async () => {
  const fixture = settlementFixture();
  try {
    insertEntry(fixture.database, {
      entryId: 'FIRST-DISPUTED-PERIOD',
      effectiveAt: '2026-07-15T03:00:00.000Z',
      amountMicros: 8_000_000
    });
    await processPayrollSettlements(
      fixture.env,
      new Date('2026-07-16T04:00:00.000Z')
    );
    fixture.database.prepare(`
      UPDATE payroll_disbursements SET status = 'disputed'
      WHERE scheduled_date = '2026-07-16'
    `).run();
    insertEntry(fixture.database, {
      entryId: 'NEXT-AFTER-DISPUTE',
      effectiveAt: '2026-07-20T03:00:00.000Z',
      amountMicros: 12_000_000
    });

    await processPayrollSettlements(
      fixture.env,
      new Date('2026-07-31T03:00:00.000Z')
    );

    assert.deepEqual(
      fixture.database.prepare(`
        SELECT scheduled_date, status, amount_snapshot_micros
        FROM payroll_disbursements ORDER BY cutoff_at
      `).all().map((row) => ({ ...row })),
      [
        {
          scheduled_date: '2026-07-16',
          status: 'disputed',
          amount_snapshot_micros: 8_000_000
        },
        {
          scheduled_date: '2026-07-30',
          status: 'awaiting_employee_details',
          amount_snapshot_micros: 12_000_000
        }
      ]
    );
  } finally {
    fixture.database.close();
  }
});

test('automation start skips old cutoffs while delayed registration approval catches up', async () => {
  const existingFixture = settlementFixture({
    payroll_automation_started_at: '2026-07-20T00:00:00.000Z'
  });
  const delayedFixture = settlementFixture();
  try {
    await processPayrollSettlements(
      existingFixture.env,
      new Date('2026-07-31T03:00:00.000Z')
    );
    assert.deepEqual(
      existingFixture.database.prepare(`
        SELECT scheduled_date FROM payroll_disbursements
      `).all().map((row) => row.scheduled_date),
      ['2026-07-30']
    );

    await processPayrollSettlements(
      delayedFixture.env,
      new Date('2026-07-20T03:00:00.000Z')
    );
    assert.deepEqual(
      delayedFixture.database.prepare(`
        SELECT scheduled_date FROM payroll_disbursements
      `).all().map((row) => row.scheduled_date),
      ['2026-07-16']
    );
  } finally {
    existingFixture.database.close();
    delayedFixture.database.close();
  }
});

test('concurrent cutoff attempts produce one snapshot, carry, and audit', async () => {
  const fixture = settlementFixture();
  try {
    insertEntry(fixture.database, {
      entryId: 'CONCURRENT-NEGATIVE',
      effectiveAt: '2026-07-15T03:00:00.000Z',
      amountMicros: -6_000_000
    });
    const baseDb = fixture.env.DB;
    let batchQueue = Promise.resolve();
    fixture.env.DB = {
      ...baseDb,
      batch(statements) {
        const result = batchQueue.then(() => baseDb.batch(statements));
        batchQueue = result.catch(() => {});
        return result;
      }
    };
    const member = (await eligiblePayrollMembers(fixture.env))[0];
    const cutoff = payrollCutoff('2026-07-01', 16, 0, 'Asia/Tokyo');

    const results = await Promise.all([
      settlePayrollCutoff(
        fixture.env,
        { ...member },
        cutoff,
        new Date('2026-07-16T04:00:00.000Z')
      ),
      settlePayrollCutoff(
        fixture.env,
        { ...member },
        cutoff,
        new Date('2026-07-16T04:00:01.000Z')
      )
    ]);

    assert.deepEqual(
      results.map((result) => result.created).sort(),
      [false, true]
    );
    assert.equal(
      fixture.database.prepare(`
        SELECT COUNT(*) AS total FROM payroll_disbursements
      `).get().total,
      1
    );
    assert.equal(
      fixture.database.prepare(`
        SELECT COUNT(*) AS total FROM payroll_entries
        WHERE source = 'payroll_negative_carry'
      `).get().total,
      1
    );
    assert.equal(
      fixture.database.prepare(`
        SELECT COUNT(*) AS total FROM admin_audit_logs
        WHERE action = 'settle_personal_payroll'
      `).get().total,
      1
    );
  } finally {
    fixture.database.close();
  }
});

test('retries a failed payday notice without changing the immutable payroll', async () => {
  const fixture = settlementFixture();
  const originalFetch = globalThis.fetch;
  const payloads = [];
  try {
    fixture.env.ENVIRONMENT = 'production';
    fixture.env.BOT_TOKEN = 'test-token';
    insertEntry(fixture.database, {
      entryId: 'NOTICE-POSITIVE',
      effectiveAt: '2026-07-15T03:00:00.000Z',
      amountMicros: 9_000_000
    });
    const member = (await eligiblePayrollMembers(fixture.env))[0];
    const cutoff = payrollCutoff('2026-07-01', 16, 0, 'Asia/Tokyo');
    const settled = await settlePayrollCutoff(
      fixture.env,
      member,
      cutoff,
      new Date('2026-07-16T03:00:00.000Z')
    );
    globalThis.fetch = async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      return {
        async json() {
          return {
            ok: false,
            error_code: 500,
            description: 'telegram unavailable'
          };
        }
      };
    };

    const failed = await deliverPayrollNotifications(
      fixture.env,
      new Date('2026-07-16T04:00:00.000Z')
    );
    const unchanged = fixture.database.prepare(`
      SELECT
        amount_snapshot_micros,
        period_start,
        cutoff_at,
        employee_notified_at,
        employee_notification_error
      FROM payroll_disbursements
      WHERE payroll_id = ?
    `).get(settled.payroll.payroll_id);

    assert.deepEqual(failed, {
      scanned: 1,
      sent: 0,
      failed: 1,
      reminded: 0
    });
    assert.equal(unchanged.amount_snapshot_micros, 9_000_000);
    assert.equal(unchanged.period_start, settled.payroll.period_start);
    assert.equal(unchanged.cutoff_at, cutoff.cutoff_at);
    assert.equal(unchanged.employee_notified_at, null);
    assert.deepEqual(
      JSON.parse(unchanged.employee_notification_error),
      {
        error_code: 500,
        description: 'telegram unavailable'
      }
    );
    assert.match(payloads[0].text, /今天是发薪日/);
    assert.match(payloads[0].text, /¥9/);
    assert.ok(
      payloads[0].reply_markup.inline_keyboard[0][0].callback_data.length
      <= 64
    );
  } finally {
    globalThis.fetch = originalFetch;
    fixture.database.close();
  }
});

test('sends the first payday notice immediately and reminders every 24 hours', async () => {
  const fixture = settlementFixture();
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  try {
    fixture.env.ENVIRONMENT = 'production';
    fixture.env.BOT_TOKEN = 'test-token';
    insertEntry(fixture.database, {
      entryId: 'REMINDER-POSITIVE',
      effectiveAt: '2026-07-15T03:00:00.000Z',
      amountMicros: 7_000_000
    });
    const member = (await eligiblePayrollMembers(fixture.env))[0];
    await settlePayrollCutoff(
      fixture.env,
      member,
      payrollCutoff('2026-07-01', 16, 0, 'Asia/Tokyo'),
      new Date('2026-07-16T03:00:00.000Z')
    );
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return { async json() { return { ok: true }; } };
    };

    const initial = await deliverPayrollNotifications(
      fixture.env,
      new Date('2026-07-16T04:00:00.000Z')
    );
    const tooSoon = await deliverPayrollNotifications(
      fixture.env,
      new Date('2026-07-17T03:59:59.999Z')
    );
    const reminder = await deliverPayrollNotifications(
      fixture.env,
      new Date('2026-07-17T04:00:00.000Z')
    );

    assert.deepEqual(initial, {
      scanned: 1,
      sent: 1,
      failed: 0,
      reminded: 0
    });
    assert.deepEqual(tooSoon, {
      scanned: 0,
      sent: 0,
      failed: 0,
      reminded: 0
    });
    assert.deepEqual(reminder, {
      scanned: 1,
      sent: 1,
      failed: 0,
      reminded: 1
    });
    assert.equal(fetchCalls, 2);
    assert.deepEqual(
      {
        ...fixture.database.prepare(`
          SELECT employee_notified_at, employee_reminded_at,
                 employee_notification_error
          FROM payroll_disbursements
        `).get()
      },
      {
        employee_notified_at: '2026-07-16T04:00:00.000Z',
        employee_reminded_at: '2026-07-17T04:00:00.000Z',
        employee_notification_error: null
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
    fixture.database.close();
  }
});
