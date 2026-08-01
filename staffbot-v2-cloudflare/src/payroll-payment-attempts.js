import { makeId } from './audit.js';
import { isStoreAdmin } from './stores.js';
import { requireActiveTaskClaim } from './task-claims.js';

const METHODS = ['bank', 'usdt', 'cash'];

export function validatePaymentSplit(payroll, input) {
  const split = {
    bank_micros: input && input.bank_micros,
    usdt_micros: input && input.usdt_micros,
    cash_micros: input && input.cash_micros
  };
  for (const [field, value] of Object.entries(split)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${field} must be a non-negative safe integer`);
    }
  }
  const total = split.bank_micros + split.usdt_micros + split.cash_micros;
  if (!Number.isSafeInteger(total)
    || total !== Number(payroll.amount_snapshot_micros)) {
    throw new RangeError('payment split must equal payroll snapshot');
  }
  for (const method of METHODS) {
    if (split[`${method}_micros`] > 0
      && Number(payroll[`accepts_${method}`]) !== 1) {
      throw new RangeError(`${method} payment method was not accepted`);
    }
  }
  return split;
}

function taskFor(payroll) {
  return {
    task_type: 'payroll',
    task_id: String(payroll.payroll_id),
    store_id: String(payroll.store_id)
  };
}

async function authorizedPayroll(env, adminId, payrollId) {
  const payroll = await env.DB.prepare(`
    SELECT * FROM payroll_disbursements WHERE payroll_id = ?
  `).bind(payrollId).first();
  if (!payroll) throw new Error('payroll not found');
  if (!await isStoreAdmin(env, adminId, payroll.store_id)) {
    throw new Error('payroll admin permission denied');
  }
  return payroll;
}

async function adoptLegacyAttempt(
  env,
  payroll,
  nowIso,
  claimAdminId = null
) {
  if (payroll.current_payment_attempt_id) return payroll;
  const legacy = await env.DB.prepare(`
    SELECT
      CASE WHEN EXISTS (
        SELECT 1 FROM payroll_payment_proofs
        WHERE payroll_id = ? AND attempt_id IS NULL
      ) THEN 1 ELSE 0 END AS has_proofs
  `).bind(payroll.payroll_id).first();
  const hasSplit = METHODS.some(
    (method) => Number(payroll[`${method}_micros`]) > 0
  );
  if (!hasSplit && Number(legacy && legacy.has_proofs) !== 1) return payroll;

  const attemptId = makeId('PAYATT');
  const claimGuard = claimAdminId === null ? '' : `
    AND EXISTS (
      SELECT 1 FROM admin_task_claims c
      WHERE c.task_type = 'payroll'
        AND c.task_id = payroll_disbursements.payroll_id
        AND c.store_id = payroll_disbursements.store_id
        AND c.claimed_by = ?
        AND c.lease_expires_at > ?
    )
  `;
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO payroll_payment_attempts (
        attempt_id, payroll_id, version, status,
        bank_micros, usdt_micros, cash_micros,
        submitted_by, submitted_at,
        employee_response, employee_responded_at,
        created_at, updated_at
      )
      SELECT
        ?, payroll_id, 1,
        CASE status
          WHEN 'confirmed' THEN 'employee_confirmed'
          WHEN 'disputed' THEN 'employee_disputed'
          WHEN 'awaiting_employee_confirmation' THEN 'submitted'
          ELSE 'draft'
        END,
        bank_micros, usdt_micros, cash_micros,
        current_admin_id,
        CASE
          WHEN status IN ('confirmed', 'disputed', 'awaiting_employee_confirmation')
            THEN COALESCE(payment_sent_at, updated_at)
          ELSE NULL
        END,
        CASE status
          WHEN 'confirmed' THEN 'confirmed'
          WHEN 'disputed' THEN 'disputed'
          ELSE NULL
        END,
        CASE status
          WHEN 'confirmed' THEN COALESCE(confirmed_at, updated_at)
          WHEN 'disputed' THEN COALESCE(disputed_at, updated_at)
          ELSE NULL
        END,
        created_at, ?
      FROM payroll_disbursements
      WHERE payroll_id = ?
        AND current_payment_attempt_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM payroll_payment_attempts
          WHERE payroll_id = ?
        )
        AND (
          bank_micros > 0 OR usdt_micros > 0 OR cash_micros > 0
          OR EXISTS (
            SELECT 1 FROM payroll_payment_proofs
            WHERE payroll_id = ? AND attempt_id IS NULL
          )
        )
        ${claimGuard}
    `).bind(
      attemptId,
      nowIso,
      payroll.payroll_id,
      payroll.payroll_id,
      payroll.payroll_id,
      ...(claimAdminId === null ? [] : [String(claimAdminId), nowIso])
    ),
    env.DB.prepare(`
      UPDATE payroll_payment_proofs
      SET attempt_id = ?
      WHERE payroll_id = ? AND attempt_id IS NULL
        AND EXISTS (
          SELECT 1 FROM payroll_payment_attempts
          WHERE attempt_id = ? AND payroll_id = ? AND version = 1
        )
    `).bind(
      attemptId,
      payroll.payroll_id,
      attemptId,
      payroll.payroll_id
    ),
    env.DB.prepare(`
      UPDATE payroll_disbursements
      SET current_payment_attempt_id = ?, updated_at = ?
      WHERE payroll_id = ? AND current_payment_attempt_id IS NULL
        AND EXISTS (
          SELECT 1 FROM payroll_payment_attempts
          WHERE attempt_id = ? AND payroll_id = ? AND version = 1
        )
    `).bind(
      attemptId,
      nowIso,
      payroll.payroll_id,
      attemptId,
      payroll.payroll_id
    )
  ]);
  return env.DB.prepare(`
    SELECT * FROM payroll_disbursements WHERE payroll_id = ?
  `).bind(payroll.payroll_id).first();
}

