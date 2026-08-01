import {
  formatLocalDateTime,
  localDate
} from './dates.js';
import { render, t } from './i18n.js';
import { formatMoney } from './money.js';
import {
  sendMessage,
  sendPhoto,
  sendPhotoBytes,
  telegramErrorSummary
} from './telegram-client.js';
import { validateProofImageBytes } from './payroll-proofs.js';
import { isStoreAdmin } from './stores.js';

const REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;

function maskPaymentValue(value) {
  const text = String(value || '').replace(/\s+/g, '');
  if (!text) return '';
  return `••••${text.slice(-4)}`;
}

function paymentProfileSummary(language, payroll) {
  const methods = [];
  const bank = maskPaymentValue(payroll.bank_details_snapshot);
  const usdt = maskPaymentValue(payroll.usdt_details_snapshot);
  if (Number(payroll.accepts_bank) === 1 && bank) {
    methods.push(`${t(language, 'payroll_profile_bank')} ${bank}`);
  }
  if (Number(payroll.accepts_usdt) === 1 && usdt) {
    methods.push(`${t(language, 'payroll_profile_usdt')} ${usdt}`);
  }
  if (Number(payroll.accepts_cash) === 1) {
    methods.push(t(language, 'payroll_profile_cash'));
  }
  return methods.length
    ? methods.join(' / ')
    : t(language, 'payroll_no_saved_profile');
}

function paydayMessage(payroll) {
  const language = payroll.language || 'zh';
  return render(language, 'payroll_payday_notice', {
    store: payroll.store_name,
    period_start: localDate(
      new Date(payroll.period_start),
      payroll.timezone || 'Asia/Tokyo'
    ),
    scheduled_date: payroll.scheduled_date,
    amount: formatMoney(
      { currency: payroll.currency },
      Number(payroll.amount_snapshot_micros) / 1_000_000
    ),
    profile: paymentProfileSummary(language, payroll)
  });
}

function paydayKeyboard(payroll) {
  const language = payroll.language || 'zh';
  return {
    inline_keyboard: [[{
      text: t(language, 'btn_payroll_details'),
      callback_data: `pay:d:${payroll.payroll_id}`
    }]]
  };
}

async function duePayrollNotifications(env, staleAt) {
  const rows = await env.DB.prepare(`
    SELECT
      d.*,
      s.name AS store_name,
      s.timezone,
      COALESCE(p.language, 'zh') AS language
    FROM payroll_disbursements d
    JOIN stores s ON s.store_id = d.store_id
    LEFT JOIN user_preferences p ON p.telegram_id = d.telegram_id
    WHERE d.amount_snapshot_micros > 0
      AND d.status IN (
        'awaiting_employee_details',
        'awaiting_admin_payment'
      )
      AND (
        d.employee_notified_at IS NULL
        OR (
          d.status = 'awaiting_employee_details'
          AND d.employee_notified_at IS NOT NULL
          AND COALESCE(
            d.employee_reminded_at,
            d.employee_notified_at
          ) <= ?
        )
      )
    ORDER BY d.created_at, d.payroll_id
  `).bind(staleAt).all();
  return rows.results || [];
}

async function recordNotificationSuccess(
  env,
  payroll,
  isReminder,
  sentAt,
  staleAt
) {
  if (isReminder) {
    return env.DB.prepare(`
      UPDATE payroll_disbursements
      SET employee_reminded_at = ?,
          employee_notification_error = NULL,
          updated_at = ?
      WHERE payroll_id = ?
        AND status = 'awaiting_employee_details'
        AND employee_notified_at IS NOT NULL
        AND COALESCE(
          employee_reminded_at,
          employee_notified_at
        ) <= ?
    `).bind(sentAt, sentAt, payroll.payroll_id, staleAt).run();
  }
  return env.DB.prepare(`
    UPDATE payroll_disbursements
    SET employee_notified_at = ?,
        employee_notification_error = NULL,
        updated_at = ?
    WHERE payroll_id = ?
      AND employee_notified_at IS NULL
  `).bind(sentAt, sentAt, payroll.payroll_id).run();
}

async function recordNotificationFailure(env, payroll, result, error, nowIso) {
  const summary = telegramErrorSummary(result, error);
  await env.DB.prepare(`
    UPDATE payroll_disbursements
    SET employee_notification_error = ?,
        updated_at = ?
    WHERE payroll_id = ?
      AND amount_snapshot_micros = ?
      AND cutoff_at = ?
  `).bind(
    JSON.stringify(summary),
    nowIso,
    payroll.payroll_id,
    payroll.amount_snapshot_micros,
    payroll.cutoff_at
  ).run();
}

