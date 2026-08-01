import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  abandonDraftAttempt,
  createOrResumeDraftAttempt,
  saveAttemptSplit,
  submitPaymentAttempt
} from '../src/payroll-payment-attempts.js';
import { savePaymentSplit } from '../src/payroll-payments.js';
import { createD1 } from './helpers/d1.js';

const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

function fixture({ status = 'awaiting_admin_payment', acceptsUsdt = 1 } = {}) {
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
    ) VALUES
      ('STORE-1', 'ADMIN-1', 'Manager 1', 'admin', 'active',
       '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z',
       '2026-07-01T00:00:00.000Z'),
      ('STORE-1', 'ADMIN-2', 'Manager 2', 'admin', 'active',
       '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z',
       '2026-07-01T00:00:00.000Z'),
      ('STORE-1', 'EMP-1', 'Alice', 'employee', 'active',
       '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z',
       '2026-07-01T00:00:00.000Z');
    INSERT INTO payroll_disbursements (
      payroll_id, store_id, telegram_id, payroll_start_date,
      scheduled_date, cycle_day, period_start, cutoff_at,
      amount_snapshot_micros, currency, status,
      accepts_bank, accepts_usdt, accepts_cash,
      bank_details_snapshot, usdt_details_snapshot,
      created_at, updated_at
    ) VALUES (
      'PAYROLL-1', 'STORE-1', 'EMP-1', '2026-07-01',
      '2026-07-16', 16, '2026-07-01T03:00:00.000Z',
      '2026-07-16T03:00:00.000Z', 100000000, '$', '${status}',
      1, ${acceptsUsdt}, 1, 'Bank 12345678', 'TRX-ABCDEFGH',
      '2026-07-16T03:10:00.000Z', '2026-07-16T03:10:00.000Z'
    );
  `);
  return { database, env: { DB: createD1(database) } };
}

function claim(database, adminId = 'ADMIN-1') {
  database.prepare(`
    INSERT INTO admin_task_claims (
      task_type, task_id, store_id, claimed_by,
      claimed_at, lease_expires_at, updated_at
    ) VALUES ('payroll', 'PAYROLL-1', 'STORE-1', ?, ?, ?, ?)
    ON CONFLICT(task_type, task_id) DO UPDATE SET
      claimed_by = excluded.claimed_by,
      claimed_at = excluded.claimed_at,
      lease_expires_at = excluded.lease_expires_at,
      updated_at = excluded.updated_at
  `).run(
    adminId,
    '2026-07-29T03:55:00.000Z',
    '2026-07-29T04:15:00.000Z',
    '2026-07-29T03:55:00.000Z'
  );
}

async function testIdempotencyHash(value) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value)
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

test('a payroll claim creates one draft and only its claimant can resume it', async () => {
  const { database, env } = fixture();
  try {
    await assert.rejects(
      createOrResumeDraftAttempt(env, 'ADMIN-1', 'PAYROLL-1', new Date('2026-07-29T04:00:00Z')),
      /task_claim_required/
    );
    claim(database);
    const [first, replay] = await Promise.all([
      createOrResumeDraftAttempt(env, 'ADMIN-1', 'PAYROLL-1', new Date('2026-07-29T04:00:00Z')),
      createOrResumeDraftAttempt(env, 'ADMIN-1', 'PAYROLL-1', new Date('2026-07-29T04:00:01Z'))
    ]);
    assert.equal(first.attempt_id, replay.attempt_id);
    assert.equal(first.version, 1);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS total FROM payroll_payment_attempts
      WHERE payroll_id = 'PAYROLL-1' AND status = 'draft'
    `).get().total, 1);

    await assert.rejects(
      createOrResumeDraftAttempt(env, 'ADMIN-2', 'PAYROLL-1', new Date('2026-07-29T04:00:02Z')),
      /task_claim_required/
    );
  } finally {
    database.close();
  }
});