async function currentDraft(env, payrollId) {
  return env.DB.prepare(`
    SELECT * FROM payroll_payment_attempts
    WHERE payroll_id = ? AND status = 'draft'
    ORDER BY version DESC LIMIT 1
  `).bind(payrollId).first();
}

async function createDraft(env, adminId, payroll, nowIso, requireClaim) {
  const attemptId = makeId('PAYATT');
  const claimGuard = requireClaim ? `
    AND EXISTS (
      SELECT 1 FROM admin_task_claims c
      WHERE c.task_type = 'payroll'
        AND c.task_id = d.payroll_id
        AND c.store_id = d.store_id
        AND c.claimed_by = ?
        AND c.lease_expires_at > ?
    )
  ` : '';
  const bind = [
    attemptId,
    nowIso,
    nowIso,
    payroll.payroll_id,
    ...(requireClaim ? [String(adminId), nowIso] : [])
  ];
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO payroll_payment_attempts (
        attempt_id, payroll_id, version, status,
        bank_micros, usdt_micros, cash_micros,
        created_at, updated_at
      )
      SELECT
        ?, d.payroll_id,
        COALESCE((
          SELECT MAX(a.version) + 1
          FROM payroll_payment_attempts a
          WHERE a.payroll_id = d.payroll_id
        ), 1),
        'draft', 0, 0, 0, ?, ?
      FROM payroll_disbursements d
      WHERE d.payroll_id = ?
        AND d.status IN ('awaiting_admin_payment', 'disputed')
        AND NOT EXISTS (
          SELECT 1 FROM payroll_payment_attempts existing
          WHERE existing.payroll_id = d.payroll_id
            AND existing.status = 'draft'
        )
        ${claimGuard}
    `).bind(...bind),
    env.DB.prepare(`
      UPDATE payroll_disbursements
      SET current_payment_attempt_id = ?,
          current_admin_id = ?,
          status = 'awaiting_admin_payment',
          payment_sent_at = NULL,
          updated_at = ?
      WHERE payroll_id = ?
        AND status IN ('awaiting_admin_payment', 'disputed')
        AND EXISTS (
          SELECT 1 FROM payroll_payment_attempts
          WHERE attempt_id = ? AND payroll_id = ? AND status = 'draft'
        )
        ${requireClaim ? `AND EXISTS (
          SELECT 1 FROM admin_task_claims c
          WHERE c.task_type = 'payroll'
            AND c.task_id = payroll_disbursements.payroll_id
            AND c.store_id = payroll_disbursements.store_id
            AND c.claimed_by = ?
            AND c.lease_expires_at > ?
        )` : ''}
    `).bind(
      attemptId,
      String(adminId),
      nowIso,
      payroll.payroll_id,
      attemptId,
      payroll.payroll_id,
      ...(requireClaim ? [String(adminId), nowIso] : [])
    ),
    env.DB.prepare(`
      INSERT INTO admin_audit_logs (
        store_id, admin_id, action, target_id, details_json, created_at
      )
      SELECT d.store_id, ?, 'create_payroll_payment_attempt', d.payroll_id,
        json_object('attempt_id', a.attempt_id, 'version', a.version), ?
      FROM payroll_disbursements d
      JOIN payroll_payment_attempts a
        ON a.attempt_id = ? AND a.payroll_id = d.payroll_id
      WHERE d.payroll_id = ? AND a.created_at = ?
    `).bind(
      String(adminId),
      nowIso,
      attemptId,
      payroll.payroll_id,
      nowIso
    )
  ]);
  return currentDraft(env, payroll.payroll_id);
}

export async function createOrResumeDraftAttempt(
  env,
  adminId,
  payrollId,
  now = new Date()
) {
  let payroll = await authorizedPayroll(env, adminId, payrollId);
  if (!['awaiting_admin_payment', 'disputed'].includes(payroll.status)) {
    throw new Error('payroll is not accepting a payment attempt');
  }
  await requireActiveTaskClaim(env, adminId, taskFor(payroll), now);
  const nowIso = new Date(now).toISOString();
  payroll = await adoptLegacyAttempt(
    env,
    payroll,
    nowIso,
    String(adminId)
  );

  const existing = await currentDraft(env, payroll.payroll_id);
  if (existing) {
    await requireActiveTaskClaim(env, adminId, taskFor(payroll), now);
    return existing;
  }
  const draft = await createDraft(env, adminId, payroll, nowIso, true);
  if (!draft) throw new Error('task_claim_required');
  return draft;
}

async function attemptContext(env, attemptId) {
  return env.DB.prepare(`
    SELECT
      a.*,
      d.store_id, d.telegram_id, d.amount_snapshot_micros,
      d.accepts_bank, d.accepts_usdt, d.accepts_cash,
      d.status AS payroll_status,
      d.current_payment_attempt_id
    FROM payroll_payment_attempts a
    JOIN payroll_disbursements d ON d.payroll_id = a.payroll_id
    WHERE a.attempt_id = ?
  `).bind(attemptId).first();
}

export async function saveAttemptSplit(
  env,
  adminId,
  attemptId,
  input,
  now = new Date()
) {
  const context = await attemptContext(env, attemptId);
  if (!context) throw new Error('payment attempt not found');
  if (!await isStoreAdmin(env, adminId, context.store_id)) {
    throw new Error('payroll admin permission denied');
  }
  const checkedAt = new Date(now);
  await requireActiveTaskClaim(env, adminId, taskFor(context), checkedAt);
  if (context.status !== 'draft') throw new Error('payment attempt conflict');
  const split = validatePaymentSplit(context, input);
  const nowIso = checkedAt.toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE payroll_payment_attempts
      SET bank_micros = ?, usdt_micros = ?, cash_micros = ?, updated_at = ?
      WHERE attempt_id = ? AND payroll_id = ? AND status = 'draft'
        AND EXISTS (
          SELECT 1 FROM payroll_disbursements d
          JOIN admin_task_claims c
            ON c.task_type = 'payroll'
           AND c.task_id = d.payroll_id
           AND c.store_id = d.store_id
          WHERE d.payroll_id = payroll_payment_attempts.payroll_id
            AND d.status IN ('awaiting_admin_payment', 'disputed')
            AND c.claimed_by = ? AND c.lease_expires_at > ?
        )
    `).bind(
      split.bank_micros,
      split.usdt_micros,
      split.cash_micros,
      nowIso,
      context.attempt_id,
      context.payroll_id,
      String(adminId),
      nowIso
    ),
    env.DB.prepare(`
      UPDATE payroll_disbursements
      SET bank_micros = ?, usdt_micros = ?, cash_micros = ?,
          current_payment_attempt_id = ?, current_admin_id = ?,
          status = 'awaiting_admin_payment', payment_sent_at = NULL,
          updated_at = ?
      WHERE payroll_id = ?
        AND status IN ('awaiting_admin_payment', 'disputed')
        AND EXISTS (
          SELECT 1 FROM payroll_payment_attempts a
          JOIN admin_task_claims c
            ON c.task_type = 'payroll'
           AND c.task_id = payroll_disbursements.payroll_id
           AND c.store_id = payroll_disbursements.store_id
          WHERE a.attempt_id = ?
            AND a.payroll_id = payroll_disbursements.payroll_id
            AND a.status = 'draft'
            AND c.claimed_by = ? AND c.lease_expires_at > ?
        )
    `).bind(
      split.bank_micros,
      split.usdt_micros,
      split.cash_micros,
      context.attempt_id,
      String(adminId),
      nowIso,
      context.payroll_id,
      context.attempt_id,
      String(adminId),
      nowIso
    ),
    env.DB.prepare(`
      INSERT INTO admin_audit_logs (
        store_id, admin_id, action, target_id, details_json, created_at
      )
      SELECT ?, ?, 'save_payroll_payment_attempt_split', ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM payroll_payment_attempts
        WHERE attempt_id = ? AND updated_at = ? AND status = 'draft'
      )
    `).bind(
      context.store_id,
      String(adminId),
      context.payroll_id,
      JSON.stringify({ attempt_id: context.attempt_id, ...split }),
      nowIso,
      context.attempt_id,
      nowIso
    )
  ]);
  if (Number(results[0] && results[0].meta.changes) !== 1
    || Number(results[1] && results[1].meta.changes) !== 1) {
    throw new Error('task_claim_required');
  }
  return env.DB.prepare(`
    SELECT * FROM payroll_payment_attempts WHERE attempt_id = ?
  `).bind(context.attempt_id).first();
}