export async function deliverPayrollNotifications(
  env,
  now = new Date()
) {
  const nowIso = now.toISOString();
  const staleAt = new Date(
    now.getTime() - REMINDER_INTERVAL_MS
  ).toISOString();
  const payrolls = await duePayrollNotifications(env, staleAt);
  const summary = {
    scanned: payrolls.length,
    sent: 0,
    failed: 0,
    reminded: 0
  };

  for (const payroll of payrolls) {
    const isReminder = !!payroll.employee_notified_at;
    let result;
    let error = null;
    try {
      result = await sendMessage(
        env,
        payroll.telegram_id,
        paydayMessage(payroll),
        paydayKeyboard(payroll)
      );
    } catch (caught) {
      error = caught;
    }
    if (!result || !result.ok) {
      summary.failed += 1;
      await recordNotificationFailure(
        env,
        payroll,
        result,
        error,
        nowIso
      );
      continue;
    }

    await recordNotificationSuccess(
      env,
      payroll,
      isReminder,
      nowIso,
      staleAt
    );
    summary.sent += 1;
    if (isReminder) summary.reminded += 1;
  }
  return summary;
}

function paymentMethodLines(language, payroll) {
  return ['bank', 'usdt', 'cash']
    .filter((method) => Number(payroll[`${method}_micros`]) > 0)
    .map((method) => `${t(language, `payroll_profile_${method}`)}：${
      formatMoney(
        { currency: payroll.currency },
        Number(payroll[`${method}_micros`]) / 1_000_000
      )
    }`);
}

function receiptPaymentMethodLines(language, payroll) {
  return ['bank', 'usdt', 'cash']
    .filter((method) =>
      Number(payroll[`${method}_micros`]) > 0
    )
    .map((method) => render(
      language,
      'payroll_payment_method_amount',
      {
        method: t(
          language,
          `payroll_profile_${method}`
        ),
        amount: formatMoney(
          { currency: payroll.currency },
          Number(
            payroll[`${method}_micros`]
          ) / 1_000_000
        )
      }
    ));
}

export function payrollReceiptMessage(payroll) {
  const language = payroll.language || 'zh';
  const timezone = payroll.timezone || 'Asia/Tokyo';
  return render(language, 'payroll_receipt_confirmed', {
    employee: payroll.employee_name
      || String(payroll.telegram_id),
    telegram_id: payroll.telegram_id,
    store: payroll.store_name,
    period_start: formatLocalDateTime(
      payroll.period_start,
      timezone
    ),
    period_end: formatLocalDateTime(
      payroll.cutoff_at,
      timezone
    ),
    amount: formatMoney(
      { currency: payroll.currency },
      Number(
        payroll.amount_snapshot_micros
      ) / 1_000_000
    ),
    payment_methods: receiptPaymentMethodLines(
      language,
      payroll
    ).join('\n'),
    confirmed_at: formatLocalDateTime(
      payroll.confirmed_at,
      timezone
    ),
    payroll_id: payroll.payroll_id
  });
}

