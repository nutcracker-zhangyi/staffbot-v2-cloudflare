import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  maskPaymentValue,
  paymentMethodKeyboard,
  savePaymentProfile,
  savePaymentSplit,
  validatePaymentSplit,
  validatePaymentProfile
} from '../src/payroll-payments.js';
import { createD1 } from './helpers/d1.js';

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

test('validates selected payment methods and masks all but four characters', () => {
  assert.throws(
    () => validatePaymentProfile({
      accepts_bank: false,
      accepts_usdt: false,
      accepts_cash: false
    }),
    /payment method/
  );
  assert.throws(
    () => validatePaymentProfile({
      accepts_bank: true,
      accepts_usdt: false,
      accepts_cash: false,
      bank_details: '   '
    }),
    /bank details/
  );
  assert.throws(
    () => validatePaymentProfile({
      accepts_bank: false,
      accepts_usdt: true,
      accepts_cash: false,
      usdt_details: ''
    }),
    /USDT details/
  );
  assert.deepEqual(
    validatePaymentProfile({
      accepts_bank: true,
      accepts_usdt: false,
      accepts_cash: true,
      bank_details: '  1234 5678  '
    }),
    {
      accepts_bank: 1,
      accepts_usdt: 0,
      accepts_cash: 1,
      bank_details: '1234 5678',
      usdt_details: null
    }
  );
  assert.equal(maskPaymentValue(' 1234 5678 '), '••••5678');
  assert.equal(maskPaymentValue('ABC'), '••••ABC');
  assert.equal(maskPaymentValue(''), '');
});

test('saves a reusable profile and current payroll snapshot atomically', async () => {
  const database = databaseFixture();
  try {
    insertPayroll(database, payroll());
    const env = { DB: createD1(database) };

    await assert.rejects(
      savePaymentProfile(env, 'OTHER-EMP', 'PAYROLL-1', {
        accepts_bank: false,
        accepts_usdt: false,
        accepts_cash: true
      }),
      /payroll identity mismatch/
    );

    const saved = await savePaymentProfile(
      env,
      'EMP-1',
      'PAYROLL-1',
      {
        accepts_bank: true,
        accepts_usdt: true,
        accepts_cash: false,
        bank_details: 'Bank 12345678',
        usdt_details: 'TRX-ABCDEFGH'
      },
      new Date('2026-07-16T04:00:00.000Z')
    );

    assert.equal(saved.status, 'awaiting_admin_payment');
    assert.equal(saved.accepts_bank, 1);
    assert.equal(saved.accepts_usdt, 1);
    assert.equal(saved.bank_details_snapshot, 'Bank 12345678');
    assert.equal(saved.usdt_details_snapshot, 'TRX-ABCDEFGH');
    assert.deepEqual(
      {
        ...database.prepare(`
          SELECT
            accepts_bank,
            accepts_usdt,
            accepts_cash,
            bank_details,
            usdt_details
          FROM payroll_payment_profiles
        `).get()
      },
      {
        accepts_bank: 1,
        accepts_usdt: 1,
        accepts_cash: 0,
        bank_details: 'Bank 12345678',
        usdt_details: 'TRX-ABCDEFGH'
      }
    );
    const audit = database.prepare(`
      SELECT details_json FROM admin_audit_logs
      WHERE action = 'save_payroll_payment_profile'
    `).get().details_json;
    assert.doesNotMatch(audit, /12345678|ABCDEFGH/);
    assert.match(audit, /••••5678/);
  } finally {
    database.close();
  }
});

test('profile edits after admin payment do not rewrite the older snapshot', async () => {
  const database = databaseFixture();
  try {
    insertPayroll(database, payroll({
      status: 'awaiting_employee_confirmation'
    }));
    database.prepare(`
      UPDATE payroll_disbursements
      SET accepts_bank = 1,
          bank_details_snapshot = 'Original 11112222'
      WHERE payroll_id = 'PAYROLL-1'
    `).run();

    const saved = await savePaymentProfile(
      { DB: createD1(database) },
      'EMP-1',
      'PAYROLL-1',
      {
        accepts_bank: true,
        accepts_usdt: false,
        accepts_cash: true,
        bank_details: 'Future 99998888'
      },
      new Date('2026-07-16T05:00:00.000Z')
    );

    assert.equal(saved.status, 'awaiting_employee_confirmation');
    assert.equal(saved.accepts_cash, 0);
    assert.equal(saved.bank_details_snapshot, 'Original 11112222');
    assert.deepEqual(
      {
        ...database.prepare(`
          SELECT accepts_cash, bank_details
          FROM payroll_payment_profiles
        `).get()
      },
      {
        accepts_cash: 1,
        bank_details: 'Future 99998888'
      }
    );
  } finally {
    database.close();
  }
});