test('a new claimant abandons the prior owner draft and receives the next version', async () => {
  const { database, env } = fixture();
  try {
    claim(database, 'ADMIN-1');
    const first = await createOrResumeDraftAttempt(
      env, 'ADMIN-1', 'PAYROLL-1', new Date('2026-07-29T04:00:00Z')
    );
    database.prepare(`
      UPDATE admin_task_claims
      SET lease_expires_at = '2026-07-29T04:00:30.000Z'
      WHERE task_type = 'payroll' AND task_id = 'PAYROLL-1'
    `).run();
    claim(database, 'ADMIN-2');

    const second = await createOrResumeDraftAttempt(
      env, 'ADMIN-2', 'PAYROLL-1', new Date('2026-07-29T04:01:00Z')
    );

    assert.equal(first.version, 1);
    assert.equal(second.version, 2);
    assert.equal(database.prepare(`
      SELECT status FROM payroll_payment_attempts WHERE attempt_id = ?
    `).get(first.attempt_id).status, 'abandoned');
    assert.equal(database.prepare(`
      SELECT current_admin_id FROM payroll_disbursements
      WHERE payroll_id = 'PAYROLL-1'
    `).get().current_admin_id, 'ADMIN-2');
    assert.deepEqual(database.prepare(`
      SELECT action FROM admin_audit_logs
      WHERE target_id = 'PAYROLL-1' ORDER BY id
    `).all().map((row) => row.action), [
      'create_payroll_payment_attempt',
      'transfer_payroll_payment_attempt',
      'create_payroll_payment_attempt'
    ]);
  } finally {
    database.close();
  }
});

test('the same owner can resume its explicitly abandoned current version', async () => {
  const { database, env } = fixture();
  try {
    claim(database);
    const first = await createOrResumeDraftAttempt(
      env, 'ADMIN-1', 'PAYROLL-1', new Date('2026-07-29T04:00:00Z')
    );
    await abandonDraftAttempt(
      env, 'ADMIN-1', first.attempt_id, new Date('2026-07-29T04:01:00Z')
    );
    claim(database);

    const resumed = await createOrResumeDraftAttempt(
      env, 'ADMIN-1', 'PAYROLL-1', new Date('2026-07-29T04:02:00Z')
    );
    assert.equal(resumed.attempt_id, first.attempt_id);
    assert.equal(resumed.version, 1);
    assert.equal(resumed.status, 'draft');
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS total FROM payroll_payment_attempts
      WHERE payroll_id = 'PAYROLL-1'
    `).get().total, 1);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS total FROM admin_audit_logs
      WHERE target_id = 'PAYROLL-1'
        AND action = 'resume_payroll_payment_attempt'
    `).get().total, 1);
  } finally {
    database.close();
  }
});

