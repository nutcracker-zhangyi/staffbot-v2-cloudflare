import { payrollCutoffsBetween } from './payroll-cycle.js';
import { getLedgerTotalIncomeMicros } from './payroll.js';
import { createNegativeCarryDraft } from './payroll-ledger.js';

function payrollId(storeId, telegramId, scheduledDate) {
  return [
    'PAYROLL',
    encodeURIComponent(storeId),
    encodeURIComponent(telegramId),
    scheduledDate
  ].join(':');
}

function validPaymentProfile(profile) {
  if (!profile) return false;
  const acceptsCash = Number(profile.accepts_cash) === 1;
  const acceptsBank = Number(profile.accepts_bank) === 1
    && String(profile.bank_details || '').trim() !== '';
  const acceptsUsdt = Number(profile.accepts_usdt) === 1
    && String(profile.usdt_details || '').trim() !== '';
  return acceptsCash || acceptsBank || acceptsUsdt;
}

function initialStatus(amountMicros, profile) {
  if (amountMicros < 0) return 'carried_negative';
  if (amountMicros === 0) return 'skipped_zero';
  return validPaymentProfile(profile)
    ? 'awaiting_admin_payment'
    : 'awaiting_employee_details';
}

export async function eligiblePayrollMembers(env) {
  const rows = await env.DB.prepare(`
    SELECT
      m.store_id,
      m.telegram_id,
      m.payroll_start_date,
      m.payroll_automation_started_at,
      m.cycle_start,
      s.timezone,
      s.currency,
      COALESCE(p.accepts_bank, 0) AS accepts_bank,
      COALESCE(p.accepts_usdt, 0) AS accepts_usdt,
      COALESCE(p.accepts_cash, 0) AS accepts_cash,
      p.bank_details,
      p.usdt_details
    FROM store_members m
    JOIN stores s ON s.store_id = m.store_id
    LEFT JOIN payroll_payment_profiles p
      ON p.store_id = m.store_id
     AND p.telegram_id = m.telegram_id
    WHERE m.role IN ('employee', 'admin', 'owner')
      AND m.status = 'active'
      AND s.status = 'active'
      AND m.payroll_start_date IS NOT NULL
      AND m.payroll_automation_started_at IS NOT NULL
    ORDER BY m.store_id, m.telegram_id
  `).all();
  return rows.results || [];
}

export function settlementDraft(
  member,
  cutoff,
  amountMicros,
  profile = member,
  createdAt = new Date().toISOString()
) {
  if (!Number.isSafeInteger(amountMicros)) {
    throw new RangeError(
      'payroll snapshot micros must be a JavaScript safe integer'
    );
  }
  const id = payrollId(
    member.store_id,
    member.telegram_id,
    cutoff.scheduled_date
  );
  const status = initialStatus(amountMicros, profile);
  return {
    payroll_id: id,
    store_id: member.store_id,
    telegram_id: member.telegram_id,
    payroll_start_date: member.payroll_start_date,
    scheduled_date: cutoff.scheduled_date,
    cycle_day: cutoff.cycle_day,
    period_start: member.cycle_start,
    cutoff_at: cutoff.cutoff_at,
    amount_snapshot_micros: amountMicros,
    currency: member.currency,
    status,
    accepts_bank: Number(profile && profile.accepts_bank) === 1 ? 1 : 0,
    accepts_usdt: Number(profile && profile.accepts_usdt) === 1 ? 1 : 0,
    accepts_cash: Number(profile && profile.accepts_cash) === 1 ? 1 : 0,
    bank_details_snapshot: profile && profile.bank_details
      ? String(profile.bank_details)
      : null,
    usdt_details_snapshot: profile && profile.usdt_details
      ? String(profile.usdt_details)
      : null,
    negative_carry_entry_id: status === 'carried_negative'
      ? `PAY-CARRY:${id}`
      : null,
    created_at: createdAt,
    updated_at: createdAt
  };
}

function disbursementInsertStatement(env, payroll) {
  return env.DB.prepare(`
    INSERT INTO payroll_disbursements (
      payroll_id, store_id, telegram_id, payroll_start_date,
      scheduled_date, cycle_day, period_start, cutoff_at,
      amount_snapshot_micros, currency, status,
      accepts_bank, accepts_usdt, accepts_cash,
      bank_details_snapshot, usdt_details_snapshot,
      negative_carry_entry_id, created_at, updated_at
    )
    SELECT
      ?, m.store_id, m.telegram_id, m.payroll_start_date,
      ?, ?, m.cycle_start, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?, ?
    FROM store_members m
    WHERE m.store_id = ?
      AND m.telegram_id = ?
      AND m.cycle_start = ?
      AND NOT EXISTS (
        SELECT 1
        FROM payroll_disbursements d
        WHERE d.store_id = m.store_id
          AND d.telegram_id = m.telegram_id
          AND d.scheduled_date = ?
      )
  `).bind(
    payroll.payroll_id,
    payroll.scheduled_date,
    payroll.cycle_day,
    payroll.cutoff_at,
    payroll.amount_snapshot_micros,
    payroll.currency,
    payroll.status,
    payroll.accepts_bank,
    payroll.accepts_usdt,
    payroll.accepts_cash,
    payroll.bank_details_snapshot,
    payroll.usdt_details_snapshot,
    payroll.negative_carry_entry_id,
    payroll.created_at,
    payroll.updated_at,
    payroll.store_id,
    payroll.telegram_id,
    payroll.period_start,
    payroll.scheduled_date
  );
}