export async function sendPayrollForEmployeeConfirmation(
  env,
  adminId,
  payrollId,
  now = new Date()
) {
  const payroll = await env.DB.prepare(`
    SELECT
      d.*,
      s.name AS store_name,
      COALESCE(p.language, 'zh') AS language
    FROM payroll_disbursements d
    JOIN stores s ON s.store_id = d.store_id
    LEFT JOIN user_preferences p
      ON p.telegram_id = d.telegram_id
    WHERE d.payroll_id = ?
  `).bind(payrollId).first();
  if (!payroll
    || !(await isStoreAdmin(env, adminId, payroll.store_id))) {
    throw new Error('payroll confirmation permission denied');
  }
  if (payroll.status !== 'awaiting_employee_confirmation') {
    throw new Error('payroll is not awaiting employee confirmation');
  }
  if (payroll.payment_sent_at) return payroll;

  const proofRows = await env.DB.prepare(`
    SELECT method, telegram_file_id, sort_order
    FROM payroll_payment_proofs
    WHERE payroll_id = ?
      AND superseded_at IS NULL
    ORDER BY method, sort_order
  `).bind(payroll.payroll_id).all();
  const language = payroll.language || 'zh';
  for (const proof of proofRows.results || []) {
    const result = await sendPhoto(
      env,
      payroll.telegram_id,
      proof.telegram_file_id,
      render(language, 'payroll_proof_caption', {
        method: t(language, `payroll_profile_${proof.method}`),
        number: proof.sort_order
      })
    );
    if (!result || !result.ok) {
      throw new Error('payroll proof delivery failed');
    }
  }

  const result = await sendMessage(
    env,
    payroll.telegram_id,
    [
      render(language, 'payroll_payment_summary', {
        store: payroll.store_name,
        amount: formatMoney(
          { currency: payroll.currency },
          Number(payroll.amount_snapshot_micros) / 1_000_000
        )
      }),
      ...paymentMethodLines(language, payroll)
    ].join('\n'),
    {
      inline_keyboard: [[
        {
          text: t(language, 'btn_confirm_receipt'),
          callback_data: `pay:ok:${payroll.payroll_id}`
        },
        {
          text: t(language, 'btn_dispute_payment'),
          callback_data: `pay:x:${payroll.payroll_id}`
        }
      ]]
    }
  );
  if (!result || !result.ok) {
    throw new Error('payroll confirmation delivery failed');
  }

  const sentAt = now.toISOString();
  const updated = await env.DB.prepare(`
    UPDATE payroll_disbursements
    SET payment_sent_at = ?,
        updated_at = ?
    WHERE payroll_id = ?
      AND status = 'awaiting_employee_confirmation'
      AND payment_sent_at IS NULL
  `).bind(
    sentAt,
    sentAt,
    payroll.payroll_id
  ).run();
  if (Number(updated.meta.changes) !== 1) {
    throw new Error('payroll confirmation delivery conflict');
  }
  return env.DB.prepare(`
    SELECT * FROM payroll_disbursements
    WHERE payroll_id = ?
  `).bind(payroll.payroll_id).first();
}

const PAYMENT_DELIVERY_LEASE_MS = 15 * 60 * 1000;
const PAYMENT_DELIVERY_RENEW_WINDOW_MS = 5 * 60 * 1000;
const MAX_DELIVERY_PROOF_BYTES = 10 * 1024 * 1024;
const DELIVERY_ACTION_SQL = `(
  'payroll_notification_delivery_claimed',
  'payroll_notification_delivery_renewed',
  'payroll_notification_failed',
  'payroll_notification_sent'
)`;

function paymentDeliveryError(code, proofId = null) {
  const error = new Error('payroll notification failed');
  error.notification_code = code;
  if (proofId) error.proof_id = String(proofId);
  return error;
}

function deliveryLeaseLost() {
  const error = new Error('payment notification delivery lease lost');
  error.delivery_lease_lost = true;
  return error;
}

function deliveryClock(now) {
  if (typeof now === 'function') return () => new Date(now());
  if (now !== undefined) return () => new Date(now);
  return () => new Date();
}

function deliveryLeaseExpiry(now) {
  return new Date(now.getTime() + PAYMENT_DELIVERY_LEASE_MS).toISOString();
}

async function deliveryLeaseTokenHash(token) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token)
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function activeDeliveryLeaseSql() {
  return `EXISTS (
    SELECT 1 FROM admin_audit_logs lease
    WHERE lease.id = (
      SELECT state.id FROM admin_audit_logs state
      WHERE state.store_id = ? AND state.target_id = ?
        AND json_extract(state.details_json, '$.attempt_id') = ?
        AND state.action IN ${DELIVERY_ACTION_SQL}
      ORDER BY state.id DESC
      LIMIT 1
    )
      AND lease.action IN (
        'payroll_notification_delivery_claimed',
        'payroll_notification_delivery_renewed'
      )
      AND json_extract(lease.details_json, '$.lease_token_hash') = ?
      AND json_extract(lease.details_json, '$.expires_at') > ?
  )`;
}

function activeDeliveryLeaseBinds(payroll, lease, checkedAt) {
  return [
    payroll.store_id,
    payroll.payroll_id,
    payroll.attempt_id,
    lease.token_hash,
    checkedAt.toISOString()
  ];
}

async function paymentAttemptForDelivery(env, adminId, attemptId) {
  const payroll = await env.DB.prepare(`
    SELECT
      a.*,
      d.store_id, d.telegram_id, d.period_start, d.cutoff_at,
      d.amount_snapshot_micros, d.currency,
      d.payment_sent_at, d.current_payment_attempt_id,
      d.status AS payroll_status,
      s.name AS store_name, s.timezone,
      COALESCE(p.language, 'zh') AS language,
      m.display_name AS employee_name
    FROM payroll_payment_attempts a
    JOIN payroll_disbursements d ON d.payroll_id = a.payroll_id
    JOIN stores s ON s.store_id = d.store_id
    LEFT JOIN user_preferences p ON p.telegram_id = d.telegram_id
    LEFT JOIN store_members m
      ON m.store_id = d.store_id AND m.telegram_id = d.telegram_id
    WHERE a.attempt_id = ?
  `).bind(attemptId).first();
  if (!payroll) throw new Error('payment attempt not found');
  if (!await isStoreAdmin(env, adminId, payroll.store_id)) {
    throw new Error('payroll admin permission denied');
  }
  if (String(payroll.current_payment_attempt_id || '') !== String(attemptId)) {
    throw new Error('payment attempt conflict');
  }
  if (payroll.status !== 'submitted') {
    throw new Error('payment attempt conflict');
  }
  return payroll;
}

