import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  deliverPayrollEmailOutbox,
  renderPayrollEmail
} from '../src/payroll-email.js';
import { payrollEmailConfig } from '../src/security.js';
import { createD1 } from './helpers/d1.js';

const schema = readFileSync(
  new URL('../db/schema.sql', import.meta.url),
  'utf8'
);

function emailFixture() {
  const database = new DatabaseSync(':memory:');
  database.exec(schema);
  database.exec(`
    INSERT INTO stores (
      store_id, name, status, timezone, currency, created_at, updated_at
    ) VALUES (
      'STORE-1', 'Tokyo Club', 'active', 'Asia/Tokyo', '$',
      '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
    );
    INSERT INTO store_members (
      store_id, telegram_id, display_name, role, status,
      cycle_start, joined_at, updated_at
    ) VALUES (
      'STORE-1', 'EMP-1', 'Alice', 'employee', 'active',
      '2026-07-16T03:00:00.000Z',
      '2026-07-01T00:00:00.000Z',
      '2026-07-16T06:00:00.000Z'
    );
    INSERT INTO payroll_disbursements (
      payroll_id, store_id, telegram_id, payroll_start_date,
      scheduled_date, cycle_day, period_start, cutoff_at,
      amount_snapshot_micros, currency, status,
      accepts_bank, accepts_cash,
      bank_details_snapshot, bank_micros, cash_micros,
      current_admin_id, salary_record_id,
      payment_sent_at, confirmed_at, created_at, updated_at
    ) VALUES (
      'PAYROLL-1', 'STORE-1', 'EMP-1', '2026-07-01',
      '2026-07-16', 16,
      '2026-07-01T03:00:00.000Z',
      '2026-07-16T03:00:00.000Z',
      100000000, '$', 'confirmed',
      1, 1, 'SECRET-BANK-12345678',
      70000000, 30000000,
      'ADMIN-1', 'SAL-AUTO-PAYROLL-1',
      '2026-07-16T05:00:00.000Z',
      '2026-07-16T06:00:00.000Z',
      '2026-07-16T03:00:00.000Z',
      '2026-07-16T06:00:00.000Z'
    );
    INSERT INTO payroll_payment_proofs (
      proof_id, payroll_id, method, object_key, telegram_file_id,
      mime_type, size_bytes, sort_order, uploaded_by, uploaded_at
    ) VALUES (
      'PROOF-1', 'PAYROLL-1', 'bank',
      'payroll/STORE-1/PAYROLL-1/bank/PROOF-1.jpg',
      'TG-SECRET-FILE', 'image/jpeg', 3, 1, 'ADMIN-1',
      '2026-07-16T04:00:00.000Z'
    );
    INSERT INTO payroll_email_outbox (
      payroll_id, recipient, status, attempt_count, created_at, updated_at
    ) VALUES (
      'PAYROLL-1', 'finance@example.test', 'pending', 0,
      '2026-07-16T06:00:00.000Z',
      '2026-07-16T06:00:00.000Z'
    );
  `);
  return {
    database,
    env: {
      DB: createD1(database),
      PAYROLL_FINANCE_EMAIL: 'finance@example.test',
      PAYROLL_FROM_EMAIL: 'payroll@example.test'
    }
  };
}

test('email config requires the binding and both valid addresses', () => {
  assert.deepEqual(
    payrollEmailConfig({
      PAYROLL_FINANCE_EMAIL: 'finance@example.test',
      PAYROLL_FROM_EMAIL: 'payroll@example.test'
    }),
    {
      recipient: 'finance@example.test',
      sender: 'payroll@example.test',
      ready: false
    }
  );
  assert.equal(payrollEmailConfig({
    PAYROLL_EMAIL: { send() {} },
    PAYROLL_FINANCE_EMAIL: 'finance@example.test',
    PAYROLL_FROM_EMAIL: 'payroll@example.test'
  }).ready, true);
});

test('renders confirmed payroll facts and internal proof references only', () => {
  const message = renderPayrollEmail({
    payroll_id: 'PAYROLL-1',
    store_id: 'STORE-1',
    store_name: 'Tokyo Club',
    telegram_id: 'EMP-1',
    employee_name: 'Alice',
    period_start: '2026-07-01T03:00:00.000Z',
    cutoff_at: '2026-07-16T03:00:00.000Z',
    amount_snapshot_micros: 100_000_000,
    bank_micros: 70_000_000,
    usdt_micros: 0,
    cash_micros: 30_000_000,
    currency: '$',
    current_admin_id: 'ADMIN-1',
    confirmed_at: '2026-07-16T06:00:00.000Z',
    bank_details_snapshot: 'SECRET-BANK-12345678',
    bot_token: 'BOT-TOKEN-SECRET'
  }, [{
    method: 'bank',
    sort_order: 1,
    object_key: 'payroll/STORE-1/PAYROLL-1/bank/PROOF-1.jpg',
    telegram_file_id: 'TG-SECRET-FILE'
  }]);

  assert.match(message.subject, /PAYROLL-1/);
  for (const value of [
    'Tokyo Club',
    'Alice',
    '2026-07-01T03:00:00.000Z',
    '2026-07-16T03:00:00.000Z',
    '$100.00',
    '$70.00',
    '$30.00',
    'ADMIN-1',
    '2026-07-16T06:00:00.000Z',
    'proof_count: 1',
    'payroll/STORE-1/PAYROLL-1/bank/PROOF-1.jpg'
  ]) {
    assert.match(message.text, new RegExp(
      value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    ));
  }
  assert.doesNotMatch(
    message.text,
    /SECRET-BANK|12345678|BOT-TOKEN|TG-SECRET|https?:\/\//
  );
});