test('builds button-only payment method selection callbacks', () => {
  const keyboard = paymentMethodKeyboard(
    'PAYROLL-1',
    {
      accepts_bank: 1,
      accepts_usdt: 0,
      accepts_cash: 1
    },
    'zh'
  );
  const buttons = keyboard.inline_keyboard.flat();

  assert.match(buttons[0].text, /☑.*银行卡/);
  assert.match(buttons[1].text, /☐.*USDT/);
  assert.match(buttons[2].text, /☑.*现金/);
  assert.ok(buttons.every((button) => button.callback_data.length <= 64));
});

test('validates exact safe-integer payment splits', () => {
  const payrollRow = {
    amount_snapshot_micros: 100_000_000,
    accepts_bank: 1,
    accepts_usdt: 1,
    accepts_cash: 1
  };
  assert.deepEqual(
    validatePaymentSplit(payrollRow, {
      bank_micros: 50_000_000,
      usdt_micros: 30_000_000,
      cash_micros: 20_000_000
    }),
    {
      bank_micros: 50_000_000,
      usdt_micros: 30_000_000,
      cash_micros: 20_000_000
    }
  );
  for (const input of [
    { bank_micros: 50.5, usdt_micros: 30, cash_micros: 19.5 },
    { bank_micros: -1, usdt_micros: 0, cash_micros: 100_000_001 },
    { bank_micros: Number.MAX_SAFE_INTEGER + 1, usdt_micros: 0, cash_micros: 0 },
    { bank_micros: 50_000_000, usdt_micros: 30_000_000, cash_micros: 10_000_000 }
  ]) {
    assert.throws(
      () => validatePaymentSplit(payrollRow, input)
    );
  }
  assert.throws(() => validatePaymentSplit(
    { ...payrollRow, accepts_usdt: 0 },
    {
      bank_micros: 50_000_000,
      usdt_micros: 30_000_000,
      cash_micros: 20_000_000
    }
  ), /not accepted/);
});

test('authorized admin saves a split and supersedes disputed proofs', async () => {
  const database = databaseFixture();
  try {
    database.exec(`
      INSERT INTO stores (
        store_id, name, created_at, updated_at
      ) VALUES (
        'STORE-1', 'Store', '2026-07-01T00:00:00.000Z',
        '2026-07-01T00:00:00.000Z'
      );
      INSERT INTO store_members (
        store_id, telegram_id, display_name, role, status,
        cycle_start, joined_at, updated_at
      ) VALUES (
        'STORE-1', 'ADMIN-1', 'Admin', 'admin', 'active',
        '2026-07-01T00:00:00.000Z',
        '2026-07-01T00:00:00.000Z',
        '2026-07-01T00:00:00.000Z'
      );
    `);
    insertPayroll(database, payroll({
      status: 'disputed'
    }));
    database.exec(`
      UPDATE payroll_disbursements
      SET accepts_bank = 1, accepts_cash = 1
      WHERE payroll_id = 'PAYROLL-1';
      INSERT INTO payroll_payment_proofs (
        proof_id, payroll_id, method, object_key, telegram_file_id,
        mime_type, size_bytes, sort_order, uploaded_by, uploaded_at
      ) VALUES (
        'OLD-PROOF', 'PAYROLL-1', 'bank',
        'payroll/old.jpg', 'TG-OLD', 'image/jpeg',
        10, 1, 'ADMIN-1', '2026-07-16T04:00:00.000Z'
      );
    `);

    const saved = await savePaymentSplit(
      { DB: createD1(database) },
      'ADMIN-1',
      'PAYROLL-1',
      {
        bank_micros: 70_000_000,
        usdt_micros: 0,
        cash_micros: 30_000_000
      },
      new Date('2026-07-16T05:00:00.000Z')
    );

    assert.equal(saved.status, 'awaiting_admin_payment');
    assert.equal(saved.current_admin_id, 'ADMIN-1');
    assert.equal(saved.bank_micros, 70_000_000);
    assert.equal(saved.cash_micros, 30_000_000);
    assert.equal(
      database.prepare(`
        SELECT superseded_at FROM payroll_payment_proofs
        WHERE proof_id = 'OLD-PROOF'
      `).get().superseded_at,
      '2026-07-16T05:00:00.000Z'
    );
  } finally {
    database.close();
  }
});