async function idempotencyHash(value) {
  const key = String(value || '').trim();
  if (!key) throw new TypeError('idempotency key is required');
  const bytes = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function submitPaymentAttempt(
  env,
  adminId,
  attemptId,
  idempotencyKey,
  now = new Date()
) {
  const hash = await idempotencyHash(idempotencyKey);
  const context = await attemptContext(env, attemptId);
  if (!context) throw new Error('payment attempt not found');
  if (!await isStoreAdmin(env, adminId, context.store_id)) {
    throw new Error('payroll admin permission denied');
  }
  if (context.status === 'submitted') {
    if (context.idempotency_key_hash === hash) {
      return env.DB.prepare(`
        SELECT * FROM payroll_payment_attempts WHERE attempt_id = ?
      `).bind(context.attempt_id).first();
    }
    throw new Error('payment attempt conflict');
  }
  if (context.status !== 'draft') throw new Error('payment attempt conflict');
  const checkedAt = new Date(now);
  await requireActiveTaskClaim(env, adminId, taskFor(context), checkedAt);
  validatePaymentSplit(context, context);

  const proofRows = await env.DB.prepare(`
    SELECT method, COUNT(*) AS proof_count
    FROM payroll_payment_proofs
    WHERE attempt_id = ? AND superseded_at IS NULL
    GROUP BY method
  `).bind(context.attempt_id).all();
  const proofCounts = new Map((proofRows.results || []).map(
    (row) => [String(row.method), Number(row.proof_count)]
  ));
  const missing = METHODS.filter((method) =>
    Number(context[`${method}_micros`]) > 0 && !proofCounts.get(method)
  );
  if (missing.length) {
    const error = new Error('payroll proofs are incomplete');
    error.missing_methods = missing;
    throw error;
  }

  const nowIso = checkedAt.toISOString();
  const proofIds = await env.DB.prepare(`
    SELECT proof_id FROM payroll_payment_proofs
    WHERE attempt_id = ? AND superseded_at IS NULL
    ORDER BY method, sort_order
  `).bind(context.attempt_id).all();
  const auditDetails = JSON.stringify({
    attempt_id: context.attempt_id,
    version: Number(context.version),
    proof_ids: (proofIds.results || []).map((row) => String(row.proof_id)),
    idempotency_key_hash: hash
  });
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE payroll_payment_attempts
      SET status = 'submitted', submitted_by = ?, submitted_at = ?,
          idempotency_key_hash = ?, updated_at = ?
      WHERE attempt_id = ? AND payroll_id = ? AND status = 'draft'
        AND EXISTS (
          SELECT 1 FROM payroll_disbursements d
          JOIN admin_task_claims c
            ON c.task_type = 'payroll'
           AND c.task_id = d.payroll_id
           AND c.store_id = d.store_id
          WHERE d.payroll_id = payroll_payment_attempts.payroll_id
            AND d.current_payment_attempt_id = payroll_payment_attempts.attempt_id
            AND d.status = 'awaiting_admin_payment'
            AND c.claimed_by = ? AND c.lease_expires_at > ?
        )
    `).bind(
      String(adminId), nowIso, hash, nowIso,
      context.attempt_id, context.payroll_id,
      String(adminId), nowIso
    ),
    env.DB.prepare(`
      UPDATE payroll_disbursements
      SET bank_micros = ?, usdt_micros = ?, cash_micros = ?,
          current_payment_attempt_id = ?, current_admin_id = ?,
          status = 'awaiting_employee_confirmation', updated_at = ?
      WHERE payroll_id = ? AND current_payment_attempt_id = ?
        AND status = 'awaiting_admin_payment'
        AND EXISTS (
          SELECT 1 FROM payroll_payment_attempts a
          WHERE a.attempt_id = ? AND a.status = 'submitted'
            AND a.idempotency_key_hash = ?
        )
    `).bind(
      context.bank_micros,
      context.usdt_micros,
      context.cash_micros,
      context.attempt_id,
      String(adminId),
      nowIso,
      context.payroll_id,
      context.attempt_id,
      context.attempt_id,
      hash
    ),
    env.DB.prepare(`
      INSERT INTO admin_audit_logs (
        store_id, admin_id, action, target_id, details_json, created_at
      )
      SELECT ?, ?, 'submit_payroll_payment_attempt', ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM payroll_payment_attempts
        WHERE attempt_id = ? AND status = 'submitted'
          AND submitted_at = ? AND idempotency_key_hash = ?
      )
    `).bind(
      context.store_id,
      String(adminId),
      context.payroll_id,
      auditDetails,
      nowIso,
      context.attempt_id,
      nowIso,
      hash
    ),
    env.DB.prepare(`
      DELETE FROM admin_task_claims
      WHERE task_type = 'payroll' AND task_id = ? AND store_id = ?
        AND claimed_by = ? AND lease_expires_at > ?
        AND EXISTS (
          SELECT 1 FROM payroll_payment_attempts
          WHERE attempt_id = ? AND status = 'submitted'
            AND idempotency_key_hash = ?
        )
    `).bind(
      context.payroll_id,
      context.store_id,
      String(adminId),
      nowIso,
      context.attempt_id,
      hash
    )
  ]);
  if (Number(results[0] && results[0].meta.changes) !== 1
    || Number(results[1] && results[1].meta.changes) !== 1) {
    throw new Error('task_claim_required');
  }
  return env.DB.prepare(`
    SELECT * FROM payroll_payment_attempts WHERE attempt_id = ?
  `).bind(context.attempt_id).first();
}

export async function abandonDraftAttempt(
  env,
  adminId,
  attemptId,
  now = new Date()
) {
  const context = await attemptContext(env, attemptId);
  if (!context) throw new Error('payment attempt not found');
  if (!await isStoreAdmin(env, adminId, context.store_id)) {
    throw new Error('payroll admin permission denied');
  }
  const checkedAt = new Date(now);
  await requireActiveTaskClaim(env, adminId, taskFor(context), checkedAt);
  const nowIso = checkedAt.toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE payroll_payment_attempts
      SET status = 'abandoned', updated_at = ?
      WHERE attempt_id = ? AND status = 'draft'
        AND EXISTS (
          SELECT 1 FROM admin_task_claims
          WHERE task_type = 'payroll' AND task_id = ? AND store_id = ?
            AND claimed_by = ? AND lease_expires_at > ?
        )
    `).bind(
      nowIso,
      context.attempt_id,
      context.payroll_id,
      context.store_id,
      String(adminId),
      nowIso
    ),
    env.DB.prepare(`
      INSERT INTO admin_audit_logs (
        store_id, admin_id, action, target_id, details_json, created_at
      )
      SELECT ?, ?, 'abandon_payroll_payment_attempt', ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM payroll_payment_attempts
        WHERE attempt_id = ? AND status = 'abandoned' AND updated_at = ?
      )
    `).bind(
      context.store_id,
      String(adminId),
      context.payroll_id,
      JSON.stringify({ attempt_id: context.attempt_id, version: context.version }),
      nowIso,
      context.attempt_id,
      nowIso
    ),
    env.DB.prepare(`
      DELETE FROM admin_task_claims
      WHERE task_type = 'payroll' AND task_id = ? AND store_id = ?
        AND claimed_by = ? AND lease_expires_at > ?
        AND EXISTS (
          SELECT 1 FROM payroll_payment_attempts
          WHERE attempt_id = ? AND status = 'abandoned'
        )
    `).bind(
      context.payroll_id,
      context.store_id,
      String(adminId),
      nowIso,
      context.attempt_id
    )
  ]);
  if (Number(results[0] && results[0].meta.changes) !== 1) {
    throw new Error('payment attempt conflict');
  }
}