test('missing email configuration leaves the row pending with a safe error', async () => {
  const fixture = emailFixture();
  try {
    const result = await deliverPayrollEmailOutbox(
      { DB: fixture.env.DB },
      new Date('2026-07-16T06:10:00.000Z')
    );

    assert.deepEqual(result, { scanned: 1, sent: 0, failed: 1 });
    assert.deepEqual(
      {
        ...fixture.database.prepare(`
          SELECT status, attempt_count, last_error, claimed_at
          FROM payroll_email_outbox WHERE payroll_id = 'PAYROLL-1'
        `).get()
      },
      {
        status: 'pending',
        attempt_count: 1,
        last_error: 'email_not_configured',
        claimed_at: null
      }
    );
  } finally {
    fixture.database.close();
  }
});

test('email failure retries without changing the confirmed payroll', async () => {
  const fixture = emailFixture();
  const messages = [];
  try {
    fixture.env.PAYROLL_EMAIL = {
      async send() {
        throw new Error('provider secret and recipient must not be stored');
      }
    };
    const failed = await deliverPayrollEmailOutbox(
      fixture.env,
      new Date('2026-07-16T06:10:00.000Z')
    );
    assert.deepEqual(failed, { scanned: 1, sent: 0, failed: 1 });
    assert.deepEqual(
      {
        ...fixture.database.prepare(`
          SELECT status, attempt_count, last_error
          FROM payroll_email_outbox WHERE payroll_id = 'PAYROLL-1'
        `).get()
      },
      {
        status: 'pending',
        attempt_count: 1,
        last_error: 'email_delivery_failed'
      }
    );
    assert.deepEqual(
      {
        ...fixture.database.prepare(`
          SELECT status, confirmed_at, salary_record_id
          FROM payroll_disbursements WHERE payroll_id = 'PAYROLL-1'
        `).get()
      },
      {
        status: 'confirmed',
        confirmed_at: '2026-07-16T06:00:00.000Z',
        salary_record_id: 'SAL-AUTO-PAYROLL-1'
      }
    );

    fixture.env.PAYROLL_EMAIL = {
      async send(message) {
        messages.push(message);
        return { messageId: 'EMAIL-1' };
      }
    };
    const sent = await deliverPayrollEmailOutbox(
      fixture.env,
      new Date('2026-07-16T06:20:00.000Z')
    );

    assert.deepEqual(sent, { scanned: 1, sent: 1, failed: 0 });
    assert.equal(messages.length, 1);
    assert.deepEqual(
      {
        to: messages[0].to,
        from: messages[0].from
      },
      {
        to: 'finance@example.test',
        from: 'payroll@example.test'
      }
    );
    assert.deepEqual(
      {
        ...fixture.database.prepare(`
          SELECT status, attempt_count, last_error, sent_at
          FROM payroll_email_outbox WHERE payroll_id = 'PAYROLL-1'
        `).get()
      },
      {
        status: 'sent',
        attempt_count: 2,
        last_error: null,
        sent_at: '2026-07-16T06:20:00.000Z'
      }
    );
  } finally {
    fixture.database.close();
  }
});

test('two outbox workers cannot send the same claimed row', async () => {
  const fixture = emailFixture();
  let sends = 0;
  try {
    fixture.env.PAYROLL_EMAIL = {
      async send() {
        sends += 1;
      }
    };
    const results = await Promise.all([
      deliverPayrollEmailOutbox(
        fixture.env,
        new Date('2026-07-16T06:10:00.000Z')
      ),
      deliverPayrollEmailOutbox(
        fixture.env,
        new Date('2026-07-16T06:10:00.000Z')
      )
    ]);

    assert.equal(sends, 1);
    assert.equal(
      results.reduce((total, result) => total + result.sent, 0),
      1
    );
    assert.equal(
      fixture.database.prepare(`
        SELECT status FROM payroll_email_outbox
      `).get().status,
      'sent'
    );
  } finally {
    fixture.database.close();
  }
});
