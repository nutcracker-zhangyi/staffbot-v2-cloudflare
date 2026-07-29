import { t } from './i18n.js';

function paymentBoolean(value, field) {
  if (value === true || value === 1) return 1;
  if (value === false || value === 0 || value === undefined) return 0;
  throw new TypeError(`${field} must be a boolean`);
}

export function maskPaymentValue(value) {
  const text = String(value || '').replace(/\s+/g, '');
  return text ? `••••${text.slice(-4)}` : '';
}

export function validatePaymentProfile(input) {
  const acceptsBank = paymentBoolean(
    input && input.accepts_bank,
    'accepts_bank'
  );
  const acceptsUsdt = paymentBoolean(
    input && input.accepts_usdt,
    'accepts_usdt'
  );
  const acceptsCash = paymentBoolean(
    input && input.accepts_cash,
    'accepts_cash'
  );
  if (!acceptsBank && !acceptsUsdt && !acceptsCash) {
    throw new TypeError('at least one payment method is required');
  }

  const bankDetails = String(
    input && input.bank_details || ''
  ).trim();
  const usdtDetails = String(
    input && input.usdt_details || ''
  ).trim();
  if (acceptsBank && !bankDetails) {
    throw new TypeError('bank details are required');
  }
  if (acceptsUsdt && !usdtDetails) {
    throw new TypeError('USDT details are required');
  }
  return {
    accepts_bank: acceptsBank,
    accepts_usdt: acceptsUsdt,
    accepts_cash: acceptsCash,
    bank_details: acceptsBank ? bankDetails : null,
    usdt_details: acceptsUsdt ? usdtDetails : null
  };
}

export async function getPayrollPaymentContext(
  env,
  actorId,
  payrollId
) {
  const row = await env.DB.prepare(`
    SELECT
      d.*,
      COALESCE(s.name, d.store_id) AS store_name,
      COALESCE(p.accepts_bank, d.accepts_bank) AS profile_accepts_bank,
      COALESCE(p.accepts_usdt, d.accepts_usdt) AS profile_accepts_usdt,
      COALESCE(p.accepts_cash, d.accepts_cash) AS profile_accepts_cash,
      COALESCE(p.bank_details, d.bank_details_snapshot) AS profile_bank_details,
      COALESCE(p.usdt_details, d.usdt_details_snapshot) AS profile_usdt_details
    FROM payroll_disbursements d
    LEFT JOIN stores s ON s.store_id = d.store_id
    LEFT JOIN payroll_payment_profiles p
      ON p.store_id = d.store_id
     AND p.telegram_id = d.telegram_id
    WHERE d.payroll_id = ?
  `).bind(payrollId).first();
  if (!row) throw new Error('payroll not found');
  if (String(row.telegram_id) !== String(actorId)) {
    throw new Error('payroll identity mismatch');
  }
  return row;
}

export async function savePaymentProfile(
  env,
  actorId,
  payrollId,
  input,
  now = new Date()
) {
  const profile = validatePaymentProfile(input);
  const payroll = await getPayrollPaymentContext(
    env,
    actorId,
    payrollId
  );
  const nowIso = now.toISOString();
  const auditDetails = JSON.stringify({
    payroll_id: payroll.payroll_id,
    accepts_bank: profile.accepts_bank,
    accepts_usdt: profile.accepts_usdt,
    accepts_cash: profile.accepts_cash,
    bank: maskPaymentValue(profile.bank_details),
    usdt: maskPaymentValue(profile.usdt_details)
  });

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO payroll_payment_profiles (
        store_id, telegram_id,
        accepts_bank, accepts_usdt, accepts_cash,
        bank_details, usdt_details,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(store_id, telegram_id) DO UPDATE SET
        accepts_bank = excluded.accepts_bank,
        accepts_usdt = excluded.accepts_usdt,
        accepts_cash = excluded.accepts_cash,
        bank_details = excluded.bank_details,
        usdt_details = excluded.usdt_details,
        updated_at = excluded.updated_at
    `).bind(
      payroll.store_id,
      payroll.telegram_id,
      profile.accepts_bank,
      profile.accepts_usdt,
      profile.accepts_cash,
      profile.bank_details,
      profile.usdt_details,
      nowIso,
      nowIso
    ),
    env.DB.prepare(`
      UPDATE payroll_disbursements
      SET accepts_bank = ?,
          accepts_usdt = ?,
          accepts_cash = ?,
          bank_details_snapshot = ?,
          usdt_details_snapshot = ?,
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
    `).bind(
      profile.accepts_bank,
      profile.accepts_usdt,
      profile.accepts_cash,
      profile.bank_details,
      profile.usdt_details,
      nowIso,
      payroll.payroll_id,
      payroll.telegram_id
    ),
    env.DB.prepare(`
      INSERT INTO admin_audit_logs (
        store_id, admin_id, action, target_id,
        details_json, created_at
      ) VALUES (?, ?, 'save_payroll_payment_profile', ?, ?, ?)
    `).bind(
      payroll.store_id,
      payroll.telegram_id,
      payroll.payroll_id,
      auditDetails,
      nowIso
    )
  ]);

  return env.DB.prepare(`
    SELECT * FROM payroll_disbursements
    WHERE payroll_id = ?
  `).bind(payroll.payroll_id).first();
}

export function paymentMethodKeyboard(payrollId, profile, language) {
  const methodButton = (key, label, selected) => ({
    text: `${selected ? '☑' : '☐'} ${t(language, label)}`,
    callback_data: `pay:m:${key}:${payrollId}`
  });
  return {
    inline_keyboard: [
      [methodButton(
        'b',
        'payroll_profile_bank',
        Number(profile && profile.accepts_bank) === 1
      )],
      [methodButton(
        'u',
        'payroll_profile_usdt',
        Number(profile && profile.accepts_usdt) === 1
      )],
      [methodButton(
        'c',
        'payroll_profile_cash',
        Number(profile && profile.accepts_cash) === 1
      )],
      [{
        text: t(language, 'btn_confirm'),
        callback_data: `pay:c:${payrollId}`
      }]
    ]
  };
}