test('split save, submit, and abandon reject a claim whose draft owner differs', async (context) => {
  async function ownedDraft() {
    const value = fixture();
    claim(value.database);
    const draft = await createOrResumeDraftAttempt(
      value.env, 'ADMIN-1', 'PAYROLL-1', new Date('2026-07-29T04:00:00Z')
    );
    value.database.prepare(`
      UPDATE payroll_disbursements SET current_admin_id = 'ADMIN-2'
      WHERE payroll_id = 'PAYROLL-1'
    `).run();
    return { ...value, draft };
  }

  await context.test('save', async () => {
    const value = await ownedDraft();
    try {
      await assert.rejects(saveAttemptSplit(value.env, 'ADMIN-1', value.draft.attempt_id, {
        bank_micros: 100_000_000, usdt_micros: 0, cash_micros: 0
      }, new Date('2026-07-29T04:01:00Z')), /payment attempt owner conflict/);
    } finally {
      value.database.close();
    }
  });

  await context.test('submit', async () => {
    const value = await ownedDraft();
    try {
      value.database.prepare(`
        UPDATE payroll_payment_attempts SET bank_micros = 100000000
        WHERE attempt_id = ?
      `).run(value.draft.attempt_id);
      value.database.prepare(`
        INSERT INTO payroll_payment_proofs (
          proof_id, payroll_id, attempt_id, method, object_key,
          mime_type, size_bytes, sort_order, uploaded_by, uploaded_at
        ) VALUES ('OWNER-PROOF', 'PAYROLL-1', ?, 'bank', 'owner-proof',
          'image/jpeg', 1, 1, 'ADMIN-1', '2026-07-29T04:00:30.000Z')
      `).run(value.draft.attempt_id);
      await assert.rejects(submitPaymentAttempt(
        value.env, 'ADMIN-1', value.draft.attempt_id, 'owner-key',
        new Date('2026-07-29T04:01:00Z')
      ), /payment attempt owner conflict/);
    } finally {
      value.database.close();
    }
  });

  await context.test('abandon', async () => {
    const value = await ownedDraft();
    try {
      await assert.rejects(abandonDraftAttempt(
        value.env, 'ADMIN-1', value.draft.attempt_id,
        new Date('2026-07-29T04:01:00Z')
      ), /payment attempt owner conflict/);
    } finally {
      value.database.close();
    }
  });
});

test('a disputed payroll creates version two without changing version one', async () => {
  const { database, env } = fixture({ status: 'disputed' });
  try {
    database.exec(`
      INSERT INTO payroll_payment_attempts (
        attempt_id, payroll_id, version, status,
        bank_micros, usdt_micros, cash_micros,
        submitted_by, submitted_at, employee_response,
        employee_responded_at, created_at, updated_at
      ) VALUES (
        'ATTEMPT-1', 'PAYROLL-1', 1, 'employee_disputed',
        70000000, 30000000, 0, 'ADMIN-1',
        '2026-07-16T04:00:00.000Z', 'disputed',
        '2026-07-16T05:00:00.000Z', '2026-07-16T03:50:00.000Z',
        '2026-07-16T05:00:00.000Z'
      );
      UPDATE payroll_disbursements
      SET current_payment_attempt_id = 'ATTEMPT-1'
      WHERE payroll_id = 'PAYROLL-1';
    `);
    claim(database);

    const draft = await createOrResumeDraftAttempt(
      env,
      'ADMIN-1',
      'PAYROLL-1',
      new Date('2026-07-29T04:00:00Z')
    );
    assert.equal(draft.version, 2);
    assert.equal(database.prepare(`
      SELECT status FROM payroll_payment_attempts
      WHERE payroll_id = 'PAYROLL-1' AND version = 1
    `).get().status, 'employee_disputed');
  } finally {
    database.close();
  }
});

