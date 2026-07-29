import { makeId } from './audit.js';
import { downloadTelegramImage } from './telegram-images.js';
import { validatePaymentProfile } from './payroll-payments.js';
import { isStoreAdmin } from './stores.js';

function safeKeyPart(value) {
  return encodeURIComponent(String(value || '').trim());
}

export function paymentQrObjectKey(owner, qrId, extension) {
  if (!/^[a-z0-9]+$/i.test(extension)) {
    throw new TypeError('invalid QR extension');
  }
  return [
    'payroll-payment-qr',
    safeKeyPart(owner.store_id),
    safeKeyPart(owner.telegram_id),
    `${safeKeyPart(qrId)}.${extension.toLowerCase()}`
  ].join('/');
}

async function editableEmployeePayroll(env, actorId, payrollId) {
  const payroll = await env.DB.prepare(`
    SELECT *
    FROM payroll_disbursements
    WHERE payroll_id = ?
  `).bind(payrollId).first();
  if (!payroll) throw new Error('payroll not found');
  if (String(payroll.telegram_id) !== String(actorId)) {
    throw new Error('payroll identity mismatch');
  }
  if (![
    'awaiting_employee_details',
    'awaiting_admin_payment'
  ].includes(payroll.status) || payroll.current_admin_id !== null) {
    throw new Error('payroll payment details are locked');
  }
  return payroll;
}

export async function saveTelegramPaymentQr(
  env,
  actorId,
  payrollId,
  profileInput,
  photo,
  now = new Date()
) {
  if (!env.PAYROLL_PROOFS) {
    throw new Error('payroll QR storage is not configured');
  }
  const payroll = await editableEmployeePayroll(
    env,
    actorId,
    payrollId
  );
  const image = await downloadTelegramImage(env, photo);
  const qrId = makeId('QR');
  const profile = validatePaymentProfile({
    ...profileInput,
    accepts_usdt: true,
    usdt_qr_id: qrId
  });
  const key = paymentQrObjectKey(
    payroll,
    qrId,
    image.extension
  );
  if (await env.PAYROLL_PROOFS.head(key)) {
    throw new Error('payroll QR object already exists');
  }
  const stored = await env.PAYROLL_PROOFS.put(key, image.bytes, {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: image.mime_type }
  });
  if (!stored) throw new Error('payroll QR object already exists');

  const nowIso = now.toISOString();
  try {
    const results = await env.DB.batch([
      env.DB.prepare(`
        UPDATE payroll_payment_qr_codes
        SET superseded_at = ?
        WHERE store_id = ?
          AND telegram_id = ?
          AND superseded_at IS NULL
          AND EXISTS (
            SELECT 1
            FROM payroll_disbursements
            WHERE payroll_id = ?
              AND telegram_id = ?
              AND status IN (
                'awaiting_employee_details',
                'awaiting_admin_payment'
              )
              AND current_admin_id IS NULL
          )
      `).bind(
        nowIso,
        payroll.store_id,
        payroll.telegram_id,
        payroll.payroll_id,
        payroll.telegram_id
      ),
      env.DB.prepare(`
        INSERT INTO payroll_payment_qr_codes (
          qr_id, store_id, telegram_id, object_key,
          telegram_file_id, mime_type, size_bytes, uploaded_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?
        FROM payroll_disbursements
        WHERE payroll_id = ?
          AND telegram_id = ?
          AND status IN (
            'awaiting_employee_details',
            'awaiting_admin_payment'
          )
          AND current_admin_id IS NULL
      `).bind(
        qrId,
        payroll.store_id,
        payroll.telegram_id,
        key,
        image.telegram_file_id,
        image.mime_type,
        image.size_bytes,
        nowIso,
        payroll.payroll_id,
        payroll.telegram_id
      ),
      env.DB.prepare(`
        INSERT INTO payroll_payment_profiles (
          store_id, telegram_id,
          accepts_bank, accepts_usdt, accepts_cash,
          bank_details, usdt_details, usdt_qr_id,
          created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM payroll_disbursements
        WHERE payroll_id = ?
          AND telegram_id = ?
          AND status IN (
            'awaiting_employee_details',
            'awaiting_admin_payment'
          )
          AND current_admin_id IS NULL
        ON CONFLICT(store_id, telegram_id) DO UPDATE SET
          accepts_bank = excluded.accepts_bank,
          accepts_usdt = excluded.accepts_usdt,
          accepts_cash = excluded.accepts_cash,
          bank_details = excluded.bank_details,
          usdt_details = excluded.usdt_details,
          usdt_qr_id = excluded.usdt_qr_id,
          updated_at = excluded.updated_at
      `).bind(
        payroll.store_id,
        payroll.telegram_id,
        profile.accepts_bank,
        profile.accepts_usdt,
        profile.accepts_cash,
        profile.bank_details,
        profile.usdt_details,
        profile.usdt_qr_id,
        nowIso,
        nowIso,
        payroll.payroll_id,
        payroll.telegram_id
      ),
      env.DB.prepare(`
        UPDATE payroll_disbursements
        SET accepts_bank = ?,
            accepts_usdt = ?,
            accepts_cash = ?,
            bank_details_snapshot = ?,
            usdt_details_snapshot = ?,
            usdt_qr_id_snapshot = ?,
            status = CASE
              WHEN status = 'awaiting_employee_details'
                THEN 'awaiting_admin_payment'
              ELSE status
            END,
            updated_at = ?
        WHERE payroll_id = ?
          AND telegram_id = ?
          AND status IN (
            'awaiting_employee_details',
            'awaiting_admin_payment'
          )
          AND current_admin_id IS NULL
      `).bind(
        profile.accepts_bank,
        profile.accepts_usdt,
        profile.accepts_cash,
        profile.bank_details,
        profile.usdt_details,
        profile.usdt_qr_id,
        nowIso,
        payroll.payroll_id,
        payroll.telegram_id
      ),
      env.DB.prepare(`
        INSERT INTO admin_audit_logs (
          store_id, admin_id, action, target_id,
          details_json, created_at
        )
        SELECT ?, ?, 'save_payroll_payment_qr', ?, ?, ?
        FROM payroll_disbursements
        WHERE payroll_id = ?
          AND telegram_id = ?
          AND updated_at = ?
      `).bind(
        payroll.store_id,
        payroll.telegram_id,
        payroll.payroll_id,
        JSON.stringify({
          payroll_id: payroll.payroll_id,
          has_usdt_address: Boolean(profile.usdt_details),
          has_usdt_qr: true
        }),
        nowIso,
        payroll.payroll_id,
        payroll.telegram_id,
        nowIso
      )
    ]);
    if (Number(results[3] && results[3].meta.changes) !== 1) {
      throw new Error('payroll payment details are locked');
    }
  } catch (error) {
    await env.PAYROLL_PROOFS.delete(key);
    throw error;
  }

  return env.DB.prepare(`
    SELECT *
    FROM payroll_disbursements
    WHERE payroll_id = ?
  `).bind(payroll.payroll_id).first();
}

