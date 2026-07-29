import { t } from './i18n.js';
import { isStoreAdmin } from './stores.js';

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
  const usdtQrId = String(
    input && input.usdt_qr_id || ''
  ).trim();
  if (acceptsBank && !bankDetails) {
    throw new TypeError('bank details are required');
  }
  if (acceptsUsdt && !usdtDetails && !usdtQrId) {
    throw new TypeError('USDT address or QR is required');
  }
  return {
    accepts_bank: acceptsBank,
    accepts_usdt: acceptsUsdt,
    accepts_cash: acceptsCash,
    bank_details: acceptsBank ? bankDetails : null,
    usdt_details: acceptsUsdt && usdtDetails ? usdtDetails : null,
    usdt_qr_id: acceptsUsdt && usdtQrId ? usdtQrId : null
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
      COALESCE(p.usdt_details, d.usdt_details_snapshot) AS profile_usdt_details,
      COALESCE(p.usdt_qr_id, d.usdt_qr_id_snapshot) AS profile_usdt_qr_id
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
  if (![
    'awaiting_employee_details',
    'awaiting_admin_payment'
  ].includes(payroll.status) || payroll.current_admin_id !== null) {
    throw new Error('payroll payment details are locked');
  }
  if (profile.usdt_qr_id) {
    const qr = await env.DB.prepare(`
      SELECT qr_id
      FROM payroll_payment_qr_codes
      WHERE qr_id = ?
        AND store_id = ?
        AND telegram_id = ?
        AND superseded_at IS NULL
    `).bind(
      profile.usdt_qr_id,
      payroll.store_id,
      payroll.telegram_id
    ).first();
    if (!qr) throw new Error('USDT QR is not active');
  }
  const nowIso = now.toISOString();
  const auditDetails = JSON.stringify({
    payroll_id: payroll.payroll_id,
    accepts_bank: profile.accepts_bank,
    accepts_usdt: profile.accepts_usdt,
    accepts_cash: profile.accepts_cash,
    bank: maskPaymentValue(profile.bank_details),
    usdt: maskPaymentValue(profile.usdt_details)
  });

  const statements = [];
  if (!profile.usdt_qr_id) {
    statements.push(env.DB.prepare(`
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
    ));
  }
  statements.push(
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
      SELECT ?, ?, 'save_payroll_payment_profile', ?, ?, ?
      FROM payroll_disbursements
      WHERE payroll_id = ?
        AND telegram_id = ?
        AND updated_at = ?
    `).bind(
      payroll.store_id,
      payroll.telegram_id,
      payroll.payroll_id,
      auditDetails,
      nowIso,
      payroll.payroll_id,
      payroll.telegram_id,
      nowIso
    )
  );
  const results = await env.DB.batch(statements);
  const updateResult = results[statements.length - 2];
  if (Number(updateResult && updateResult.meta.changes) !== 1) {
    throw new Error('payroll payment details are locked');
  }

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

export function usdtDetailModeKeyboard(payrollId, language) {
  return {
    inline_keyboard: [
      [{
        text: t(language, 'btn_usdt_address'),
        callback_data: `pay:um:a:${payrollId}`
      }],
      [{
        text: t(language, 'btn_usdt_qr'),
        callback_data: `pay:um:q:${payrollId}`
      }],
      [{
        text: t(language, 'btn_usdt_both'),
        callback_data: `pay:um:b:${payrollId}`
      }]
    ]
  };
}

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
  const total = split.bank_micros
    + split.usdt_micros
    + split.cash_micros;
  if (!Number.isSafeInteger(total)
    || total !== Number(payroll.amount_snapshot_micros)) {
    throw new RangeError('payment split must equal payroll snapshot');
  }
  for (const method of ['bank', 'usdt', 'cash']) {
    if (split[`${method}_micros`] > 0
      && Number(payroll[`accepts_${method}`]) !== 1) {
      throw new RangeError(`${method} payment method was not accepted`);
    }
  }
  return split;
}

export async function savePaymentSplit(
  env,
  adminId,
  payrollId,
  input,
  now = new Date()
) {
  const payroll = await env.DB.prepare(`
    SELECT * FROM payroll_disbursements
    WHERE payroll_id = ?
  `).bind(payrollId).first();
  if (!payroll) throw new Error('payroll not found');
  if (!(await isStoreAdmin(env, adminId, payroll.store_id))) {
    throw new Error('payroll admin permission denied');
  }
  if (![
    'awaiting_admin_payment',
    'disputed'
  ].includes(payroll.status)) {
    throw new Error('payroll is not accepting a payment split');
  }
  const split = validatePaymentSplit(payroll, input);
  const nowIso = now.toISOString();
  const statements = [];
  if (payroll.status === 'disputed') {
    statements.push(env.DB.prepare(`
      UPDATE payroll_payment_proofs
      SET superseded_at = ?
      WHERE payroll_id = ?
        AND superseded_at IS NULL
    `).bind(nowIso, payroll.payroll_id));
  }
  statements.push(
    env.DB.prepare(`
      UPDATE payroll_disbursements
      SET bank_micros = ?,
          usdt_micros = ?,
          cash_micros = ?,
          current_admin_id = ?,
          status = 'awaiting_admin_payment',
          payment_sent_at = NULL,
          updated_at = ?
      WHERE payroll_id = ?
        AND status = ?
    `).bind(
      split.bank_micros,
      split.usdt_micros,
      split.cash_micros,
      String(adminId),
      nowIso,
      payroll.payroll_id,
      payroll.status
    ),
    env.DB.prepare(`
      INSERT INTO admin_audit_logs (
        store_id, admin_id, action, target_id,
        details_json, created_at
      ) VALUES (?, ?, 'save_payroll_payment_split', ?, ?, ?)
    `).bind(
      payroll.store_id,
      String(adminId),
      payroll.payroll_id,
      JSON.stringify(split),
      nowIso
    )
  );
  const results = await env.DB.batch(statements);
  const updateResult = results[payroll.status === 'disputed' ? 1 : 0];
  if (Number(updateResult && updateResult.meta.changes) !== 1) {
    throw new Error('payroll payment split conflict');
  }
  return env.DB.prepare(`
    SELECT * FROM payroll_disbursements
    WHERE payroll_id = ?
  `).bind(payroll.payroll_id).first();
}

async function employeePayroll(env, employeeId, payrollId) {
  const payroll = await env.DB.prepare(`
    SELECT * FROM payroll_disbursements
    WHERE payroll_id = ? AND telegram_id = ?
  `).bind(payrollId, String(employeeId)).first();
  if (!payroll) throw new Error('payroll not found');
  return payroll;
}

export async function confirmPayrollReceipt(
  env,
  employeeId,
  payrollId,
  financeEmail,
  now = new Date()
) {
  const payroll = await employeePayroll(
    env,
    employeeId,
    payrollId
  );
  if (payroll.status !== 'awaiting_employee_confirmation') {
    throw new Error('already_processed');
  }
  const recipient = String(financeEmail || '').trim();
  if (!recipient) throw new Error('payroll finance email is not configured');
  const confirmedAt = now.toISOString();
  const salaryRecordId = `SAL-AUTO-${payroll.payroll_id}`;
  const results = await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO salary_records (
        record_id, store_id, telegram_id, amount,
        period_start, period_end, approved_at,
        admin_id, request_id
      )
      SELECT ?, store_id, telegram_id,
        amount_snapshot_micros / 1000000.0,
        period_start, cutoff_at, ?,
        current_admin_id, payroll_id
      FROM payroll_disbursements
      WHERE payroll_id = ?
        AND telegram_id = ?
        AND status = 'awaiting_employee_confirmation'
    `).bind(
      salaryRecordId,
      confirmedAt,
      payroll.payroll_id,
      String(employeeId)
    ),
    env.DB.prepare(`
      INSERT INTO payroll_email_outbox (
        payroll_id, recipient, status, attempt_count,
        created_at, updated_at
      )
      SELECT payroll_id, ?, 'pending', 0, ?, ?
      FROM payroll_disbursements
      WHERE payroll_id = ?
        AND telegram_id = ?
        AND status = 'awaiting_employee_confirmation'
    `).bind(
      recipient,
      confirmedAt,
      confirmedAt,
      payroll.payroll_id,
      String(employeeId)
    ),
    env.DB.prepare(`
      INSERT INTO admin_audit_logs (
        store_id, admin_id, action, target_id,
        details_json, created_at
      )
      SELECT store_id, telegram_id,
        'confirm_payroll_receipt', payroll_id, ?, ?
      FROM payroll_disbursements
      WHERE payroll_id = ?
        AND telegram_id = ?
        AND status = 'awaiting_employee_confirmation'
    `).bind(
      JSON.stringify({ payroll_id: payroll.payroll_id }),
      confirmedAt,
      payroll.payroll_id,
      String(employeeId)
    ),
    env.DB.prepare(`
      UPDATE payroll_disbursements
      SET status = 'confirmed',
          salary_record_id = ?,
          confirmed_at = ?,
          updated_at = ?
      WHERE payroll_id = ?
        AND telegram_id = ?
        AND status = 'awaiting_employee_confirmation'
    `).bind(
      salaryRecordId,
      confirmedAt,
      confirmedAt,
      payroll.payroll_id,
      String(employeeId)
    )
  ]);
  if (Number(results[3] && results[3].meta.changes) !== 1) {
    throw new Error('already_processed');
  }
  return employeePayroll(env, employeeId, payroll.payroll_id);
}

export async function disputePayrollPayment(
  env,
  employeeId,
  payrollId,
  now = new Date()
) {
  const payroll = await employeePayroll(
    env,
    employeeId,
    payrollId
  );
  if (payroll.status !== 'awaiting_employee_confirmation') {
    throw new Error('already_processed');
  }
  const disputedAt = now.toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO admin_audit_logs (
        store_id, admin_id, action, target_id,
        details_json, created_at
      )
      SELECT store_id, telegram_id,
        'dispute_payroll_payment', payroll_id, ?, ?
      FROM payroll_disbursements
      WHERE payroll_id = ?
        AND telegram_id = ?
        AND status = 'awaiting_employee_confirmation'
    `).bind(
      JSON.stringify({ payroll_id: payroll.payroll_id }),
      disputedAt,
      payroll.payroll_id,
      String(employeeId)
    ),
    env.DB.prepare(`
      UPDATE payroll_disbursements
      SET status = 'disputed',
          disputed_at = ?,
          updated_at = ?
      WHERE payroll_id = ?
        AND telegram_id = ?
        AND status = 'awaiting_employee_confirmation'
    `).bind(
      disputedAt,
      disputedAt,
      payroll.payroll_id,
      String(employeeId)
    )
  ]);
  if (Number(results[1] && results[1].meta.changes) !== 1) {
    throw new Error('already_processed');
  }
  return employeePayroll(env, employeeId, payroll.payroll_id);
}
