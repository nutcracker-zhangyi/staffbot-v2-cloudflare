import { logPayrollShadowMismatch } from './audit.js';
import { normalizeCommissionRate } from './money.js';
import { MICROS_PER_UNIT } from './payroll-ledger.js';

export { calculateSalaryAmount } from './money.js';

const CURRENT_PAYROLL_OPEN_END = '9999-12-31T23:59:59.999Z';

function resultMicros(row) {
  const value = Number(row && row.total_micros ? row.total_micros : 0);
  if (!Number.isSafeInteger(value)) {
    throw new RangeError('payroll total micros must be a JavaScript safe integer');
  }
  return value;
}

function payrollLedgerReadMode(env) {
  const mode = String((env && env.PAYROLL_LEDGER_READ_MODE) || '').trim();
  if (!mode || mode === 'legacy') return 'legacy';
  if (mode === 'shadow' || mode === 'ledger') return mode;
  console.error(`Invalid PAYROLL_LEDGER_READ_MODE: ${mode}`);
  return 'legacy';
}

export async function getLegacyTotalIncomeMicros(env, storeId, telegramId, start, end) {
  const row = await env.DB.prepare(`
    SELECT COALESCE(
      SUM(ROUND((commission_income - fine) * 1000000)),
      0
    ) AS total_micros
    FROM income_records
    WHERE store_id = ?
      AND telegram_id = ?
      AND approved_at >= ?
      AND approved_at < ?
  `).bind(storeId, telegramId, start, end).first();
  return resultMicros(row);
}

export async function getLedgerTotalIncomeMicros(env, storeId, telegramId, start, end) {
  const row = await env.DB.prepare(`
    SELECT COALESCE(SUM(amount_micros), 0) AS total_micros
    FROM payroll_entries
    WHERE store_id = ?
      AND telegram_id = ?
      AND effective_at >= ?
      AND effective_at < ?
  `).bind(storeId, telegramId, start, end).first();
  return resultMicros(row);
}

export async function comparePayrollTotals(env, storeId, telegramId, start, end) {
  const [legacyMicros, ledgerMicros] = await Promise.all([
    getLegacyTotalIncomeMicros(env, storeId, telegramId, start, end),
    getLedgerTotalIncomeMicros(env, storeId, telegramId, start, end)
  ]);
  const differenceMicros = ledgerMicros - legacyMicros;
  return {
    store_id: storeId,
    telegram_id: telegramId,
    start,
    end,
    legacy_micros: legacyMicros,
    ledger_micros: ledgerMicros,
    difference_micros: differenceMicros,
    matches: differenceMicros === 0
  };
}

export async function getTotalIncome(env, storeId, telegramId) {
  const member = await env.DB.prepare(`SELECT cycle_start FROM store_members WHERE store_id = ? AND telegram_id = ?`).bind(storeId, telegramId).first();
  const cycleStart = member ? member.cycle_start : '1970-01-01T00:00:00.000Z';
  const cutoffAt = CURRENT_PAYROLL_OPEN_END;
  const mode = payrollLedgerReadMode(env);

  if (mode === 'ledger') {
    const ledgerMicros = await getLedgerTotalIncomeMicros(
      env,
      storeId,
      telegramId,
      cycleStart,
      cutoffAt
    );
    return ledgerMicros / MICROS_PER_UNIT;
  }

  if (mode === 'shadow') {
    const comparison = await comparePayrollTotals(
      env,
      storeId,
      telegramId,
      cycleStart,
      cutoffAt
    );
    if (!comparison.matches) {
      await logPayrollShadowMismatch(env, comparison);
    }
    return comparison.legacy_micros / MICROS_PER_UNIT;
  }

  const legacyMicros = await getLegacyTotalIncomeMicros(
    env,
    storeId,
    telegramId,
    cycleStart,
    cutoffAt
  );
  return legacyMicros / MICROS_PER_UNIT;
}

export async function getMemberCommissionRate(env, storeId, telegramId) {
  const row = await env.DB.prepare(`
    SELECT commission_rate FROM store_members WHERE store_id = ? AND telegram_id = ?
  `).bind(storeId, telegramId).first();
  return normalizeCommissionRate(row && row.commission_rate);
}
