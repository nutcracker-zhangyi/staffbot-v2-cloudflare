import { logEvent, makeId } from './audit.js';
import { isStoreAdmin } from './stores.js';
import { requireActiveTaskClaim } from './task-claims.js';
import { downloadTelegramImage } from './telegram-images.js';

const DEFAULT_MAX_PROOF_BYTES = 10 * 1024 * 1024;
const MAX_PROOFS_PER_METHOD = 5;
const PROOF_TYPES = {
  'image/jpeg': { extension: 'jpg', signature: isJpeg },
  'image/png': { extension: 'png', signature: isPng },
  'image/webp': { extension: 'webp', signature: isWebp }
};

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
  if (!payroll || !payroll.current_payment_attempt_id) {
    throw new TypeError('payment attempt is required for proof key');
  }
  return [
    'payroll',
    safeKeyPart(payroll.store_id),
    safeKeyPart(payroll.payroll_id),
    safeKeyPart(payroll.current_payment_attempt_id),
    method,
    `${safeKeyPart(proofId)}.${extension.toLowerCase()}`
  ].join('/');
}

function isJpeg(bytes) {
  return bytes.length >= 4
    && bytes[0] === 0xff
    && bytes[1] === 0xd8
    && bytes[bytes.length - 2] === 0xff
    && bytes[bytes.length - 1] === 0xd9;
}

function isPng(bytes) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 33
    || !signature.every((value, index) => bytes[index] === value)) {
    return false;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(8) === 13
    && String.fromCharCode(...bytes.slice(12, 16)) === 'IHDR'
    && view.getUint32(16) > 0
    && view.getUint32(20) > 0;
}

function isWebp(bytes) {
  if (bytes.length < 20
    || String.fromCharCode(...bytes.slice(0, 4)) !== 'RIFF'
    || String.fromCharCode(...bytes.slice(8, 12)) !== 'WEBP') {
    return false;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) !== bytes.length - 8) return false;
  const chunkType = String.fromCharCode(...bytes.slice(12, 16));
  const minimumSize = { 'VP8 ': 10, VP8L: 5, VP8X: 10 }[chunkType];
  if (!minimumSize) return false;
  const chunkSize = view.getUint32(16, true);
  return chunkSize >= minimumSize
    && 20 + chunkSize + (chunkSize % 2) <= bytes.length;
}

function proofClock(now) {
  if (typeof now === 'function') return () => new Date(now());
  if (now !== undefined) return () => new Date(now);
  return () => new Date();
}

async function browserImage(file) {
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new TypeError('payroll proof file is required');
  }
  const type = PROOF_TYPES[String(file.type || '').toLowerCase()];
  if (!type) throw new TypeError('payroll proof must be JPEG, PNG, or WebP');
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    throw new TypeError('payroll proof file is required');
  }
  if (file.size > DEFAULT_MAX_PROOF_BYTES) {
    throw new RangeError('payroll proof is too large');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength !== file.size || !type.signature(bytes)) {
    throw new TypeError('payroll proof bytes must match its image type');
  }
  return {
    bytes,
    extension: type.extension,
    file_name: String(file.name || `proof.${type.extension}`).slice(0, 255),
    mime_type: String(file.type).toLowerCase(),
    size_bytes: bytes.byteLength
  };
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

async function browserAttemptContext(env, adminId, attemptId, now) {
  const context = await env.DB.prepare(`
    SELECT
      a.*,
      d.store_id,
      d.telegram_id,
      d.status AS payroll_status,
      d.current_payment_attempt_id,
      d.current_admin_id
    FROM payroll_payment_attempts a
    JOIN payroll_disbursements d ON d.payroll_id = a.payroll_id
    WHERE a.attempt_id = ?
  `).bind(String(attemptId || '')).first();
  if (!context) throw new Error('payment attempt not found');
  if (!await isStoreAdmin(env, adminId, context.store_id)) {
    throw new Error('payroll proof permission denied');
  }
  if (context.status !== 'draft'
    || !['awaiting_admin_payment', 'disputed'].includes(context.payroll_status)) {
    throw new Error('payroll proof is not editable');
  }
  if (String(context.current_payment_attempt_id || '') !== String(context.attempt_id)
    || String(context.current_admin_id || '') !== String(adminId)) {
    throw new Error('payroll payment attempt owner conflict');
  }
  await requireActiveTaskClaim(env, adminId, {
    task_type: 'payroll',
    task_id: String(context.payroll_id),
    store_id: String(context.store_id)
  }, now);
  return context;
}