test('legacy adoption and draft creation do not write after the claim is taken over', async () => {
  const { database, env } = fixture({ status: 'disputed' });
  try {
    database.exec(`
      UPDATE payroll_disbursements SET bank_micros = 100000000
      WHERE payroll_id = 'PAYROLL-1';
      INSERT INTO payroll_payment_proofs (
        proof_id, payroll_id, method, object_key, telegram_file_id,
        mime_type, size_bytes, sort_order, uploaded_by, uploaded_at
      ) VALUES (
        'LEGACY-RACE', 'PAYROLL-1', 'bank', 'legacy-race', 'TG-RACE',
        'image/jpeg', 10, 1, 'ADMIN-0', '2026-07-16T04:00:00.000Z'
      );
    `);
    claim(database);
    let takenOver = false;
    env.DB = createD1(database, {
      afterFirst(sql) {
        if (takenOver || !sql.includes('SELECT * FROM admin_task_claims')) return;
        takenOver = true;
        database.prepare(`
          UPDATE admin_task_claims SET claimed_by = 'ADMIN-2'
          WHERE task_type = 'payroll' AND task_id = 'PAYROLL-1'
        `).run();
      }
    });

    await assert.rejects(
      createOrResumeDraftAttempt(
        env, 'ADMIN-1', 'PAYROLL-1', new Date('2026-07-29T04:00:00Z')
      ),
      /task_claim_required/
    );
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS total FROM payroll_payment_attempts
    `).get().total, 0);
    assert.equal(database.prepare(`
      SELECT attempt_id FROM payroll_payment_proofs
      WHERE proof_id = 'LEGACY-RACE'
    `).get().attempt_id, null);
  } finally {
    database.close();
  }
});

test('draft splits use exact integer micros, accepted methods, and an active claim', async () => {
  const { database, env } = fixture({ acceptsUsdt: 0 });
  try {
    claim(database);
    const draft = await createOrResumeDraftAttempt(
      env, 'ADMIN-1', 'PAYROLL-1', new Date('2026-07-29T04:00:00Z')
    );
    await assert.rejects(saveAttemptSplit(env, 'ADMIN-1', draft.attempt_id, {
      bank_micros: 50_000_000,
      usdt_micros: 20_000_000,
      cash_micros: 30_000_000
    }, new Date('2026-07-29T04:01:00Z')), /not accepted/);
    await assert.rejects(saveAttemptSplit(env, 'ADMIN-1', draft.attempt_id, {
      bank_micros: 50_000_000,
      usdt_micros: 0,
      cash_micros: 49_999_999
    }, new Date('2026-07-29T04:01:00Z')), /equal payroll snapshot/);

    const saved = await saveAttemptSplit(env, 'ADMIN-1', draft.attempt_id, {
      bank_micros: 70_000_000,
      usdt_micros: 0,
      cash_micros: 30_000_000
    }, new Date('2026-07-29T04:01:00Z'));
    assert.deepEqual(
      [saved.bank_micros, saved.usdt_micros, saved.cash_micros],
      [70_000_000, 0, 30_000_000]
    );
    const payroll = database.prepare(`
      SELECT bank_micros, usdt_micros, cash_micros, current_payment_attempt_id
      FROM payroll_disbursements WHERE payroll_id = 'PAYROLL-1'
    `).get();
    assert.deepEqual({ ...payroll }, {
      bank_micros: 70_000_000,
      usdt_micros: 0,
      cash_micros: 30_000_000,
      current_payment_attempt_id: draft.attempt_id
    });

    database.prepare(`
      UPDATE admin_task_claims SET claimed_by = 'ADMIN-2'
      WHERE task_type = 'payroll' AND task_id = 'PAYROLL-1'
    `).run();
    await assert.rejects(saveAttemptSplit(env, 'ADMIN-1', draft.attempt_id, {
      bank_micros: 60_000_000,
      usdt_micros: 0,
      cash_micros: 40_000_000
    }, new Date('2026-07-29T04:02:00Z')), /task_claim_required/);
  } finally {
    database.close();
  }
});

test('submission is idempotent and abandonment closes only a claimed draft', async () => {
  const { database, env } = fixture();
  try {
    claim(database);
    const draft = await createOrResumeDraftAttempt(
      env, 'ADMIN-1', 'PAYROLL-1', new Date('2026-07-29T04:00:00Z')
    );
    await saveAttemptSplit(env, 'ADMIN-1', draft.attempt_id, {
      bank_micros: 100_000_000,
      usdt_micros: 0,
      cash_micros: 0
    }, new Date('2026-07-29T04:01:00Z'));
    database.prepare(`
      INSERT INTO payroll_payment_proofs (
        proof_id, payroll_id, attempt_id, method, object_key,
        mime_type, size_bytes, sort_order, uploaded_by, uploaded_at
      ) VALUES (
        'PROOF-1', 'PAYROLL-1', ?, 'bank', 'private-key',
        'image/jpeg', 100, 1, 'ADMIN-1', '2026-07-29T04:02:00.000Z'
      )
    `).run(draft.attempt_id);

    const submitted = await submitPaymentAttempt(
      env, 'ADMIN-1', draft.attempt_id, 'client-key-1',
      new Date('2026-07-29T04:03:00Z')
    );
    const replay = await submitPaymentAttempt(
      env, 'ADMIN-1', draft.attempt_id, 'client-key-1',
      new Date('2026-07-29T04:04:00Z')
    );
    assert.equal(submitted.status, 'submitted');
    assert.equal(replay.attempt_id, submitted.attempt_id);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS total FROM admin_audit_logs
      WHERE action = 'submit_payroll_payment_attempt'
    `).get().total, 1);
    await assert.rejects(
      submitPaymentAttempt(env, 'ADMIN-1', draft.attempt_id, 'different-key', new Date('2026-07-29T04:04:00Z')),
      /payment attempt conflict/
    );

    database.prepare(`
      UPDATE payroll_disbursements SET status = 'disputed'
      WHERE payroll_id = 'PAYROLL-1'
    `).run();
    claim(database);
    const next = await createOrResumeDraftAttempt(
      env, 'ADMIN-1', 'PAYROLL-1', new Date('2026-07-29T04:05:00Z')
    );
    await abandonDraftAttempt(env, 'ADMIN-1', next.attempt_id, new Date('2026-07-29T04:06:00Z'));
    assert.equal(database.prepare(`
      SELECT status FROM payroll_payment_attempts WHERE attempt_id = ?
    `).get(next.attempt_id).status, 'abandoned');
  } finally {
    database.close();
  }
});

