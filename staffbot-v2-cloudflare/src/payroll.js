import { normalizeCommissionRate } from './money.js';

export { calculateSalaryAmount } from './money.js';

export async function getTotalIncome(env, storeId, telegramId) {
  const member = await env.DB.prepare(`SELECT cycle_start FROM store_members WHERE store_id = ? AND telegram_id = ?`).bind(storeId, telegramId).first();
  const cycleStart = member ? member.cycle_start : '1970-01-01T00:00:00.000Z';
  const row = await env.DB.prepare(`
    SELECT COALESCE(SUM(commission_income - fine), 0) AS total
    FROM income_records
    WHERE store_id = ? AND telegram_id = ? AND approved_at >= ?
  `).bind(storeId, telegramId, cycleStart).first();
  return Number(row.total || 0);
}

export async function getMemberCommissionRate(env, storeId, telegramId) {
  const row = await env.DB.prepare(`
    SELECT commission_rate FROM store_members WHERE store_id = ? AND telegram_id = ?
  `).bind(storeId, telegramId).first();
  return normalizeCommissionRate(row && row.commission_rate);
}
