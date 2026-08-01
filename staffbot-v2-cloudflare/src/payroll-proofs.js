import { logEvent, makeId } from './audit.js';
import { isStoreAdmin } from './stores.js';
import { downloadTelegramImage } from './telegram-images.js';

const DEFAULT_MAX_PROOF_BYTES = 10 * 1024 * 1024;

function safeKeyPart(value) {
  return encodeURIComponent(String(value || '').trim());
}

export function proofObjectKey(
  payroll,
  method,
  proofId,
  extension
) {
  if (!['bank', 'usdt', 'cash'].includes(method)) {
    throw new TypeError('unsupported proof method');
  }
  if (!/^[a-z0-9]+$/i.test(extension)) {
    throw new TypeError('invalid proof extension');
  }
  return [
    'payroll',
    safeKeyPart(payroll.store_id),
    safeKeyPart(payroll.payroll_id),
    method,
    `${safeKeyPart(proofId)}.${extension.toLowerCase()}`
  ].join('/');
}

function maximumProofBytes(env) {
  const configured = Number(env && env.PAYROLL_PROOF_MAX_BYTES);
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_PROOF_BYTES;
}

async function reportProofCleanupFailure(env, context, cleanupError) {
  const details = {
    store_id: context.store_id,
    object_key: context.object_key,
    proof_id: context.proof_id,
    payroll_id: context.payroll_id,
    attempt_id: context.attempt_id,
    cleanup_error: cleanupError && cleanupError.message
      ? cleanupError.message
      : String(cleanupError)
  };
  try {
    await logEvent(
      env,
      'error',
      'payroll_proof_r2_cleanup_failed',
      details
    );
  } catch (loggingError) {
    console.error('payroll proof R2 cleanup failed', {
      ...details,
      logging_error: loggingError && loggingError.message
        ? loggingError.message
        : String(loggingError)
    });
  }
}

async function proofPayroll(env, adminId, payrollId, method) {
  const payroll = await env.DB.prepare(`
    SELECT * FROM payroll_disbursements
    WHERE payroll_id = ?
  `).bind(payrollId).first();
  if (!payroll) throw new Error('payroll not found');
  if (!(await isStoreAdmin(env, adminId, payroll.store_id))) {
    throw new Error('payroll proof permission denied');
  }
  if (payroll.status !== 'awaiting_admin_payment') {
    throw new Error('payroll is not accepting proofs');
  }
  if (String(payroll.current_admin_id || '') !== String(adminId)) {
    throw new Error('payroll payment attempt owner conflict');
  }
  if (!['bank', 'usdt', 'cash'].includes(method)
    || Number(payroll[`${method}_micros`]) <= 0) {
    throw new Error('proof method has no payment');
  }
  if (!payroll.current_payment_attempt_id) {
    throw new Error('payroll payment attempt is required');
  }
  const attempt = await env.DB.prepare(`
    SELECT attempt_id FROM payroll_payment_attempts
    WHERE attempt_id = ? AND payroll_id = ? AND status = 'draft'
  `).bind(
    payroll.current_payment_attempt_id,
    payroll.payroll_id
  ).first();
  if (!attempt) throw new Error('payroll payment attempt is required');
  return payroll;
}

export async function storeTelegramProof(
  env,
  adminId,
  payrollId,
  method,
  photo,
  now = new Date()
) {
  if (!env.PAYROLL_PROOFS) {
    throw new Error('payroll proof storage is not configured');
  }
  const payroll = await proofPayroll(
    env,
    adminId,
    payrollId,
    method
  );
  let image;
  try {
    image = await downloadTelegramImage(env, photo, {
      maxBytes: maximumProofBytes(env)
    });
  } catch (error) {
    if (error.message === 'telegram image is required') {
      throw new Error('payroll proof photo is required');
    }
    if (error.message === 'telegram image is too large') {
      throw new RangeError('payroll proof is too large');
    }
    if (error.message === 'telegram upload must be an image') {
      throw new TypeError('payroll proof must be an image');
    }
    throw error;
  }

  const proofId = makeId('PROOF');
  const key = proofObjectKey(
    payroll,
    method,
    proofId,
    image.extension
  );
  if (await env.PAYROLL_PROOFS.head(key)) {
    throw new Error('payroll proof object already exists');
  }
  const stored = await env.PAYROLL_PROOFS.put(key, image.bytes, {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: image.mime_type }
  });
  if (!stored) throw new Error('payroll proof object already exists');

  const uploadedAt = now.toISOString();
  try {
    const inserted = await env.DB.prepare(`
      INSERT INTO payroll_payment_proofs (
        proof_id, payroll_id, attempt_id, method, object_key,
        telegram_file_id, file_name, mime_type,
        size_bytes, sort_order, uploaded_by, uploaded_at
      )
      SELECT
        ?, d.payroll_id, a.attempt_id, ?, ?, ?, ?, ?, ?,
        COALESCE((
          SELECT MAX(sort_order) + 1
          FROM payroll_payment_proofs
          WHERE attempt_id = a.attempt_id AND method = ?
        ), 1),
        ?, ?
      FROM payroll_disbursements d
      JOIN payroll_payment_attempts a
        ON a.attempt_id = d.current_payment_attempt_id
       AND a.payroll_id = d.payroll_id
      WHERE d.payroll_id = ?
        AND d.store_id = ?
        AND d.status = 'awaiting_admin_payment'
        AND d.current_admin_id = ?
        AND a.status = 'draft'
        AND a.${method}_micros > 0
    `).bind(
      proofId,
      method,
      key,
      image.telegram_file_id,
      image.file_name,
      image.mime_type,
      image.size_bytes,
      method,
      String(adminId),
      uploadedAt,
      payroll.payroll_id,
      payroll.store_id,
      String(adminId)
    ).run();
    if (Number(inserted && inserted.meta.changes) !== 1) {
      throw new Error('payroll proof upload conflict');
    }
  } catch (error) {
    try {
      await env.PAYROLL_PROOFS.delete(key);
    } catch (cleanupError) {
      await reportProofCleanupFailure(env, {
        store_id: payroll.store_id,
        object_key: key,
        proof_id: proofId,
        payroll_id: payroll.payroll_id,
        attempt_id: payroll.current_payment_attempt_id
      }, cleanupError);
    }
    throw error;
  }
  return env.DB.prepare(`
    SELECT * FROM payroll_payment_proofs
    WHERE proof_id = ?
  `).bind(proofId).first();
}