async function claimPaymentDelivery(env, adminId, payroll, now) {
  const claimedAt = now.toISOString();
  const staleBefore = new Date(
    now.getTime() - PAYMENT_DELIVERY_LEASE_MS
  ).toISOString();
  const token = crypto.randomUUID();
  const tokenHash = await deliveryLeaseTokenHash(token);
  const expiresAt = deliveryLeaseExpiry(now);
  const result = await env.DB.prepare(`
    INSERT INTO admin_audit_logs (
      store_id, admin_id, action, target_id, details_json, created_at
    )
    SELECT ?, ?, 'payroll_notification_delivery_claimed', ?,
      json_object(
        'attempt_id', ?, 'version', ?,
        'lease_token_hash', ?, 'expires_at', ?
      ), ?
    WHERE EXISTS (
      SELECT 1
      FROM payroll_payment_attempts a
      JOIN payroll_disbursements d ON d.payroll_id = a.payroll_id
      WHERE a.attempt_id = ? AND a.status = 'submitted'
        AND d.current_payment_attempt_id = a.attempt_id
        AND d.status = 'awaiting_employee_confirmation'
        AND d.payment_sent_at IS NULL
    )
      AND COALESCE((
        SELECT CASE
          WHEN action IN (
            'payroll_notification_delivery_claimed',
            'payroll_notification_delivery_renewed'
          )
            AND (
              (
                json_extract(details_json, '$.expires_at') IS NOT NULL
                AND json_extract(details_json, '$.expires_at') <= ?
              )
              OR (
                json_extract(details_json, '$.expires_at') IS NULL
                AND created_at <= ?
              )
            ) THEN 1
          WHEN action = 'payroll_notification_failed' THEN 1
          WHEN action = 'payroll_notification_sent' THEN 0
          ELSE 0
        END
        FROM admin_audit_logs
        WHERE store_id = ? AND target_id = ?
          AND json_extract(details_json, '$.attempt_id') = ?
          AND action IN ${DELIVERY_ACTION_SQL}
        ORDER BY id DESC
        LIMIT 1
      ), 1) = 1
  `).bind(
    payroll.store_id,
    String(adminId),
    payroll.payroll_id,
    payroll.attempt_id,
    Number(payroll.version),
    tokenHash,
    expiresAt,
    claimedAt,
    payroll.attempt_id,
    claimedAt,
    staleBefore,
    payroll.store_id,
    payroll.payroll_id,
    payroll.attempt_id
  ).run();
  return Number(result && result.meta && result.meta.changes) === 1
    ? { token_hash: tokenHash, expires_at: expiresAt }
    : null;
}

async function requirePaymentDeliveryLease(env, payroll, lease, now) {
  const guard = activeDeliveryLeaseSql();
  const active = await env.DB.prepare(`
    SELECT 1 AS active
    WHERE ${guard}
      AND EXISTS (
        SELECT 1 FROM payroll_payment_attempts a
        JOIN payroll_disbursements d ON d.payroll_id = a.payroll_id
        WHERE a.attempt_id = ? AND a.status = 'submitted'
          AND d.current_payment_attempt_id = a.attempt_id
          AND d.status = 'awaiting_employee_confirmation'
          AND d.payment_sent_at IS NULL
      )
  `).bind(
    ...activeDeliveryLeaseBinds(payroll, lease, now),
    payroll.attempt_id
  ).first();
  if (!active) throw deliveryLeaseLost();
}

