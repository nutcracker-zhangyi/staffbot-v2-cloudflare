import { localDate } from './dates.js';
import { render, t } from './i18n.js';
import { formatMoney } from './money.js';
import {
  sendMessage,
  sendPhoto,
  telegramErrorSummary
} from './telegram-client.js';
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