function negativeCarryInsertStatement(env, payroll) {
  if (payroll.status !== 'carried_negative') {
    return env.DB.prepare(`
      UPDATE payroll_disbursements
      SET updated_at = updated_at
      WHERE payroll_id = ? AND 0
    `).bind(payroll.payroll_id);
  }
  const entry = createNegativeCarryDraft(payroll, payroll.created_at);
  return env.DB.prepare(`
    INSERT INTO payroll_entries (
      entry_id, store_id, telegram_id, type, amount_micros, currency,
      effective_at, source, source_id, created_by, created_at,
      reverses_entry_id, metadata_json
    )
    SELECT
      ?, d.store_id, d.telegram_id, ?, ?, d.currency,
      d.cutoff_at, ?, d.payroll_id, ?, ?,
      NULL, ?
    FROM payroll_disbursements d
    WHERE d.payroll_id = ?
      AND d.created_at = ?
      AND d.status = 'carried_negative'
      AND NOT EXISTS (
        SELECT 1 FROM payroll_entries e
        WHERE e.source = 'payroll_negative_carry'
          AND e.source_id = d.payroll_id
      )
  `).bind(
    entry.entry_id,
    entry.type,
    entry.amount_micros,
    entry.source,
    entry.created_by,
    entry.created_at,
    entry.metadata_json,
    payroll.payroll_id,
    payroll.created_at
  );
}

function cycleAdvanceStatement(env, payroll) {
  return env.DB.prepare(`
    UPDATE store_members
    SET cycle_start = ?, updated_at = ?
    WHERE store_id = ?
      AND telegram_id = ?
      AND cycle_start = ?
      AND EXISTS (
        SELECT 1 FROM payroll_disbursements d
        WHERE d.payroll_id = ?
          AND d.created_at = ?
      )
  `).bind(
    payroll.cutoff_at,
    payroll.updated_at,
    payroll.store_id,
    payroll.telegram_id,
    payroll.period_start,
    payroll.payroll_id,
    payroll.created_at
  );
}

function settlementAuditStatement(env, payroll) {
  const details = JSON.stringify({
    scheduled_date: payroll.scheduled_date,
    cycle_day: payroll.cycle_day,
    amount_snapshot_micros: payroll.amount_snapshot_micros,
    currency: payroll.currency,
    status: payroll.status
  });
  return env.DB.prepare(`
    INSERT INTO admin_audit_logs (
      store_id, admin_id, action, target_id, details_json, created_at
    )
    SELECT
      d.store_id, 'SYSTEM', 'settle_personal_payroll',
      d.payroll_id, ?, ?
    FROM payroll_disbursements d
    WHERE d.payroll_id = ?
      AND d.created_at = ?
      AND NOT EXISTS (
        SELECT 1 FROM admin_audit_logs a
        WHERE a.action = 'settle_personal_payroll'
          AND a.target_id = d.payroll_id
      )
  `).bind(
    details,
    payroll.created_at,
    payroll.payroll_id,
    payroll.created_at
  );
}

async function findPayroll(env, member, cutoff) {
  return env.DB.prepare(`
    SELECT * FROM payroll_disbursements
    WHERE store_id = ?
      AND telegram_id = ?
      AND scheduled_date = ?
  `).bind(
    member.store_id,
    member.telegram_id,
    cutoff.scheduled_date
  ).first();
}

export async function settlePayrollCutoff(
  env,
  member,
  cutoff,
  now = new Date()
) {
  const createdAt = now.toISOString();
  const amountMicros = await getLedgerTotalIncomeMicros(
    env,
    member.store_id,
    member.telegram_id,
    member.cycle_start,
    cutoff.cutoff_at
  );
  const payroll = settlementDraft(
    member,
    cutoff,
    amountMicros,
    member,
    createdAt
  );

  let results;
  try {
    results = await env.DB.batch([
      disbursementInsertStatement(env, payroll),
      negativeCarryInsertStatement(env, payroll),
      cycleAdvanceStatement(env, payroll),
      settlementAuditStatement(env, payroll)
    ]);
  } catch (error) {
    const existing = await findPayroll(env, member, cutoff);
    if (existing) return { created: false, payroll: existing };
    throw error;
  }

  const saved = await findPayroll(env, member, cutoff);
  return {
    created: Number(results[0] && results[0].meta.changes) === 1
      && saved
      && saved.created_at === createdAt,
    payroll: saved
  };
}

export async function processPayrollSettlements(env, now = new Date()) {
  const members = await eligiblePayrollMembers(env);
  const summary = {
    scanned: 0,
    created: 0,
    skipped_zero: 0,
    carried_negative: 0
  };
  const throughIso = now.toISOString();

  for (const member of members) {
    const afterIso = member.payroll_automation_started_at > member.cycle_start
      ? member.payroll_automation_started_at
      : member.cycle_start;
    const cutoffs = payrollCutoffsBetween(
      member.payroll_start_date,
      member.timezone || 'Asia/Tokyo',
      afterIso,
      throughIso
    );
    for (const cutoff of cutoffs) {
      summary.scanned += 1;
      const result = await settlePayrollCutoff(env, member, cutoff, now);
      if (!result.payroll) break;
      member.cycle_start = result.payroll.cutoff_at;
      if (!result.created) continue;
      summary.created += 1;
      if (result.payroll.status === 'skipped_zero') {
        summary.skipped_zero += 1;
      }
      if (result.payroll.status === 'carried_negative') {
        summary.carried_negative += 1;
      }
    }
  }
  return summary;
}