test('a same-key submit loser returns the concurrent winner without duplicating its attempt audit', async () => {
  const { database, env } = fixture();
  try {
    claim(database);
    const draft = await createOrResumeDraftAttempt(
      env, 'ADMIN-1', 'PAYROLL-1', new Date('2026-07-29T04:00:00Z')
    );
    await saveAttemptSplit(env, 'ADMIN-1', draft.attempt_id, {
      bank_micros: 100_000_000,
      usdt_micros: 0,
      cash_micros: 0
    }, new Date('2026-07-29T04:01:00Z'));
    database.prepare(`
      INSERT INTO payroll_payment_proofs (
        proof_id, payroll_id, attempt_id, method, object_key,
        mime_type, size_bytes, sort_order, uploaded_by, uploaded_at
      ) VALUES (
        'CONCURRENT-PROOF', 'PAYROLL-1', ?, 'bank', 'concurrent-proof',
        'image/jpeg', 1, 1, 'ADMIN-1', '2026-07-29T04:02:00.000Z'
      )
    `).run(draft.attempt_id);
    database.prepare(`
      INSERT INTO admin_audit_logs (
        store_id, admin_id, action, target_id, details_json, created_at
      ) VALUES ('STORE-1', 'ADMIN-0', 'submit_payroll_payment_attempt',
        'PAYROLL-1', ?, '2026-07-01T00:00:00.000Z')
    `).run(JSON.stringify({ attempt_id: 'OLDER-ATTEMPT', version: 1 }));

    const nowIso = '2026-07-29T04:03:00.000Z';
    const key = 'same-concurrent-key';
    const hash = await testIdempotencyHash(key);
    let winnerCommitted = false;
    env.DB = createD1(database, {
      beforeBatchStatement(sql) {
        if (winnerCommitted || !sql.includes("SET status = 'submitted'")) return;
        winnerCommitted = true;
        database.prepare(`
          UPDATE payroll_payment_attempts
          SET status = 'submitted', submitted_by = 'ADMIN-1',
              submitted_at = ?, idempotency_key_hash = ?, updated_at = ?
          WHERE attempt_id = ?
        `).run(nowIso, hash, nowIso, draft.attempt_id);
        database.prepare(`
          UPDATE payroll_disbursements
          SET status = 'awaiting_employee_confirmation', updated_at = ?
          WHERE payroll_id = 'PAYROLL-1'
        `).run(nowIso);
        database.prepare(`
          INSERT INTO admin_audit_logs (
            store_id, admin_id, action, target_id, details_json, created_at
          ) VALUES (
            'STORE-1', 'ADMIN-1', 'submit_payroll_payment_attempt',
            'PAYROLL-1', ?, ?
          )
        `).run(JSON.stringify({
          attempt_id: draft.attempt_id,
          version: draft.version,
          proof_ids: ['CONCURRENT-PROOF'],
          idempotency_key_hash: hash
        }), nowIso);
        database.prepare(`
          DELETE FROM admin_task_claims
          WHERE task_type = 'payroll' AND task_id = 'PAYROLL-1'
        `).run();
      }
    });

    const replay = await submitPaymentAttempt(
      env,
      'ADMIN-1',
      draft.attempt_id,
      key,
      new Date(nowIso)
    );
    assert.equal(replay.status, 'submitted');
    assert.equal(replay.idempotency_key_hash, hash);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS total FROM admin_audit_logs
      WHERE action = 'submit_payroll_payment_attempt'
        AND target_id = 'PAYROLL-1'
        AND json_extract(details_json, '$.attempt_id') = ?
    `).get(draft.attempt_id).total, 1);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS total FROM admin_audit_logs
      WHERE action = 'submit_payroll_payment_attempt'
        AND target_id = 'PAYROLL-1'
    `).get().total, 2);
  } finally {
    database.close();
  }
});