async function renewPaymentDelivery(env, adminId, payroll, lease, now) {
  await requirePaymentDeliveryLease(env, payroll, lease, now);
  const remaining = new Date(lease.expires_at).getTime() - now.getTime();
  if (remaining > PAYMENT_DELIVERY_RENEW_WINDOW_MS) return;
  const expiresAt = deliveryLeaseExpiry(now);
  const guard = activeDeliveryLeaseSql();
  const result = await env.DB.prepare(`
    INSERT INTO admin_audit_logs (
      store_id, admin_id, action, target_id, details_json, created_at
    )
    SELECT ?, ?, 'payroll_notification_delivery_renewed', ?,
      json_object(
        'attempt_id', ?, 'version', ?,
        'lease_token_hash', ?, 'expires_at', ?
      ), ?
    WHERE ${guard}
      AND EXISTS (
        SELECT 1 FROM payroll_payment_attempts a
        JOIN payroll_disbursements d ON d.payroll_id = a.payroll_id
        WHERE a.attempt_id = ? AND a.status = 'submitted'
          AND d.current_payment_attempt_id = a.attempt_id
          AND d.status = 'awaiting_employee_confirmation'
          AND d.payment_sent_at IS NULL
      )
  `).bind(
    payroll.store_id,
    String(adminId),
    payroll.payroll_id,
    payroll.attempt_id,
    Number(payroll.version),
    lease.token_hash,
    expiresAt,
    now.toISOString(),
    ...activeDeliveryLeaseBinds(payroll, lease, now),
    payroll.attempt_id
  ).run();
  if (Number(result && result.meta && result.meta.changes) !== 1) {
    throw deliveryLeaseLost();
  }
  lease.expires_at = expiresAt;
}

async function proofBytes(env, proof) {
  const expectedSize = Number(proof.size_bytes);
  const mimeType = String(proof.mime_type || '').toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
    throw paymentDeliveryError('proof_metadata_invalid', proof.proof_id);
  }
  if (!Number.isSafeInteger(expectedSize)
    || expectedSize <= 0
    || expectedSize > MAX_DELIVERY_PROOF_BYTES) {
    throw paymentDeliveryError('proof_metadata_invalid', proof.proof_id);
  }
  if (!env.PAYROLL_PROOFS || typeof env.PAYROLL_PROOFS.get !== 'function') {
    throw paymentDeliveryError('storage_not_configured', proof.proof_id);
  }
  let object;
  try {
    object = await env.PAYROLL_PROOFS.get(proof.object_key);
  } catch {
    throw paymentDeliveryError('proof_storage_unavailable', proof.proof_id);
  }
  if (!object) throw paymentDeliveryError('proof_missing', proof.proof_id);
  const reportedSize = object.size;
  if (reportedSize !== undefined && reportedSize !== null
    && (!Number.isSafeInteger(Number(reportedSize))
      || Number(reportedSize) !== expectedSize
      || Number(reportedSize) > MAX_DELIVERY_PROOF_BYTES)) {
    throw paymentDeliveryError('proof_size_mismatch', proof.proof_id);
  }
  let bytes;
  try {
    if (object.body && typeof object.body.getReader === 'function') {
      const reader = object.body.getReader();
      const chunks = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!(value instanceof Uint8Array)) {
            throw paymentDeliveryError('proof_unreadable', proof.proof_id);
          }
          if (total + value.byteLength > expectedSize) {
            try {
              await reader.cancel('payroll proof size mismatch');
            } catch {
              // The guarded size failure remains authoritative.
            }
            throw paymentDeliveryError('proof_size_mismatch', proof.proof_id);
          }
          chunks.push(value);
          total += value.byteLength;
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // A cancelled stream may already have released its reader.
        }
      }
      bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
    } else if (object.body instanceof Uint8Array) {
      bytes = object.body;
    } else if (object.body instanceof ArrayBuffer) {
      bytes = new Uint8Array(object.body);
    } else if (typeof object.arrayBuffer === 'function'
      && Number.isSafeInteger(Number(reportedSize))
      && Number(reportedSize) <= MAX_DELIVERY_PROOF_BYTES) {
      bytes = new Uint8Array(await object.arrayBuffer());
    } else {
      throw paymentDeliveryError('proof_unreadable', proof.proof_id);
    }
  } catch (error) {
    if (error && error.notification_code) throw error;
    throw paymentDeliveryError('proof_unreadable', proof.proof_id);
  }
  if (bytes.byteLength !== expectedSize) {
    throw paymentDeliveryError('proof_size_mismatch', proof.proof_id);
  }
  try {
    validateProofImageBytes(bytes, mimeType);
  } catch {
    throw paymentDeliveryError('proof_bytes_invalid', proof.proof_id);
  }
  return bytes;
}

function largestTelegramPhotoFileId(result) {
  const photos = result && result.result && Array.isArray(result.result.photo)
    ? result.result.photo
    : [];
  let largest = null;
  let score = -1;
  for (const photo of photos) {
    if (!photo || !photo.file_id) continue;
    const nextScore = Number(photo.file_size)
      || (Number(photo.width) * Number(photo.height))
      || 0;
    if (nextScore >= score) {
      largest = String(photo.file_id);
      score = nextScore;
    }
  }
  if (!largest) throw paymentDeliveryError('telegram_photo_id_missing');
  return largest;
}