export async function proofCompletion(env, payrollId) {
  const payroll = await env.DB.prepare(`
    SELECT
      d.current_payment_attempt_id,
      a.bank_micros, a.usdt_micros, a.cash_micros
    FROM payroll_disbursements d
    JOIN payroll_payment_attempts a
      ON a.attempt_id = d.current_payment_attempt_id
     AND a.payroll_id = d.payroll_id
     AND a.status = 'draft'
    WHERE d.payroll_id = ?
  `).bind(payrollId).first();
  if (!payroll) throw new Error('payroll not found');
  const rows = await env.DB.prepare(`
    SELECT method, COUNT(*) AS proof_count
    FROM payroll_payment_proofs
    WHERE attempt_id = ?
      AND superseded_at IS NULL
    GROUP BY method
  `).bind(payroll.current_payment_attempt_id).all();
  const counts = new Map(
    (rows.results || []).map((row) => [
      row.method,
      Number(row.proof_count)
    ])
  );
  const missingMethods = ['bank', 'usdt', 'cash']
    .filter((method) =>
      Number(payroll[`${method}_micros`]) > 0
      && !counts.get(method)
    );
  return {
    complete: missingMethods.length === 0,
    missing_methods: missingMethods
  };
}

export async function completePayrollProofs(
  env,
  adminId,
  payrollId,
  now = new Date()
) {
  const payroll = await env.DB.prepare(`
    SELECT * FROM payroll_disbursements
    WHERE payroll_id = ?
  `).bind(payrollId).first();
  if (!payroll) throw new Error('payroll not found');
  if (!(await isStoreAdmin(env, adminId, payroll.store_id))) {
    throw new Error('payroll proof permission denied');
  }
  const completion = await proofCompletion(env, payrollId);
  if (!completion.complete) {
    const error = new Error('payroll proofs are incomplete');
    error.missing_methods = completion.missing_methods;
    throw error;
  }
  const nowIso = now.toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE payroll_payment_attempts
      SET status = 'submitted', submitted_by = ?, submitted_at = ?,
          updated_at = ?
      WHERE attempt_id = ? AND payroll_id = ? AND status = 'draft'
        AND EXISTS (
          SELECT 1 FROM payroll_disbursements d
          WHERE d.payroll_id = payroll_payment_attempts.payroll_id
            AND d.current_payment_attempt_id = payroll_payment_attempts.attempt_id
            AND d.current_admin_id = ?
            AND d.status = 'awaiting_admin_payment'
            AND payroll_payment_attempts.bank_micros
              + payroll_payment_attempts.usdt_micros
              + payroll_payment_attempts.cash_micros
              = d.amount_snapshot_micros
            AND (
              payroll_payment_attempts.bank_micros = 0
              OR d.accepts_bank = 1
            )
            AND (
              payroll_payment_attempts.usdt_micros = 0
              OR d.accepts_usdt = 1
            )
            AND (
              payroll_payment_attempts.cash_micros = 0
              OR d.accepts_cash = 1
            )
            AND (
              payroll_payment_attempts.bank_micros = 0
              OR EXISTS (
                SELECT 1 FROM payroll_payment_proofs p
                WHERE p.attempt_id = payroll_payment_attempts.attempt_id
                  AND p.method = 'bank' AND p.superseded_at IS NULL
              )
            )
            AND (
              payroll_payment_attempts.usdt_micros = 0
              OR EXISTS (
                SELECT 1 FROM payroll_payment_proofs p
                WHERE p.attempt_id = payroll_payment_attempts.attempt_id
                  AND p.method = 'usdt' AND p.superseded_at IS NULL
              )
            )
            AND (
              payroll_payment_attempts.cash_micros = 0
              OR EXISTS (
                SELECT 1 FROM payroll_payment_proofs p
                WHERE p.attempt_id = payroll_payment_attempts.attempt_id
                  AND p.method = 'cash' AND p.superseded_at IS NULL
              )
            )
        )
    `).bind(
      String(adminId),
      nowIso,
      nowIso,
      payroll.current_payment_attempt_id,
      payroll.payroll_id,
      String(adminId)
    ),
    env.DB.prepare(`
      UPDATE payroll_disbursements
      SET bank_micros = (
            SELECT bank_micros FROM payroll_payment_attempts
            WHERE attempt_id = ? AND status = 'submitted'
              AND submitted_by = ? AND submitted_at = ?
          ),
          usdt_micros = (
            SELECT usdt_micros FROM payroll_payment_attempts
            WHERE attempt_id = ? AND status = 'submitted'
              AND submitted_by = ? AND submitted_at = ?
          ),
          cash_micros = (
            SELECT cash_micros FROM payroll_payment_attempts
            WHERE attempt_id = ? AND status = 'submitted'
              AND submitted_by = ? AND submitted_at = ?
          ),
          status = 'awaiting_employee_confirmation',
          current_admin_id = ?,
          updated_at = ?
      WHERE payroll_id = ?
        AND status = 'awaiting_admin_payment'
        AND current_payment_attempt_id = ?
        AND current_admin_id = ?
        AND EXISTS (
          SELECT 1 FROM payroll_payment_attempts
          WHERE attempt_id = ? AND status = 'submitted'
            AND submitted_by = ? AND submitted_at = ?
        )
    `).bind(
      payroll.current_payment_attempt_id,
      String(adminId),
      nowIso,
      payroll.current_payment_attempt_id,
      String(adminId),
      nowIso,
      payroll.current_payment_attempt_id,
      String(adminId),
      nowIso,
      String(adminId),
      nowIso,
      payroll.payroll_id,
      payroll.current_payment_attempt_id,
      String(adminId),
      payroll.current_payment_attempt_id,
      String(adminId),
      nowIso
    ),
    env.DB.prepare(`
      INSERT INTO admin_audit_logs (
        store_id, admin_id, action, target_id,
        details_json, created_at
      )
      SELECT d.store_id, ?, 'complete_payroll_proofs', d.payroll_id,
        json_object(
          'required_methods', json(COALESCE((
            SELECT json_group_array(method)
            FROM (
              SELECT 'bank' AS method, 1 AS method_order
              WHERE a.bank_micros > 0
              UNION ALL
              SELECT 'usdt', 2 WHERE a.usdt_micros > 0
              UNION ALL
              SELECT 'cash', 3 WHERE a.cash_micros > 0
              ORDER BY method_order
            )
          ), '[]'))
        ), ?
      FROM payroll_disbursements d
      JOIN payroll_payment_attempts a
        ON a.attempt_id = d.current_payment_attempt_id
       AND a.payroll_id = d.payroll_id
      WHERE d.payroll_id = ?
        AND d.status = 'awaiting_employee_confirmation'
        AND d.updated_at = ?
        AND a.status = 'submitted'
        AND a.submitted_by = ?
        AND a.submitted_at = ?
    `).bind(
      String(adminId),
      nowIso,
      payroll.payroll_id,
      nowIso,
      String(adminId),
      nowIso
    )
  ]);
  if (Number(results[0] && results[0].meta.changes) !== 1
    || Number(results[1] && results[1].meta.changes) !== 1
    || Number(results[2] && results[2].meta.changes) !== 1) {
    throw new Error('payroll proof completion conflict');
  }
  return env.DB.prepare(`
    SELECT * FROM payroll_disbursements
    WHERE payroll_id = ?
  `).bind(payroll.payroll_id).first();
}

export async function readPayrollProof(env, actor, proofId) {
  const proof = await env.DB.prepare(`
    SELECT p.*, d.store_id, d.telegram_id
    FROM payroll_payment_proofs p
    JOIN payroll_disbursements d
      ON d.payroll_id = p.payroll_id
    WHERE p.proof_id = ?
  `).bind(proofId).first();
  if (!proof) return new Response('not_found', { status: 404 });
  const telegramId = String(actor && actor.telegram_id || '');
  const employeeAccess = telegramId === String(proof.telegram_id);
  const adminAccess = (!actor || !actor.store_id
    || String(actor.store_id) === String(proof.store_id))
    && await isStoreAdmin(env, telegramId, proof.store_id);
  const allowed = employeeAccess || adminAccess;
  if (!allowed) return new Response('forbidden', { status: 403 });
  if (!env.PAYROLL_PROOFS) {
    return new Response('storage_not_configured', { status: 503 });
  }
  const object = await env.PAYROLL_PROOFS.get(proof.object_key);
  if (!object) return new Response('not_found', { status: 404 });
  const headers = new Headers();
  if (typeof object.writeHttpMetadata === 'function') {
    object.writeHttpMetadata(headers);
  } else {
    headers.set('content-type', proof.mime_type);
  }
  if (object.httpEtag) headers.set('etag', object.httpEtag);
  headers.set('cache-control', 'private, no-store');
  return new Response(object.body, { headers });
}