export async function storeBrowserDraftProof(
  env,
  adminId,
  attemptId,
  method,
  file,
  now
) {
  if (!env.PAYROLL_PROOFS) {
    throw new Error('payroll proof storage is not configured');
  }
  const paymentMethod = String(method || '');
  if (!['bank', 'usdt', 'cash'].includes(paymentMethod)) {
    throw new TypeError('unsupported proof method');
  }
  const clock = proofClock(now);
  const checkedAt = clock();
  const context = await browserAttemptContext(
    env,
    adminId,
    attemptId,
    checkedAt
  );
  if (Number(context[`${paymentMethod}_micros`]) <= 0) {
    throw new Error('proof method has no payment');
  }
  const existing = await env.DB.prepare(`
    SELECT COUNT(*) AS proof_count
    FROM payroll_payment_proofs
    WHERE attempt_id = ? AND method = ? AND superseded_at IS NULL
  `).bind(context.attempt_id, paymentMethod).first();
  if (Number(existing && existing.proof_count) >= MAX_PROOFS_PER_METHOD) {
    throw new RangeError('payroll proof limit reached');
  }
  const image = await browserImage(file);
  const proofId = makeId('PROOF');
  const key = proofObjectKey(context, paymentMethod, proofId, image.extension);
  const stored = await env.PAYROLL_PROOFS.put(key, image.bytes, {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: image.mime_type }
  });
  if (!stored) throw new Error('payroll proof object already exists');

  const uploadedAt = clock().toISOString();
  try {
    const results = await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO payroll_payment_proofs (
          proof_id, payroll_id, attempt_id, method, object_key,
          telegram_file_id, telegram_delivered_at, file_name, mime_type,
          size_bytes, sort_order, uploaded_by, uploaded_at
        )
        SELECT
          ?, d.payroll_id, a.attempt_id, ?, ?, NULL, NULL, ?, ?, ?,
          COALESCE((
            SELECT MAX(sort_order) + 1
            FROM payroll_payment_proofs
            WHERE attempt_id = a.attempt_id AND method = ?
          ), 1),
          ?, ?
        FROM payroll_payment_attempts a
        JOIN payroll_disbursements d
          ON d.payroll_id = a.payroll_id
         AND d.current_payment_attempt_id = a.attempt_id
        JOIN admin_task_claims c
          ON c.task_type = 'payroll'
         AND c.task_id = d.payroll_id
         AND c.store_id = d.store_id
        WHERE a.attempt_id = ?
          AND d.payroll_id = ?
          AND d.store_id = ?
          AND a.status = 'draft'
          AND d.status IN ('awaiting_admin_payment', 'disputed')
          AND d.current_admin_id = ?
          AND c.claimed_by = ?
          AND c.lease_expires_at > ?
          AND a.${paymentMethod}_micros > 0
          AND (
            SELECT COUNT(*) FROM payroll_payment_proofs existing
            WHERE existing.attempt_id = a.attempt_id
              AND existing.method = ?
              AND existing.superseded_at IS NULL
          ) < ?
      `).bind(
        proofId,
        paymentMethod,
        key,
        image.file_name,
        image.mime_type,
        image.size_bytes,
        paymentMethod,
        String(adminId),
        uploadedAt,
        context.attempt_id,
        context.payroll_id,
        context.store_id,
        String(adminId),
        String(adminId),
        uploadedAt,
        paymentMethod,
        MAX_PROOFS_PER_METHOD
      ),
      env.DB.prepare(`
        UPDATE payroll_payment_attempts
        SET updated_at = ?
        WHERE attempt_id = ? AND payroll_id = ? AND status = 'draft'
          AND EXISTS (
            SELECT 1
            FROM payroll_payment_proofs p
            JOIN payroll_disbursements d
              ON d.payroll_id = payroll_payment_attempts.payroll_id
             AND d.current_payment_attempt_id = payroll_payment_attempts.attempt_id
            JOIN admin_task_claims c
              ON c.task_type = 'payroll'
             AND c.task_id = d.payroll_id
             AND c.store_id = d.store_id
            WHERE p.proof_id = ?
              AND p.attempt_id = payroll_payment_attempts.attempt_id
              AND d.store_id = ?
              AND d.status IN ('awaiting_admin_payment', 'disputed')
              AND d.current_admin_id = ?
              AND c.claimed_by = ?
              AND c.lease_expires_at > ?
          )
      `).bind(
        uploadedAt,
        context.attempt_id,
        context.payroll_id,
        proofId,
        context.store_id,
        String(adminId),
        String(adminId),
        uploadedAt
      ),
      env.DB.prepare(`
        INSERT INTO admin_audit_logs (
          store_id, admin_id, action, target_id, details_json, created_at
        )
        SELECT ?, ?, 'upload_payroll_draft_proof', ?,
          json_object(
            'attempt_id', attempt_id,
            'proof_id', proof_id,
            'method', method,
            'size_bytes', size_bytes
          ), ?
        FROM payroll_payment_proofs
        WHERE proof_id = ?
        UNION ALL
        SELECT NULL, ?, 'upload_payroll_draft_proof', ?, '{}', ?
        WHERE NOT EXISTS (
          SELECT 1 FROM payroll_payment_proofs WHERE proof_id = ?
        )
      `).bind(
        context.store_id,
        String(adminId),
        context.payroll_id,
        uploadedAt,
        proofId,
        String(adminId),
        context.payroll_id,
        uploadedAt,
        proofId
      )
    ]);
    if (Number(results[0] && results[0].meta.changes) !== 1
      || Number(results[1] && results[1].meta.changes) !== 1
      || Number(results[2] && results[2].meta.changes) !== 1) {
      throw new Error('payroll proof upload conflict');
    }
  } catch (error) {
    try {
      await env.PAYROLL_PROOFS.delete(key);
    } catch (cleanupError) {
      await reportProofCleanupFailure(env, {
        store_id: context.store_id,
        object_key: key,
        proof_id: proofId,
        payroll_id: context.payroll_id,
        attempt_id: context.attempt_id
      }, cleanupError);
    }
    const conflict = new Error('payroll proof upload conflict');
    conflict.cause = error;
    throw conflict;
  }
  return env.DB.prepare(`
    SELECT * FROM payroll_payment_proofs WHERE proof_id = ?
  `).bind(proofId).first();
}

async function reportProofOrphan(env, context, error) {
  const details = {
    store_id: context.store_id,
    object_key: context.object_key,
    proof_id: context.proof_id,
    payroll_id: context.payroll_id,
    attempt_id: context.attempt_id,
    cleanup_error: error && error.message ? error.message : String(error)
  };
  try {
    await logEvent(env, 'error', 'payroll_proof_r2_orphaned', details);
  } catch (loggingError) {
    try {
      await logEvent(env, 'error', 'payroll_proof_cleanup_failed', {
        ...details,
        logging_error: loggingError && loggingError.message
          ? loggingError.message
          : String(loggingError)
      });
    } catch (fallbackError) {
      console.error('payroll proof orphan logging failed', {
        ...details,
        logging_error: loggingError && loggingError.message
          ? loggingError.message
          : String(loggingError),
        fallback_error: fallbackError && fallbackError.message
          ? fallbackError.message
          : String(fallbackError)
      });
    }
  }
}

export async function deleteBrowserDraftProof(
  env,
  adminId,
  proofId,
  now = new Date()
) {
  const proof = await env.DB.prepare(`
    SELECT
      p.*,
      a.status AS attempt_status,
      d.store_id,
      d.status AS payroll_status,
      d.current_payment_attempt_id,
      d.current_admin_id
    FROM payroll_payment_proofs p
    JOIN payroll_payment_attempts a ON a.attempt_id = p.attempt_id
    JOIN payroll_disbursements d ON d.payroll_id = a.payroll_id
    WHERE p.proof_id = ?
  `).bind(String(proofId || '')).first();
  if (!proof) throw new Error('payroll proof not found');
  if (!await isStoreAdmin(env, adminId, proof.store_id)) {
    throw new Error('payroll proof permission denied');
  }
  if (proof.attempt_status !== 'draft') {
    throw new Error('payroll proof is not editable');
  }
  if (!env.PAYROLL_PROOFS) {
    throw new Error('payroll proof storage is not configured');
  }
  const checkedAt = new Date(now);
  await requireActiveTaskClaim(env, adminId, {
    task_type: 'payroll',
    task_id: String(proof.payroll_id),
    store_id: String(proof.store_id)
  }, checkedAt);
  const nowIso = checkedAt.toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(`
      DELETE FROM payroll_payment_proofs
      WHERE proof_id = ? AND attempt_id = ?
        AND EXISTS (
          SELECT 1
          FROM payroll_payment_attempts a
          JOIN payroll_disbursements d
            ON d.payroll_id = a.payroll_id
           AND d.current_payment_attempt_id = a.attempt_id
          JOIN admin_task_claims c
            ON c.task_type = 'payroll'
           AND c.task_id = d.payroll_id
           AND c.store_id = d.store_id
          WHERE a.attempt_id = payroll_payment_proofs.attempt_id
            AND a.status = 'draft'
            AND d.status IN ('awaiting_admin_payment', 'disputed')
            AND d.current_admin_id = ?
            AND c.claimed_by = ?
            AND c.lease_expires_at > ?
        )
    `).bind(
      proof.proof_id,
      proof.attempt_id,
      String(adminId),
      String(adminId),
      nowIso
    ),
    env.DB.prepare(`
      INSERT INTO admin_audit_logs (
        store_id, admin_id, action, target_id, details_json, created_at
      )
      SELECT ?, ?, 'delete_payroll_draft_proof', ?,
        json_object(
          'attempt_id', ?, 'proof_id', ?, 'method', ?,
          'object_key', ?
        ), ?
      WHERE changes() = 1
    `).bind(
      proof.store_id,
      String(adminId),
      proof.payroll_id,
      proof.attempt_id,
      proof.proof_id,
      proof.method,
      proof.object_key,
      nowIso
    )
  ]);
  if (Number(results[0] && results[0].meta.changes) !== 1
    || Number(results[1] && results[1].meta.changes) !== 1) {
    throw new Error('task_claim_required');
  }
  try {
    await env.PAYROLL_PROOFS.delete(proof.object_key);
  } catch (error) {
    await reportProofOrphan(env, proof, error);
  }
}

export async function cleanupAbandonedDraftProofs(env, now = new Date()) {
  const checkedAt = new Date(now);
  const checkedAtIso = checkedAt.toISOString();
  const cutoff = new Date(checkedAt.getTime() - 7 * 24 * 60 * 60 * 1000)
    .toISOString();
  const rows = await env.DB.prepare(`
    SELECT p.*, d.store_id
    FROM payroll_payment_proofs p
    JOIN payroll_payment_attempts a ON a.attempt_id = p.attempt_id
    JOIN payroll_disbursements d ON d.payroll_id = a.payroll_id
    WHERE p.uploaded_at <= ?
      AND (
        (a.status = 'abandoned' AND a.updated_at <= ?)
        OR (
          a.status = 'draft' AND a.updated_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM admin_task_claims c
            WHERE c.task_type = 'payroll'
              AND c.task_id = d.payroll_id
              AND c.store_id = d.store_id
              AND c.lease_expires_at > ?
          )
        )
      )
    ORDER BY p.uploaded_at, p.proof_id
  `).bind(cutoff, cutoff, cutoff, checkedAtIso).all();
  let deleted = 0;
  let failed = 0;
  for (const proof of rows.results || []) {
    if (!env.PAYROLL_PROOFS) {
      failed += 1;
      await logEvent(env, 'error', 'payroll_proof_cleanup_failed', {
        store_id: proof.store_id,
        proof_id: proof.proof_id,
        payroll_id: proof.payroll_id,
        attempt_id: proof.attempt_id,
        cleanup_error: 'payroll proof storage is not configured'
      });
      continue;
    }
    try {
      const results = await env.DB.batch([
        env.DB.prepare(`
          DELETE FROM payroll_payment_proofs
          WHERE proof_id = ? AND attempt_id = ?
            AND uploaded_at <= ?
            AND EXISTS (
              SELECT 1
              FROM payroll_payment_attempts a
              JOIN payroll_disbursements d ON d.payroll_id = a.payroll_id
              WHERE a.attempt_id = payroll_payment_proofs.attempt_id
                AND (
                  (a.status = 'abandoned' AND a.updated_at <= ?)
                  OR (
                    a.status = 'draft' AND a.updated_at <= ?
                    AND NOT EXISTS (
                      SELECT 1 FROM admin_task_claims c
                      WHERE c.task_type = 'payroll'
                        AND c.task_id = d.payroll_id
                        AND c.store_id = d.store_id
                        AND c.lease_expires_at > ?
                    )
                  )
                )
            )
        `).bind(
          proof.proof_id,
          proof.attempt_id,
          cutoff,
          cutoff,
          cutoff,
          checkedAtIso
        ),
        env.DB.prepare(`
          INSERT INTO admin_audit_logs (
            store_id, admin_id, action, target_id, details_json, created_at
          )
          SELECT ?, 'system', 'cleanup_payroll_draft_proof', ?,
            json_object(
              'attempt_id', ?, 'proof_id', ?, 'method', ?,
              'object_key', ?, 'reason', 'draft_older_than_7_days'
            ), ?
          WHERE changes() = 1
        `).bind(
          proof.store_id,
          proof.payroll_id,
          proof.attempt_id,
          proof.proof_id,
          proof.method,
          proof.object_key,
          checkedAtIso
        )
      ]);
      if (Number(results[0] && results[0].meta.changes) !== 1
        || Number(results[1] && results[1].meta.changes) !== 1) {
        continue;
      }
      try {
        await env.PAYROLL_PROOFS.delete(proof.object_key);
        deleted += 1;
      } catch (error) {
        failed += 1;
        await reportProofOrphan(env, proof, error);
      }
    } catch (error) {
      failed += 1;
      await logEvent(env, 'error', 'payroll_proof_cleanup_failed', {
        store_id: proof.store_id,
        proof_id: proof.proof_id,
        payroll_id: proof.payroll_id,
        attempt_id: proof.attempt_id,
        cleanup_error: error && error.message ? error.message : String(error)
      });
    }
  }
  return { deleted, failed };
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
          'attempt_id', a.attempt_id,
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
        AND NOT EXISTS (
          SELECT 1 FROM admin_audit_logs existing
          WHERE existing.store_id = d.store_id
            AND existing.action = 'complete_payroll_proofs'
            AND existing.target_id = d.payroll_id
            AND json_extract(existing.details_json, '$.attempt_id')
              = a.attempt_id
        )
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
    LEFT JOIN payroll_payment_attempts a
      ON a.attempt_id = p.attempt_id
     AND a.payroll_id = p.payroll_id
    JOIN payroll_disbursements d
      ON d.payroll_id = COALESCE(a.payroll_id, p.payroll_id)
    WHERE p.proof_id = ?
      AND (p.attempt_id IS NULL OR a.attempt_id IS NOT NULL)
  `).bind(proofId).first();
  if (!proof) return new Response('not_found', { status: 404 });
  const telegramId = String(actor && actor.telegram_id || '');
  const actorMode = actor && actor.access
    ? String(actor.access)
    : (actor && actor.store_id ? 'admin' : 'employee');
  const employeeAccess = actorMode === 'employee'
    && !(actor && actor.store_id)
    && telegramId === String(proof.telegram_id);
  const adminAccess = actorMode === 'admin'
    && actor
    && String(actor.store_id || '') === String(proof.store_id)
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
