import { localDate } from './dates.js';
import { render, t } from './i18n.js';
import { formatMoney } from './money.js';
import {
  sendMessage,
  telegramErrorSummary
} from './telegram-client.js';

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