export async function saveCompatibilityPaymentSplit(
  env,
  adminId,
  payrollId,
  input,
  now = new Date()
) {
  let payroll = await authorizedPayroll(env, adminId, payrollId);
  if (!['awaiting_admin_payment', 'disputed'].includes(payroll.status)) {
    throw new Error('payroll is not accepting a payment split');
  }
  const split = validatePaymentSplit(payroll, input);
  const originalStatus = payroll.status;
  const nowIso = new Date(now).toISOString();
  payroll = await adoptLegacyAttempt(env, payroll, nowIso);
  let draft = await currentDraft(env, payroll.payroll_id);
  if (!draft) {
    draft = await createDraft(env, adminId, payroll, nowIso, false);
  }
  if (!draft) throw new Error('payroll payment split conflict');

  const statements = [];
  if (originalStatus === 'disputed') {
    statements.push(env.DB.prepare(`
      UPDATE payroll_payment_proofs
      SET superseded_at = ?
      WHERE payroll_id = ? AND attempt_id <> ? AND superseded_at IS NULL
    `).bind(nowIso, payroll.payroll_id, draft.attempt_id));
  }
  statements.push(
    env.DB.prepare(`
      UPDATE payroll_payment_attempts
      SET bank_micros = ?, usdt_micros = ?, cash_micros = ?, updated_at = ?
      WHERE attempt_id = ? AND payroll_id = ? AND status = 'draft'
    `).bind(
      split.bank_micros,
      split.usdt_micros,
      split.cash_micros,
      nowIso,
      draft.attempt_id,
      payroll.payroll_id
    ),
    env.DB.prepare(`
      UPDATE payroll_disbursements
      SET bank_micros = ?, usdt_micros = ?, cash_micros = ?,
          current_payment_attempt_id = ?, current_admin_id = ?,
          status = 'awaiting_admin_payment', payment_sent_at = NULL,
          updated_at = ?
      WHERE payroll_id = ?
        AND status IN ('awaiting_admin_payment', 'disputed')
        AND EXISTS (
          SELECT 1 FROM payroll_payment_attempts
          WHERE attempt_id = ? AND status = 'draft'
        )
    `).bind(
      split.bank_micros,
      split.usdt_micros,
      split.cash_micros,
      draft.attempt_id,
      String(adminId),
      nowIso,
      payroll.payroll_id,
      draft.attempt_id
    ),
    env.DB.prepare(`
      INSERT INTO admin_audit_logs (
        store_id, admin_id, action, target_id, details_json, created_at
      )
      SELECT ?, ?, 'save_payroll_payment_split', ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM payroll_payment_attempts
        WHERE attempt_id = ? AND status = 'draft' AND updated_at = ?
      )
    `).bind(
      payroll.store_id,
      String(adminId),
      payroll.payroll_id,
      JSON.stringify({ attempt_id: draft.attempt_id, version: draft.version, ...split }),
      nowIso,
      draft.attempt_id,
      nowIso
    )
  );
  const results = await env.DB.batch(statements);
  const attemptIndex = originalStatus === 'disputed' ? 1 : 0;
  if (Number(results[attemptIndex] && results[attemptIndex].meta.changes) !== 1
    || Number(results[attemptIndex + 1] && results[attemptIndex + 1].meta.changes) !== 1) {
    throw new Error('payroll payment split conflict');
  }
  return env.DB.prepare(`
    SELECT * FROM payroll_disbursements WHERE payroll_id = ?
  `).bind(payroll.payroll_id).first();
}