test('submit final SQL rejects a proof deletion without partially freezing payment', async () => {
  const { database, env } = fixture();
  try {
    claim(database);
    const draft = await createOrResumeDraftAttempt(
      env, 'ADMIN-1', 'PAYROLL-1', new Date('2026-07-29T04:00:00Z')
    );
    await saveAttemptSplit(env, 'ADMIN-1', draft.attempt_id, {
      bank_micros: 100_000_000, usdt_micros: 0, cash_micros: 0
    }, new Date('2026-07-29T04:01:00Z'));
    database.prepare(`
      INSERT INTO payroll_payment_proofs (
        proof_id, payroll_id, attempt_id, method, object_key,
        mime_type, size_bytes, sort_order, uploaded_by, uploaded_at
      ) VALUES ('PROOF-RACE', 'PAYROLL-1', ?, 'bank', 'proof-race',
        'image/jpeg', 1, 1, 'ADMIN-1', '2026-07-29T04:02:00.000Z')
    `).run(draft.attempt_id);
    let removed = false;
    env.DB = createD1(database, {
      beforeBatchStatement(sql) {
        if (removed || !sql.includes("SET status = 'submitted'")) return;
        removed = true;
        database.prepare(`
          DELETE FROM payroll_payment_proofs WHERE proof_id = 'PROOF-RACE'
        `).run();
      }
    });

    await assert.rejects(submitPaymentAttempt(
      env, 'ADMIN-1', draft.attempt_id, 'proof-race-key',
      new Date('2026-07-29T04:03:00Z')
    ), /payment attempt conflict/);
    assert.deepEqual({ ...database.prepare(`
      SELECT a.status AS attempt_status, d.status AS payroll_status
      FROM payroll_payment_attempts a
      JOIN payroll_disbursements d ON d.payroll_id = a.payroll_id
      WHERE a.attempt_id = ?
    `).get(draft.attempt_id) }, {
      attempt_status: 'draft',
      payroll_status: 'awaiting_admin_payment'
    });
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS total FROM admin_task_claims
      WHERE task_type = 'payroll' AND task_id = 'PAYROLL-1'
    `).get().total, 1);
  } finally {
    database.close();
  }
});

test('submit final SQL rejects a claim takeover without partial writes', async () => {
  const { database, env } = fixture();
  try {
    claim(database);
    const draft = await createOrResumeDraftAttempt(
      env, 'ADMIN-1', 'PAYROLL-1', new Date('2026-07-29T04:00:00Z')
    );
    await saveAttemptSplit(env, 'ADMIN-1', draft.attempt_id, {
      bank_micros: 100_000_000, usdt_micros: 0, cash_micros: 0
    }, new Date('2026-07-29T04:01:00Z'));
    database.prepare(`
      INSERT INTO payroll_payment_proofs (
        proof_id, payroll_id, attempt_id, method, object_key,
        mime_type, size_bytes, sort_order, uploaded_by, uploaded_at
      ) VALUES ('CLAIM-RACE', 'PAYROLL-1', ?, 'bank', 'claim-race',
        'image/jpeg', 1, 1, 'ADMIN-1', '2026-07-29T04:02:00.000Z')
    `).run(draft.attempt_id);
    let taken = false;
    env.DB = createD1(database, {
      beforeBatchStatement(sql) {
        if (taken || !sql.includes("SET status = 'submitted'")) return;
        taken = true;
        database.prepare(`
          UPDATE admin_task_claims SET claimed_by = 'ADMIN-2'
          WHERE task_type = 'payroll' AND task_id = 'PAYROLL-1'
        `).run();
      }
    });

    await assert.rejects(submitPaymentAttempt(
      env, 'ADMIN-1', draft.attempt_id, 'claim-race-key',
      new Date('2026-07-29T04:03:00Z')
    ), /payment attempt conflict/);
    assert.equal(database.prepare(`
      SELECT status FROM payroll_payment_attempts WHERE attempt_id = ?
    `).get(draft.attempt_id).status, 'draft');
    assert.equal(database.prepare(`
      SELECT status FROM payroll_disbursements WHERE payroll_id = 'PAYROLL-1'
    `).get().status, 'awaiting_admin_payment');
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS total FROM admin_audit_logs
      WHERE action = 'submit_payroll_payment_attempt'
    `).get().total, 0);
  } finally {
    database.close();
  }
});

