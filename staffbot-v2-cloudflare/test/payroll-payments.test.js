import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  confirmPayrollReceipt,
  disputePayrollPayment,
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
    /USDT address or QR is required/
  );
  assert.doesNotThrow(
    () => validatePaymentProfile({
      accepts_bank: false,
      accepts_usdt: true,
      accepts_cash: false,
      usdt_details: '',
      usdt_qr_id: 'QR-1'
    })
  );
  assert.doesNotThrow(
    () => validatePaymentProfile({
      accepts_bank: false,
      accepts_usdt: true,
      accepts_cash: false,
      usdt_details: '0xabc',
      usdt_qr_id: null
    })
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
      usdt_details: null,
      usdt_qr_id: null
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

test('profile edits are locked after an admin starts payment', async () => {
  const database = databaseFixture();
  try {
    insertPayroll(database, payroll({
      status: 'awaiting_admin_payment'
    }));
    database.prepare(`
      UPDATE payroll_disbursements
      SET accepts_bank = 1,
          bank_details_snapshot = 'Original 11112222',
          current_admin_id = 'ADMIN-1'
      WHERE payroll_id = 'PAYROLL-1'
    `).run();

    await assert.rejects(
      savePaymentProfile(
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
      ),
      /payroll payment details are locked/
    );

    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM payroll_payment_profiles
      `).get().count,
      0
    );
  } finally {
    database.close();
  }
});

test('address-only USDT supersedes the active QR on an editable payroll', async () => {
  const database = databaseFixture();
  try {
    insertPayroll(database, payroll({
      status: 'awaiting_admin_payment'
    }));
    database.exec(`
      INSERT INTO payroll_payment_qr_codes (
        qr_id, store_id, telegram_id, object_key,
        telegram_file_id, mime_type, size_bytes, uploaded_at
      ) VALUES (
        'QR-OLD', 'STORE-1', 'EMP-1',
        'payroll-payment-qr/STORE-1/EMP-1/QR-OLD.jpg',
        'TELEGRAM-OLD', 'image/jpeg', 4,
        '2026-07-16T03:30:00.000Z'
      );
      INSERT INTO payroll_payment_profiles (
        store_id, telegram_id,
        accepts_bank, accepts_usdt, accepts_cash,
        usdt_details, usdt_qr_id, created_at, updated_at
      ) VALUES (
        'STORE-1', 'EMP-1', 0, 1, 0,
        NULL, 'QR-OLD',
        '2026-07-16T03:30:00.000Z',
        '2026-07-16T03:30:00.000Z'
      );
      UPDATE payroll_disbursements
      SET accepts_usdt = 1,
          usdt_qr_id_snapshot = 'QR-OLD'
      WHERE payroll_id = 'PAYROLL-1';
    `);

    const saved = await savePaymentProfile(
      { DB: createD1(database) },
      'EMP-1',
      'PAYROLL-1',
      {
        accepts_bank: false,
        accepts_usdt: true,
        accepts_cash: false,
        usdt_details: 'TADDRESS',
        usdt_qr_id: null
      },
      new Date('2026-07-16T04:00:00.000Z')
    );

    assert.equal(saved.amount_snapshot_micros, 100_000_000);
    assert.equal(saved.usdt_details_snapshot, 'TADDRESS');
    assert.equal(saved.usdt_qr_id_snapshot, null);
    assert.equal(
      database.prepare(`
        SELECT usdt_qr_id
        FROM payroll_payment_profiles
        WHERE store_id = 'STORE-1'
          AND telegram_id = 'EMP-1'
      `).get().usdt_qr_id,
      null
    );
    assert.equal(
      database.prepare(`
        SELECT superseded_at
        FROM payroll_payment_qr_codes
        WHERE qr_id = 'QR-OLD'
      `).get().superseded_at,
      '2026-07-16T04:00:00.000Z'
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

test('authorized admin saves a new disputed split without mutating old proofs', async () => {
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
      SET accepts_bank = 1,
          accepts_cash = 1,
          payment_sent_at = '2026-07-16T04:30:00.000Z'
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
    assert.equal(saved.payment_sent_at, null);
    const oldProof = database.prepare(`
      SELECT
        proof_id, payroll_id, method, object_key,
        telegram_file_id, mime_type, size_bytes, sort_order,
        uploaded_by, superseded_at, uploaded_at
      FROM payroll_payment_proofs WHERE proof_id = 'OLD-PROOF'
    `).get();
    assert.deepEqual({ ...oldProof }, {
      proof_id: 'OLD-PROOF',
      payroll_id: 'PAYROLL-1',
      method: 'bank',
      object_key: 'payroll/old.jpg',
      telegram_file_id: 'TG-OLD',
      mime_type: 'image/jpeg',
      size_bytes: 10,
      sort_order: 1,
      uploaded_by: 'ADMIN-1',
      superseded_at: null,
      uploaded_at: '2026-07-16T04:00:00.000Z'
    });
    assert.ok(database.prepare(`
      SELECT attempt_id FROM payroll_payment_proofs
      WHERE proof_id = 'OLD-PROOF'
    `).get().attempt_id);
  } finally {
    database.close();
  }
});

test('employee confirmation creates one formal salary record and email row', async () => {
  const database = databaseFixture();
  try {
    insertPayroll(database, payroll({
      status: 'awaiting_employee_confirmation',
      bank_micros: 70_000_000,
      cash_micros: 30_000_000
    }));
    database.prepare(`
      UPDATE payroll_disbursements
      SET current_admin_id = 'ADMIN-1'
      WHERE payroll_id = 'PAYROLL-1'
    `).run();
    const before = database.prepare(`
      SELECT period_start, cutoff_at, amount_snapshot_micros
      FROM payroll_disbursements WHERE payroll_id = 'PAYROLL-1'
    `).get();

    const confirmed = await confirmPayrollReceipt(
      { DB: createD1(database) },
      'EMP-1',
      'PAYROLL-1',
      'finance@example.test',
      new Date('2026-07-16T06:00:00.000Z')
    );

    assert.equal(confirmed.status, 'confirmed');
    assert.equal(confirmed.confirmed_at, '2026-07-16T06:00:00.000Z');
    assert.equal(confirmed.salary_record_id, 'SAL-AUTO-PAYROLL-1');
    assert.deepEqual(
      {
        ...database.prepare(`
          SELECT * FROM salary_records
          WHERE record_id = 'SAL-AUTO-PAYROLL-1'
        `).get()
      },
      {
        record_id: 'SAL-AUTO-PAYROLL-1',
        store_id: 'STORE-1',
        telegram_id: 'EMP-1',
        amount: 100,
        period_start: '2026-07-01T03:00:00.000Z',
        period_end: '2026-07-16T03:00:00.000Z',
        approved_at: '2026-07-16T06:00:00.000Z',
        admin_id: 'ADMIN-1',
        request_id: 'PAYROLL-1'
      }
    );
    assert.deepEqual(
      {
        ...database.prepare(`
          SELECT payroll_id, recipient, status, attempt_count
          FROM payroll_email_outbox
        `).get()
      },
      {
        payroll_id: 'PAYROLL-1',
        recipient: 'finance@example.test',
        status: 'pending',
        attempt_count: 0
      }
    );
    assert.deepEqual(
      {
        ...database.prepare(`
          SELECT period_start, cutoff_at, amount_snapshot_micros
          FROM payroll_disbursements WHERE payroll_id = 'PAYROLL-1'
        `).get()
      },
      { ...before }
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count FROM admin_audit_logs
        WHERE action = 'confirm_payroll_receipt'
      `).get().count,
      1
    );

    await assert.rejects(
      confirmPayrollReceipt(
        { DB: createD1(database) },
        'EMP-1',
        'PAYROLL-1',
        'finance@example.test'
      ),
      /already_processed/
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count FROM salary_records
        WHERE request_id = 'PAYROLL-1'
      `).get().count,
      1
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count FROM payroll_email_outbox
        WHERE payroll_id = 'PAYROLL-1'
      `).get().count,
      1
    );
  } finally {
    database.close();
  }
});

