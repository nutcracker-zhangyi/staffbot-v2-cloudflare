import { makeId } from './audit.js';
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

  const orderRow = await env.DB.prepare(`
    SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order
    FROM payroll_payment_proofs
    WHERE attempt_id = ? AND method = ?
  `).bind(payroll.current_payment_attempt_id, method).first();
  const sortOrder = Number(orderRow && orderRow.next_order || 1);
  const uploadedAt = now.toISOString();
  try {
    await env.DB.prepare(`
      INSERT INTO payroll_payment_proofs (
        proof_id, payroll_id, attempt_id, method, object_key,
        telegram_file_id, file_name, mime_type,
        size_bytes, sort_order, uploaded_by, uploaded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      proofId,
      payroll.payroll_id,
      payroll.current_payment_attempt_id,
      method,
      key,
      image.telegram_file_id,
      image.file_name,
      image.mime_type,
      image.size_bytes,
      sortOrder,
      String(adminId),
      uploadedAt
    ).run();
  } catch (error) {
    await env.PAYROLL_PROOFS.delete(key);
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
    `).bind(
      String(adminId),
      nowIso,
      nowIso,
      payroll.current_payment_attempt_id,
      payroll.payroll_id
    ),
    env.DB.prepare(`
      UPDATE payroll_disbursements
      SET status = 'awaiting_employee_confirmation',
          current_admin_id = ?,
          updated_at = ?
      WHERE payroll_id = ?
        AND status = 'awaiting_admin_payment'
        AND current_payment_attempt_id = ?
        AND EXISTS (
          SELECT 1 FROM payroll_payment_attempts
          WHERE attempt_id = ? AND status = 'submitted'
        )
    `).bind(
      String(adminId),
      nowIso,
      payroll.payroll_id,
      payroll.current_payment_attempt_id,
      payroll.current_payment_attempt_id
    ),
    env.DB.prepare(`
      INSERT INTO admin_audit_logs (
        store_id, admin_id, action, target_id,
        details_json, created_at
      )
      SELECT ?, ?, 'complete_payroll_proofs', ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM payroll_disbursements
        WHERE payroll_id = ?
          AND status = 'awaiting_employee_confirmation'
          AND updated_at = ?
      )
    `).bind(
      payroll.store_id,
      String(adminId),
      payroll.payroll_id,
      JSON.stringify({
        required_methods: ['bank', 'usdt', 'cash'].filter(
          (method) => Number(payroll[`${method}_micros`]) > 0
        )
      }),
      nowIso,
      payroll.payroll_id,
      nowIso
    )
  ]);
  if (Number(results[0] && results[0].meta.changes) !== 1
    || Number(results[1] && results[1].meta.changes) !== 1) {
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
