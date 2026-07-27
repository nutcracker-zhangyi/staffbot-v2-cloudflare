import { makeId } from './ids.js';

function parseAmount(text, allowZero) {
  const value = Number(String(text).replace(',', '.').trim());
  if (!Number.isFinite(value)) return null;
  if (value < 0 || value > 1000000) return null;
  if (!allowZero && value === 0) return null;
  return Math.round(value * 100) / 100;
}

export function parseStoreAmount(store, text, allowZero) {
  const value = parseAmount(text, allowZero);
  if (value === null) return null;
  if (!isVndStore(store)) return value;
  return Math.round(value * 1000000);
}

export function attendanceFineAmount(store, amount) {
  return parseStoreAmount(store, String(amount || 0), true) || 0;
}

export function isVndStore(store) {
  const currency = String((store && store.currency) || '').trim().toUpperCase();
  return currency === '₫' || currency === 'VND';
}

export function formatMoney(store, amount) {
  const currency = (store && store.currency) || '$';
  if (isVndStore(store)) return `${currency}${Math.round(Number(amount || 0)).toLocaleString('en-US')}`;
  return `${currency}${Number(amount || 0).toFixed(2)}`;
}

export function formatAdminMoney(value) {
  if (value === null || value === undefined || value === '') return '';
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  return number.toLocaleString('en-US', { maximumFractionDigits: 20 });
}

export function normalizeCommissionRate(value) {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate <= 0) return 0.6;
  if (rate > 1) return Math.min(rate / 100, 1);
  return Math.min(rate, 1);
}

export function calculateSalaryAmount(total, commissionRate) {
  return Math.round(Number(total || 0) * normalizeCommissionRate(commissionRate) * 100) / 100;
}

export function calculateCommissionIncome(income, commissionRate) {
  return Math.round(Number(income || 0) * normalizeCommissionRate(commissionRate) * 100) / 100;
}

export function calculateNetIncome(income, fine, commissionRate) {
  return calculateCommissionIncome(income, commissionRate) - Number(fine || 0);
}

export function calculateIncomeRowsTotal(rows) {
  return (rows || []).reduce((total, row) => total + Number(row.commission_income || 0) - Number(row.fine || 0), 0);
}

export function absenceFineRecordDraft(request, adminId, decidedAt, recordId) {
  return {
    record_id: recordId,
    store_id: request.store_id,
    telegram_id: request.telegram_id,
    income: 0,
    commission_rate: 0.6,
    commission_income: 0,
    original_fine: Number(request.original_fine || 0),
    fine: Number(request.fine || 0),
    type: 'fine',
    source: 'attendance_absence',
    request_id: request.request_id,
    approved_at: decidedAt,
    admin_id: adminId
  };
}

export function approvedIncomeRecordDrafts(found, adminId, approvedAt, recordIds) {
  const ids = recordIds || [];
  const rows = [{
    record_id: ids[0] || makeId('REC'),
    store_id: found.store_id,
    telegram_id: found.telegram_id,
    income: Number(found.income || 0),
    commission_rate: normalizeCommissionRate(found.commission_rate),
    commission_income: Number(found.commission_income || 0),
    original_fine: 0,
    fine: 0,
    type: 'income',
    source: 'manual',
    request_id: found.request_id,
    approved_at: approvedAt,
    admin_id: adminId
  }];
  if (Number(found.fine || 0) !== 0) {
    rows.push({
      record_id: ids[1] || makeId('REC'),
      store_id: found.store_id,
      telegram_id: found.telegram_id,
      income: 0,
      commission_rate: normalizeCommissionRate(found.commission_rate),
      commission_income: 0,
      original_fine: Number(found.fine || 0),
      fine: Number(found.fine || 0),
      type: 'fine',
      source: 'manual_fine',
      request_id: found.request_id,
      approved_at: approvedAt,
      admin_id: adminId
    });
  }
  return rows;
}

export function checkoutFineWaiverAmount(fine, waived) {
  const amount = Number(fine || 0);
  return waived && amount > 0 ? -amount : 0;
}

export function checkoutFineRecordDrafts(fine, applyFine) {
  const amount = Number(fine || 0);
  if (amount <= 0) return [];
  return [{ fine: applyFine ? amount : 0, original_fine: amount }];
}

export function attendanceAdminActions(fine) {
  return Number(fine || 0) > 0 ? ['approve_fine', 'approve_no_fine', 'reject'] : ['approve', 'reject'];
}

export function attendanceFineDecision(originalFine, applyFine) {
  const amount = Number(originalFine || 0);
  return {
    fine: applyFine ? amount : 0,
    originalFine: amount
  };
}

export function formatPercent(value) {
  return `${Math.round(normalizeCommissionRate(value) * 10000) / 100}%`;
}