test('split batch copies the final attempt row and cannot diverge from the payroll summary', async () => {
  const { database, env } = fixture();
  try {
    claim(database);
    const draft = await createOrResumeDraftAttempt(
      env, 'ADMIN-1', 'PAYROLL-1', new Date('2026-07-29T04:00:00Z')
    );
    let raced = false;
    env.DB = createD1(database, {
      beforeBatchStatement(sql) {
        if (raced || !sql.includes('UPDATE payroll_disbursements')) return;
        raced = true;
        database.prepare(`
          UPDATE payroll_payment_attempts
          SET bank_micros = 60000000, cash_micros = 40000000
          WHERE attempt_id = ?
        `).run(draft.attempt_id);
      }
    });

    await saveAttemptSplit(env, 'ADMIN-1', draft.attempt_id, {
      bank_micros: 70_000_000, usdt_micros: 0, cash_micros: 30_000_000
    }, new Date('2026-07-29T04:01:00Z'));
    assert.deepEqual({ ...database.prepare(`
      SELECT
        a.bank_micros AS attempt_bank,
        a.cash_micros AS attempt_cash,
        d.bank_micros AS payroll_bank,
        d.cash_micros AS payroll_cash
      FROM payroll_payment_attempts a
      JOIN payroll_disbursements d ON d.payroll_id = a.payroll_id
      WHERE a.attempt_id = ?
    `).get(draft.attempt_id) }, {
      attempt_bank: 60_000_000,
      attempt_cash: 40_000_000,
      payroll_bank: 60_000_000,
      payroll_cash: 40_000_000
    });
  } finally {
    database.close();
  }
});