test('employee confirmation succeeds before finance email is configured', async () => {
  const database = databaseFixture();
  try {
    insertPayroll(database, payroll({
      status: 'awaiting_employee_confirmation',
      bank_micros: 70_000_000,
      cash_micros: 30_000_000
    }));
    database.prepare(`
      UPDATE payroll_disbursements
      SET current_admin_id = 'ADMIN-1'
      WHERE payroll_id = 'PAYROLL-1'
    `).run();

    const confirmed = await confirmPayrollReceipt(
      { DB: createD1(database) },
      'EMP-1',
      'PAYROLL-1',
      undefined,
      new Date('2026-07-16T06:00:00.000Z')
    );

    assert.equal(confirmed.status, 'confirmed');
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count FROM salary_records
        WHERE request_id = 'PAYROLL-1'
      `).get().count,
      1
    );
    assert.deepEqual(
      {
        ...database.prepare(`
          SELECT recipient, status, attempt_count
          FROM payroll_email_outbox
          WHERE payroll_id = 'PAYROLL-1'
        `).get()
      },
      {
        recipient: '',
        status: 'pending',
        attempt_count: 0
      }
    );
  } finally {
    database.close();
  }
});

test('only the payroll employee can dispute an awaiting confirmation', async () => {
  const database = databaseFixture();
  try {
    insertPayroll(database, payroll({
      status: 'awaiting_employee_confirmation',
      bank_micros: 100_000_000
    }));

    await assert.rejects(
      disputePayrollPayment(
        { DB: createD1(database) },
        'OTHER-EMP',
        'PAYROLL-1'
      ),
      /not found/
    );
    const disputed = await disputePayrollPayment(
      { DB: createD1(database) },
      'EMP-1',
      'PAYROLL-1',
      new Date('2026-07-16T06:30:00.000Z')
    );

    assert.equal(disputed.status, 'disputed');
    assert.equal(disputed.disputed_at, '2026-07-16T06:30:00.000Z');
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count FROM admin_audit_logs
        WHERE action = 'dispute_payroll_payment'
      `).get().count,
      1
    );
    await assert.rejects(
      disputePayrollPayment(
        { DB: createD1(database) },
        'EMP-1',
        'PAYROLL-1'
      ),
      /already_processed/
    );
  } finally {
    database.close();
  }
});

test('concurrent payroll confirmations create one record and one email row', async () => {
  const database = databaseFixture();
  try {
    insertPayroll(database, payroll({
      status: 'awaiting_employee_confirmation',
      bank_micros: 100_000_000
    }));
    database.prepare(`
      UPDATE payroll_disbursements
      SET current_admin_id = 'ADMIN-1'
      WHERE payroll_id = 'PAYROLL-1'
    `).run();
    const env = { DB: createD1(database) };

    const results = await Promise.allSettled([
      confirmPayrollReceipt(
        env,
        'EMP-1',
        'PAYROLL-1',
        'finance@example.test'
      ),
      confirmPayrollReceipt(
        env,
        'EMP-1',
        'PAYROLL-1',
        'finance@example.test'
      )
    ]);

    assert.deepEqual(
      results.map((result) => result.status).sort(),
      ['fulfilled', 'rejected']
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count FROM salary_records
        WHERE request_id = 'PAYROLL-1'
      `).get().count,
      1
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count FROM payroll_email_outbox
        WHERE payroll_id = 'PAYROLL-1'
      `).get().count,
      1
    );
  } finally {
    database.close();
  }
});