export async function readPayrollPaymentQr(
  env,
  actor,
  payrollId
) {
  const qr = await env.DB.prepare(`
    SELECT
      q.object_key,
      q.mime_type,
      d.store_id,
      d.telegram_id
    FROM payroll_disbursements d
    JOIN payroll_payment_qr_codes q
      ON q.qr_id = d.usdt_qr_id_snapshot
     AND q.store_id = d.store_id
     AND q.telegram_id = d.telegram_id
    WHERE d.payroll_id = ?
  `).bind(payrollId).first();
  if (!qr) return new Response('not_found', { status: 404 });

  const telegramId = String(actor && actor.telegram_id || '');
  const employeeAccess = telegramId === String(qr.telegram_id);
  const adminAccess = (!actor || !actor.store_id
    || String(actor.store_id) === String(qr.store_id))
    && await isStoreAdmin(env, telegramId, qr.store_id);
  if (!employeeAccess && !adminAccess) {
    return new Response('forbidden', { status: 403 });
  }
  if (!env.PAYROLL_PROOFS) {
    return new Response('storage_not_configured', { status: 503 });
  }
  const object = await env.PAYROLL_PROOFS.get(qr.object_key);
  if (!object) return new Response('not_found', { status: 404 });

  const headers = new Headers();
  if (typeof object.writeHttpMetadata === 'function') {
    object.writeHttpMetadata(headers);
  } else {
    headers.set('content-type', qr.mime_type);
  }
  if (object.httpEtag) headers.set('etag', object.httpEtag);
  headers.set('cache-control', 'private, no-store');
  return new Response(object.body, { headers });
}