for (const terminal of ['employee_confirmed', 'employee_disputed']) {
  test(`the same submit idempotency key replays from ${terminal}`, async () => {
    const { database, env } = fixture();
    try {
      claim(database);
      const draft = await createOrResumeDraftAttempt(
        env, 'ADMIN-1', 'PAYROLL-1', new Date('2026-07-29T04:00:00Z')
      );
      await saveAttemptSplit(env, 'ADMIN-1', draft.attempt_id, {
        bank_micros: 100_000_000, usdt_micros: 0, cash_micros: 0
      }, new Date('2026-07-29T04:01:00Z'));
      database.prepare(`
        INSERT INTO payroll_payment_proofs (
          proof_id, payroll_id, attempt_id, method, object_key,
          mime_type, size_bytes, sort_order, uploaded_by, uploaded_at
        ) VALUES ('TERMINAL-PROOF', 'PAYROLL-1', ?, 'bank', 'terminal-proof',
          'image/jpeg', 1, 1, 'ADMIN-1', '2026-07-29T04:02:00.000Z')
      `).run(draft.attempt_id);
      await submitPaymentAttempt(
        env, 'ADMIN-1', draft.attempt_id, 'terminal-key',
        new Date('2026-07-29T04:03:00Z')
      );
      database.prepare(`
        UPDATE payroll_payment_attempts
        SET status = ?, employee_response = ?, employee_responded_at = ?
        WHERE attempt_id = ?
      `).run(
        terminal,
        terminal === 'employee_confirmed' ? 'confirmed' : 'disputed',
        '2026-07-29T05:00:00.000Z',
        draft.attempt_id
      );

      const replay = await submitPaymentAttempt(
        env, 'ADMIN-1', draft.attempt_id, 'terminal-key',
        new Date('2026-07-29T06:00:00Z')
      );
      assert.equal(replay.status, terminal);
      await assert.rejects(submitPaymentAttempt(
        env, 'ADMIN-1', draft.attempt_id, 'different-terminal-key',
        new Date('2026-07-29T06:00:00Z')
      ), /payment attempt conflict/);
      assert.equal(database.prepare(`
        SELECT COUNT(*) AS total FROM admin_audit_logs
        WHERE action = 'submit_payroll_payment_attempt'
      `).get().total, 1);
    } finally {
      database.close();
    }
  });
}

test('compatibility split adopts legacy evidence as version one before creating a new version', async () => {
  const { database, env } = fixture({ status: 'disputed' });
  try {
    database.exec(`
      UPDATE payroll_disbursements
      SET bank_micros = 100000000, current_admin_id = 'ADMIN-0'
      WHERE payroll_id = 'PAYROLL-1';
      INSERT INTO payroll_payment_proofs (
        proof_id, payroll_id, method, object_key, telegram_file_id,
        mime_type, size_bytes, sort_order, uploaded_by, uploaded_at
      ) VALUES (
        'LEGACY-PROOF', 'PAYROLL-1', 'bank', 'legacy-key', 'TG-1',
        'image/jpeg', 100, 1, 'ADMIN-0', '2026-07-16T04:00:00.000Z'
      );
    `);

    const saved = await savePaymentSplit(env, 'ADMIN-1', 'PAYROLL-1', {
      bank_micros: 60_000_000,
      usdt_micros: 0,
      cash_micros: 40_000_000
    }, new Date('2026-07-29T04:00:00Z'));

    const attempts = database.prepare(`
      SELECT attempt_id, version, status, bank_micros, cash_micros
      FROM payroll_payment_attempts ORDER BY version
    `).all();
    assert.equal(attempts.length, 2);
    assert.deepEqual(
      attempts.map((row) => [row.version, row.status]),
      [[1, 'employee_disputed'], [2, 'draft']]
    );
    assert.equal(database.prepare(`
      SELECT attempt_id FROM payroll_payment_proofs WHERE proof_id = 'LEGACY-PROOF'
    `).get().attempt_id, attempts[0].attempt_id);
    assert.equal(saved.current_payment_attempt_id, attempts[1].attempt_id);
    assert.deepEqual(
      [attempts[1].bank_micros, attempts[1].cash_micros],
      [60_000_000, 40_000_000]
    );
  } finally {
    database.close();
  }
});