function traceablePaymentMessage(payroll) {
  const language = payroll.language || 'zh';
  const timezone = payroll.timezone || 'Asia/Tokyo';
  const traceLabels = {
    zh: ['工资周期', '付款版本', '工资 ID'],
    en: ['Payroll period', 'Payment version', 'Payroll ID'],
    vi: ['Kỳ lương', 'Phiên bản thanh toán', 'Mã lương'],
    ru: ['Расчетный период', 'Версия платежа', 'ID зарплаты']
  }[language] || ['Payroll period', 'Payment version', 'Payroll ID'];
  return [
    render(language, 'payroll_payment_summary', {
      store: payroll.store_name,
      amount: formatMoney(
        { currency: payroll.currency },
        Number(payroll.amount_snapshot_micros) / 1_000_000
      )
    }),
    `${traceLabels[0]}：${formatLocalDateTime(
      payroll.period_start,
      timezone
    )} - ${formatLocalDateTime(payroll.cutoff_at, timezone)}`,
    `${traceLabels[1]}：${payroll.version}`,
    `${traceLabels[2]}：${payroll.payroll_id}`,
    ...paymentMethodLines(language, payroll)
  ].join('\n');
}

async function recordPaymentDeliveryFailure(
  env,
  adminId,
  payroll,
  lease,
  code,
  proofId,
  now
) {
  const safeCode = String(code || 'delivery_failed').slice(0, 80);
  const safeProofId = proofId ? String(proofId).slice(0, 100) : null;
  const nowIso = now.toISOString();
  const safeError = JSON.stringify({
    code: safeCode,
    proof_id: safeProofId
  });
  const guard = activeDeliveryLeaseSql();
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE payroll_disbursements
      SET employee_notification_error = ?, updated_at = ?
      WHERE payroll_id = ? AND current_payment_attempt_id = ?
        AND status = 'awaiting_employee_confirmation'
        AND payment_sent_at IS NULL
        AND ${guard}
    `).bind(
      safeError,
      nowIso,
      payroll.payroll_id,
      payroll.attempt_id,
      ...activeDeliveryLeaseBinds(payroll, lease, now)
    ),
    env.DB.prepare(`
      INSERT INTO admin_audit_logs (
        store_id, admin_id, action, target_id, details_json, created_at
      )
      SELECT ?, ?, 'payroll_notification_failed', ?,
        json_object(
          'attempt_id', ?, 'version', ?,
          'lease_token_hash', ?, 'code', ?, 'proof_id', ?
        ), ?
      WHERE ${guard}
        AND EXISTS (
          SELECT 1
          FROM payroll_disbursements d
          JOIN payroll_payment_attempts a
            ON a.attempt_id = d.current_payment_attempt_id
           AND a.payroll_id = d.payroll_id
          WHERE d.payroll_id = ? AND d.store_id = ?
            AND d.current_payment_attempt_id = ?
            AND d.status = 'awaiting_employee_confirmation'
            AND d.payment_sent_at IS NULL
            AND d.employee_notification_error = ?
            AND d.updated_at = ?
            AND a.status = 'submitted'
        )
        AND NOT EXISTS (
          SELECT 1 FROM admin_audit_logs existing
          WHERE existing.store_id = ? AND existing.target_id = ?
            AND existing.action = 'payroll_notification_failed'
            AND json_extract(existing.details_json, '$.attempt_id') = ?
            AND json_extract(existing.details_json, '$.lease_token_hash') = ?
        )
    `).bind(
      payroll.store_id,
      String(adminId),
      payroll.payroll_id,
      payroll.attempt_id,
      Number(payroll.version),
      lease.token_hash,
      safeCode,
      safeProofId,
      nowIso,
      ...activeDeliveryLeaseBinds(payroll, lease, now),
      payroll.payroll_id,
      payroll.store_id,
      payroll.attempt_id,
      safeError,
      nowIso,
      payroll.store_id,
      payroll.payroll_id,
      payroll.attempt_id,
      lease.token_hash
    )
  ]);
  return Number(results[0] && results[0].meta.changes) === 1
    && Number(results[1] && results[1].meta.changes) === 1;
}

export async function paymentAttemptDeliveryResult(env, adminId, attemptId) {
  const context = await env.DB.prepare(`
    SELECT
      a.attempt_id, a.payroll_id, a.status,
      d.store_id, d.current_payment_attempt_id, d.payment_sent_at
    FROM payroll_payment_attempts a
    JOIN payroll_disbursements d ON d.payroll_id = a.payroll_id
    WHERE a.attempt_id = ?
  `).bind(attemptId).first();
  if (!context) throw new Error('payment attempt not found');
  if (!await isStoreAdmin(env, adminId, context.store_id)) {
    throw new Error('payroll admin permission denied');
  }
  const current = String(context.current_payment_attempt_id || '')
    === String(context.attempt_id);
  if (current && context.payment_sent_at) {
    return { current: true, status: 'sent', retryable: false };
  }
  const state = await env.DB.prepare(`
    SELECT action
    FROM admin_audit_logs
    WHERE store_id = ? AND target_id = ?
      AND json_extract(details_json, '$.attempt_id') = ?
      AND action IN (
        'payroll_notification_failed',
        'payroll_notification_sent'
      )
    ORDER BY id DESC
    LIMIT 1
  `).bind(
    context.store_id,
    context.payroll_id,
    context.attempt_id
  ).first();
  const status = state && state.action === 'payroll_notification_sent'
    ? 'sent'
    : state && state.action === 'payroll_notification_failed'
      ? 'failed'
      : 'not_recorded';
  return { current, status, retryable: current && status === 'failed' };
}

export async function deliverPaymentAttempt(
  env,
  adminId,
  attemptId,
  now
) {
  const clock = deliveryClock(now);
  const payroll = await paymentAttemptForDelivery(
    env,
    adminId,
    attemptId
  );
  if (payroll.payment_sent_at) {
    return { status: 'sent', attempt_id: payroll.attempt_id };
  }
  const lease = await claimPaymentDelivery(
    env,
    adminId,
    payroll,
    clock()
  );
  if (!lease) {
    const current = await env.DB.prepare(`
      SELECT payment_sent_at FROM payroll_disbursements
      WHERE payroll_id = ? AND current_payment_attempt_id = ?
    `).bind(payroll.payroll_id, payroll.attempt_id).first();
    if (current && current.payment_sent_at) {
      return { status: 'sent', attempt_id: payroll.attempt_id };
    }
    throw new Error('payment notification delivery in progress');
  }

  try {
    const proofRows = await env.DB.prepare(`
      SELECT * FROM payroll_payment_proofs
      WHERE attempt_id = ? AND superseded_at IS NULL
        AND telegram_delivered_at IS NULL
      ORDER BY method, sort_order, proof_id
    `).bind(payroll.attempt_id).all();
    const language = payroll.language || 'zh';
    for (const proof of proofRows.results || []) {
      const caption = render(language, 'payroll_proof_caption', {
        method: t(language, `payroll_profile_${proof.method}`),
        number: proof.sort_order
      });
      let result;
      let fileId = proof.telegram_file_id
        ? String(proof.telegram_file_id)
        : null;
      if (fileId) {
        await renewPaymentDelivery(
          env,
          adminId,
          payroll,
          lease,
          clock()
        );
        result = await sendPhoto(
          env,
          payroll.telegram_id,
          fileId,
          caption
        );
        await requirePaymentDeliveryLease(
          env,
          payroll,
          lease,
          clock()
        );
      } else {
        await renewPaymentDelivery(
          env,
          adminId,
          payroll,
          lease,
          clock()
        );
        const bytes = await proofBytes(env, proof);
        await renewPaymentDelivery(
          env,
          adminId,
          payroll,
          lease,
          clock()
        );
        result = await sendPhotoBytes(
          env,
          payroll.telegram_id,
          bytes,
          proof.file_name || `${proof.proof_id}`,
          proof.mime_type,
          caption
        );
        await requirePaymentDeliveryLease(
          env,
          payroll,
          lease,
          clock()
        );
        if (result && result.ok) {
          try {
            fileId = largestTelegramPhotoFileId(result);
          } catch (error) {
            error.proof_id = String(proof.proof_id);
            throw error;
          }
        }
      }
      if (!result || !result.ok) {
        const summary = telegramErrorSummary(result);
        throw paymentDeliveryError(
          summary.description === 'staging_recipient_blocked'
            ? 'staging_recipient_blocked'
            : 'proof_telegram_failed',
          proof.proof_id
        );
      }
      const checkpointAt = clock();
      const guard = activeDeliveryLeaseSql();
      const checkpoint = await env.DB.prepare(`
        UPDATE payroll_payment_proofs
        SET telegram_file_id = ?, telegram_delivered_at = ?
        WHERE proof_id = ? AND attempt_id = ?
          AND telegram_delivered_at IS NULL
          AND EXISTS (
            SELECT 1 FROM payroll_disbursements d
            JOIN payroll_payment_attempts a
              ON a.attempt_id = d.current_payment_attempt_id
             AND a.payroll_id = d.payroll_id
            WHERE a.attempt_id = ? AND a.status = 'submitted'
              AND d.status = 'awaiting_employee_confirmation'
              AND d.payment_sent_at IS NULL
          )
          AND ${guard}
      `).bind(
        fileId,
        checkpointAt.toISOString(),
        proof.proof_id,
        payroll.attempt_id,
        payroll.attempt_id,
        ...activeDeliveryLeaseBinds(payroll, lease, checkpointAt)
      ).run();
      if (Number(checkpoint && checkpoint.meta && checkpoint.meta.changes) !== 1) {
        throw deliveryLeaseLost();
      }
    }

    await renewPaymentDelivery(
      env,
      adminId,
      payroll,
      lease,
      clock()
    );
    const result = await sendMessage(
      env,
      payroll.telegram_id,
      traceablePaymentMessage(payroll),
      {
        inline_keyboard: [[
          {
            text: t(language, 'btn_confirm_receipt'),
            callback_data: `pay:ok:${payroll.payroll_id}`
          },
          {
            text: t(language, 'btn_dispute_payment'),
            callback_data: `pay:x:${payroll.payroll_id}`
          }
        ]]
      }
    );
    await requirePaymentDeliveryLease(
      env,
      payroll,
      lease,
      clock()
    );
    if (!result || !result.ok) {
      const summary = telegramErrorSummary(result);
      throw paymentDeliveryError(
        summary.description === 'staging_recipient_blocked'
          ? 'staging_recipient_blocked'
          : 'summary_telegram_failed'
      );
    }

    const sentAt = clock();
    const sentAtIso = sentAt.toISOString();
    const guard = activeDeliveryLeaseSql();
    const results = await env.DB.batch([
      env.DB.prepare(`
        UPDATE payroll_disbursements
        SET payment_sent_at = ?, employee_notification_error = NULL,
            updated_at = ?
        WHERE payroll_id = ? AND current_payment_attempt_id = ?
          AND status = 'awaiting_employee_confirmation'
          AND payment_sent_at IS NULL
          AND EXISTS (
            SELECT 1 FROM payroll_payment_attempts
            WHERE attempt_id = ? AND status = 'submitted'
          )
          AND NOT EXISTS (
            SELECT 1 FROM payroll_payment_proofs
            WHERE attempt_id = ? AND superseded_at IS NULL
              AND telegram_delivered_at IS NULL
          )
          AND ${guard}
      `).bind(
        sentAtIso,
        sentAtIso,
        payroll.payroll_id,
        payroll.attempt_id,
        payroll.attempt_id,
        payroll.attempt_id,
        ...activeDeliveryLeaseBinds(payroll, lease, sentAt)
      ),
      env.DB.prepare(`
        INSERT INTO admin_audit_logs (
          store_id, admin_id, action, target_id, details_json, created_at
        )
        SELECT ?, ?, 'payroll_notification_sent', ?,
          json_object(
            'attempt_id', ?, 'version', ?, 'lease_token_hash', ?
          ), ?
        WHERE ${guard}
          AND EXISTS (
            SELECT 1 FROM payroll_disbursements
            WHERE payroll_id = ? AND current_payment_attempt_id = ?
              AND payment_sent_at = ?
          )
      `).bind(
        payroll.store_id,
        String(adminId),
        payroll.payroll_id,
        payroll.attempt_id,
        Number(payroll.version),
        lease.token_hash,
        sentAtIso,
        ...activeDeliveryLeaseBinds(payroll, lease, sentAt),
        payroll.payroll_id,
        payroll.attempt_id,
        sentAtIso
      )
    ]);
    if (Number(results[0] && results[0].meta.changes) !== 1
      || Number(results[1] && results[1].meta.changes) !== 1) {
      throw deliveryLeaseLost();
    }
    return { status: 'sent', attempt_id: payroll.attempt_id };
  } catch (error) {
    if (error && error.delivery_lease_lost) throw error;
    const code = error && error.notification_code
      ? error.notification_code
      : 'delivery_failed';
    const failedAt = clock();
    const recorded = await recordPaymentDeliveryFailure(
      env,
      adminId,
      payroll,
      lease,
      code,
      error && error.proof_id ? error.proof_id : null,
      failedAt
    );
    if (!recorded) throw deliveryLeaseLost();
    if (error && error.message === 'payroll notification failed') throw error;
    throw paymentDeliveryError(code);
  }
}
