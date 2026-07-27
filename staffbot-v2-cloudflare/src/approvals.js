import { audit, makeId, nowIso } from './audit.js';
import {
  absenceFineRecordDraft,
  approvedIncomeRecordDrafts,
  attendanceFineDecision,
  checkoutFineRecordDrafts
} from './money.js';
import { getTotalIncome } from './payroll.js';
import { getStore } from './stores.js';

export async function insertSystemFine(env, storeId, userId, fine, source, sourceId, adminId = 'SYSTEM', originalFine = fine) {
  await env.DB.prepare(`
    INSERT INTO income_records
      (record_id, store_id, telegram_id, income, commission_rate, commission_income, original_fine, fine, type, source, request_id, approved_at, admin_id)
    VALUES (?, ?, ?, 0, 0.6, 0, ?, ?, 'fine', ?, ?, ?, ?)
  `).bind(makeId('REC'), storeId, userId, originalFine, fine, source, sourceId, nowIso(), adminId).run();
}

export async function hasPendingCheckout(env, storeId, userId, businessDate) {
  const row = await env.DB.prepare(`
    SELECT request_id FROM pending_checkout_requests
    WHERE store_id = ? AND telegram_id = ? AND business_date = ? AND status = 'pending'
  `).bind(storeId, userId, businessDate).first();
  return !!row;
}

export async function hasAttendance(env, storeId, userId, businessDate, type) {
  const row = await env.DB.prepare(`
    SELECT record_id FROM attendance_records
    WHERE store_id = ? AND telegram_id = ? AND business_date = ? AND type = ?
  `).bind(storeId, userId, businessDate, type).first();
  return !!row;
}

export function mutationCount(result) {
  return Number(result && result.meta ? result.meta.changes : 0);
}

export async function approveAbsenceFineRequest(env, requestId, adminId, expectedStoreId = '') {
  const storeSql = expectedStoreId ? ` AND store_id = ?` : '';
  const requestParams = expectedStoreId ? [requestId, expectedStoreId] : [requestId];
  const found = await env.DB.prepare(`
    SELECT * FROM absence_fine_requests WHERE request_id = ? AND status = 'pending'${storeSql}
  `).bind(...requestParams).first();
  if (!found) return { ok: false };

  const decidedAt = nowIso();
  const recordId = makeId('REC');
  const draft = absenceFineRecordDraft(found, adminId, decidedAt, recordId);
  const results = await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO income_records
        (record_id, store_id, telegram_id, income, commission_rate, commission_income, original_fine, fine, type, source, request_id, approved_at, admin_id)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      FROM absence_fine_requests WHERE request_id = ? AND status = 'pending'${storeSql}
    `).bind(
      draft.record_id, draft.store_id, draft.telegram_id, draft.income, draft.commission_rate,
      draft.commission_income, draft.original_fine, draft.fine, draft.type, draft.source, draft.request_id,
      draft.approved_at, draft.admin_id, ...requestParams
    ),
    env.DB.prepare(`
      UPDATE absence_fine_requests
      SET status = 'approved', decided_at = ?, admin_id = ?, income_record_id = ?
      WHERE request_id = ? AND status = 'pending'${storeSql}
    `).bind(decidedAt, adminId, recordId, ...requestParams)
  ]);
  if (mutationCount(results[1]) !== 1) return { ok: false };
  await audit(env, found.store_id, adminId, 'approve_absence_fine', requestId, found);
  return { ok: true, row: found, recordId };
}

export async function rejectAbsenceFineRequest(env, requestId, adminId, reason = 'Rejected by admin', expectedStoreId = '') {
  const storeSql = expectedStoreId ? ` AND store_id = ?` : '';
  const requestParams = expectedStoreId ? [requestId, expectedStoreId] : [requestId];
  const found = await env.DB.prepare(`
    SELECT * FROM absence_fine_requests WHERE request_id = ? AND status = 'pending'${storeSql}
  `).bind(...requestParams).first();
  if (!found) return { ok: false };

  const result = await env.DB.prepare(`
    UPDATE absence_fine_requests
    SET status = 'rejected', decided_at = ?, admin_id = ?, reject_reason = ?
    WHERE request_id = ? AND status = 'pending'${storeSql}
  `).bind(nowIso(), adminId, reason, ...requestParams).run();
  if (mutationCount(result) !== 1) return { ok: false };
  await audit(env, found.store_id, adminId, 'reject_absence_fine', requestId, { reason, ...found });
  return { ok: true, row: found, reason };
}

export async function approveIncomeRequest(env, storeId, requestId, adminId) {
  const found = await env.DB.prepare(`SELECT * FROM pending_income WHERE store_id = ? AND request_id = ?`).bind(storeId, requestId).first();
  if (!found || found.status !== 'pending') return { ok: false };
  const store = await getStore(env, storeId);
  const approvedAt = nowIso();
  const drafts = approvedIncomeRecordDrafts(found, adminId, approvedAt, [makeId('REC'), makeId('REC')]);
  await env.DB.batch([
    env.DB.prepare(`UPDATE pending_income SET status = 'approved', decided_at = ?, admin_id = ? WHERE store_id = ? AND request_id = ?`)
      .bind(approvedAt, adminId, storeId, requestId),
    ...drafts.map((draft) => env.DB.prepare(`
      INSERT INTO income_records
        (record_id, store_id, telegram_id, income, commission_rate, commission_income, original_fine, fine, type, source, request_id, approved_at, admin_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      draft.record_id, draft.store_id, draft.telegram_id, draft.income, draft.commission_rate,
      draft.commission_income, draft.original_fine, draft.fine, draft.type, draft.source, draft.request_id,
      draft.approved_at, draft.admin_id
    ))
  ]);
  await audit(env, storeId, adminId, 'approve_income', requestId, found);
  return { ok: true, row: found, store };
}

export async function rejectIncomeRequest(env, storeId, requestId, adminId, reason) {
  const found = await env.DB.prepare(`SELECT * FROM pending_income WHERE store_id = ? AND request_id = ?`).bind(storeId, requestId).first();
  if (!found || found.status !== 'pending') return { ok: false };
  await env.DB.prepare(`
    UPDATE pending_income
    SET status = 'rejected', decided_at = ?, admin_id = ?, reject_reason = ?
    WHERE store_id = ? AND request_id = ?
  `).bind(nowIso(), adminId, reason, storeId, requestId).run();
  await audit(env, storeId, adminId, 'reject_income', requestId, { reason, ...found });
  return { ok: true, row: found, reason };
}

export async function deletePendingIncome(env, storeId, requestId, adminId) {
  const found = await env.DB.prepare(`SELECT * FROM pending_income WHERE store_id = ? AND request_id = ?`).bind(storeId, requestId).first();
  if (!found) return { ok: false, error: 'not_found' };
  await env.DB.prepare(`DELETE FROM pending_income WHERE store_id = ? AND request_id = ?`).bind(storeId, requestId).run();
  await audit(env, storeId, adminId, 'delete_pending_income', requestId, found);
  return { ok: true };
}

export async function deleteIncomeRecord(env, storeId, recordId, adminId) {
  const found = await env.DB.prepare(`SELECT * FROM income_records WHERE store_id = ? AND record_id = ?`).bind(storeId, recordId).first();
  if (!found) return { ok: false, error: 'not_found' };
  await env.DB.prepare(`DELETE FROM income_records WHERE store_id = ? AND record_id = ?`).bind(storeId, recordId).run();
  await audit(env, storeId, adminId, 'delete_income_record', recordId, found);
  return { ok: true };
}

export async function updateIncomeFineRecord(env, storeId, recordId, adminId, fine) {
  const amount = Number(fine);
  if (!Number.isFinite(amount)) return { ok: false, error: 'invalid_fine' };
  const found = await env.DB.prepare(`SELECT * FROM income_records WHERE store_id = ? AND record_id = ?`).bind(storeId, recordId).first();
  if (!found) return { ok: false, error: 'not_found' };
  if (found.type !== 'fine') return { ok: false, error: 'not_fine_record' };
  await env.DB.prepare(`UPDATE income_records SET fine = ? WHERE store_id = ? AND record_id = ?`).bind(amount, storeId, recordId).run();
  await audit(env, storeId, adminId, 'update_income_fine', recordId, { before: found.fine, after: amount });
  return { ok: true };
}

export async function approveSalaryRequest(env, storeId, requestId, adminId) {
  const found = await env.DB.prepare(`SELECT * FROM salary_requests WHERE store_id = ? AND request_id = ?`).bind(storeId, requestId).first();
  if (!found || found.status !== 'pending') return { ok: false };
  const store = await getStore(env, storeId);
  const member = await env.DB.prepare(`SELECT cycle_start, commission_rate FROM store_members WHERE store_id = ? AND telegram_id = ?`).bind(storeId, found.telegram_id).first();
  const periodStart = member ? member.cycle_start : found.requested_at;
  const periodEnd = nowIso();
  const finalAmount = await getTotalIncome(env, storeId, found.telegram_id);
  const recordId = makeId('SAL');

  await env.DB.batch([
    env.DB.prepare(`UPDATE salary_requests SET status = 'approved', decided_at = ?, admin_id = ? WHERE store_id = ? AND request_id = ?`)
      .bind(periodEnd, adminId, storeId, requestId),
    env.DB.prepare(`
      INSERT INTO salary_records
        (record_id, store_id, telegram_id, amount, period_start, period_end, approved_at, admin_id, request_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(recordId, storeId, found.telegram_id, finalAmount, periodStart, periodEnd, periodEnd, adminId, requestId),
    env.DB.prepare(`UPDATE store_members SET cycle_start = ?, updated_at = ? WHERE store_id = ? AND telegram_id = ?`)
      .bind(periodEnd, periodEnd, storeId, found.telegram_id)
  ]);

  await audit(env, storeId, adminId, 'approve_salary', requestId, { amount: finalAmount, ...found });
  return { ok: true, row: found, store, amount: finalAmount, periodStart, periodEnd };
}

export async function rejectSalaryRequest(env, storeId, requestId, adminId, reason) {
  const found = await env.DB.prepare(`SELECT * FROM salary_requests WHERE store_id = ? AND request_id = ?`).bind(storeId, requestId).first();
  if (!found || found.status !== 'pending') return { ok: false };
  await env.DB.prepare(`
    UPDATE salary_requests
    SET status = 'rejected', decided_at = ?, admin_id = ?, reject_reason = ?
    WHERE store_id = ? AND request_id = ?
  `).bind(nowIso(), adminId, reason, storeId, requestId).run();
  await audit(env, storeId, adminId, 'reject_salary', requestId, { reason, ...found });
  return { ok: true, row: found, reason };
}

export async function approveSalaryAdvanceRequest(env, storeId, requestId, adminId) {
  const found = await env.DB.prepare(`SELECT * FROM salary_advance_requests WHERE store_id = ? AND request_id = ?`).bind(storeId, requestId).first();
  if (!found || found.status !== 'pending') return { ok: false };
  const store = await getStore(env, storeId);
  const total = await getTotalIncome(env, storeId, found.telegram_id);
  if (Number(found.amount || 0) > total) return { ok: false, error: 'amount_exceeds_salary', store, total };
  const decidedAt = nowIso();
  const recordId = makeId('REC');

  await env.DB.batch([
    env.DB.prepare(`UPDATE salary_advance_requests SET status = 'approved', decided_at = ?, admin_id = ? WHERE store_id = ? AND request_id = ?`)
      .bind(decidedAt, adminId, storeId, requestId),
    env.DB.prepare(`
      INSERT INTO income_records
        (record_id, store_id, telegram_id, income, commission_rate, commission_income, original_fine, fine, type, source, request_id, approved_at, admin_id)
      VALUES (?, ?, ?, 0, 0.6, 0, ?, ?, 'advance', 'salary_advance', ?, ?, ?)
    `).bind(recordId, storeId, found.telegram_id, found.amount, found.amount, requestId, decidedAt, adminId)
  ]);

  await audit(env, storeId, adminId, 'approve_salary_advance', requestId, found);
  return { ok: true, row: found, store };
}

export async function rejectSalaryAdvanceRequest(env, storeId, requestId, adminId, reason) {
  const found = await env.DB.prepare(`SELECT * FROM salary_advance_requests WHERE store_id = ? AND request_id = ?`).bind(storeId, requestId).first();
  if (!found || found.status !== 'pending') return { ok: false };
  await env.DB.prepare(`
    UPDATE salary_advance_requests
    SET status = 'rejected', decided_at = ?, admin_id = ?, reject_reason = ?
    WHERE store_id = ? AND request_id = ?
  `).bind(nowIso(), adminId, reason, storeId, requestId).run();
  await audit(env, storeId, adminId, 'reject_salary_advance', requestId, { reason, ...found });
  return { ok: true, row: found, reason };
}

export async function approveLeaveRequest(env, storeId, requestId, adminId) {
  const found = await env.DB.prepare(`SELECT * FROM leave_requests WHERE store_id = ? AND request_id = ?`).bind(storeId, requestId).first();
  if (!found || !['pending', 'approved'].includes(found.status)) return { ok: false };
  if (found.status === 'pending') {
    const store = await getStore(env, storeId);
    const conflict = await env.DB.prepare(`
      SELECT COUNT(*) AS total FROM leave_requests
      WHERE store_id = ? AND leave_date = ? AND status = 'approved' AND request_id != ?
    `).bind(storeId, found.leave_date, requestId).first();
    if (Number(conflict && conflict.total ? conflict.total : 0) >= Number((store && store.leave_daily_limit) || 1)) {
      return { ok: false, error: 'leave_conflict' };
    }
  }
  const absence = await env.DB.prepare(`
    SELECT * FROM absence_fine_requests
    WHERE store_id = ? AND telegram_id = ? AND business_date = ?
      AND status IN ('pending', 'approved', 'rejected')
  `).bind(storeId, found.telegram_id, found.leave_date).first();
  if (found.status === 'approved' && !absence) return { ok: false };

  const decidedAt = nowIso();
  const statements = [];
  if (found.status === 'pending') {
    statements.push(env.DB.prepare(`
      UPDATE leave_requests SET status = 'approved', decided_at = ?, admin_id = ?
      WHERE store_id = ? AND request_id = ? AND status = 'pending'
    `).bind(decidedAt, adminId, storeId, requestId));
  }
  if (absence) statements.push(...absenceCancellationStatements(env, storeId, absence.request_id, decidedAt, adminId));
  const results = await env.DB.batch(statements);
  if (found.status === 'pending' && mutationCount(results[0]) !== 1) return { ok: false };
  const absenceResultIndex = statements.length - 1;
  if (absence && mutationCount(results[absenceResultIndex]) !== 1) return { ok: false };
  if (found.status === 'pending') await audit(env, storeId, adminId, 'approve_leave', requestId, found);
  if (absence) await audit(env, storeId, adminId, 'cancel_absence_for_leave', absence.request_id, absence);
  return { ok: true, row: found };
}

export function absenceCancellationStatements(env, storeId, requestId, decidedAt, adminId) {
  return [
    env.DB.prepare(`
      UPDATE income_records SET fine = 0
      WHERE store_id = ? AND source = 'attendance_absence'
        AND record_id = (
          SELECT income_record_id FROM absence_fine_requests
          WHERE request_id = ? AND status = 'approved'
        )
    `).bind(storeId, requestId),
    env.DB.prepare(`
      UPDATE absence_fine_requests
      SET status = 'cancelled', cancellation_reason = 'Approved leave',
          decided_at = COALESCE(decided_at, ?), admin_id = COALESCE(admin_id, ?)
      WHERE request_id = ? AND status IN ('pending', 'approved', 'rejected')
    `).bind(decidedAt, adminId, requestId)
  ];
}

export async function cancelAbsenceForApprovedLeave(env, storeId, telegramId, leaveDate, adminId) {
  const found = await env.DB.prepare(`
    SELECT * FROM absence_fine_requests
    WHERE store_id = ? AND telegram_id = ? AND business_date = ?
      AND status IN ('pending', 'approved', 'rejected')
  `).bind(storeId, telegramId, leaveDate).first();
  if (!found) return { ok: false };

  const decidedAt = nowIso();
  const results = await env.DB.batch(absenceCancellationStatements(env, storeId, found.request_id, decidedAt, adminId));
  if (mutationCount(results[1]) !== 1) return { ok: false };
  await audit(env, storeId, adminId, 'cancel_absence_for_leave', found.request_id, found);
  return { ok: true, row: found };
}

export async function rejectLeaveRequest(env, storeId, requestId, adminId, reason) {
  const found = await env.DB.prepare(`SELECT * FROM leave_requests WHERE store_id = ? AND request_id = ?`).bind(storeId, requestId).first();
  if (!found || found.status !== 'pending') return { ok: false };
  await env.DB.prepare(`
    UPDATE leave_requests
    SET status = 'rejected', decided_at = ?, admin_id = ?, reject_reason = ?
    WHERE store_id = ? AND request_id = ?
  `).bind(nowIso(), adminId, reason, storeId, requestId).run();
  await audit(env, storeId, adminId, 'reject_leave', requestId, { reason, ...found });
  return { ok: true, row: found, reason };
}

export async function approveCheckoutRequest(env, storeId, requestId, adminId, applyFine = true) {
  const found = await env.DB.prepare(`SELECT * FROM pending_checkout_requests WHERE store_id = ? AND request_id = ?`).bind(storeId, requestId).first();
  if (!found || found.status !== 'pending') return { ok: false };
  if (await hasAttendance(env, storeId, found.telegram_id, found.business_date, 'checkout')) return { ok: false };
  const store = await getStore(env, storeId);
  const approvedAt = nowIso();
  const recordId = makeId('ATT');
  const fineDecision = attendanceFineDecision(found.fine, applyFine);
  await env.DB.batch([
    env.DB.prepare(`UPDATE pending_checkout_requests SET status = 'approved', decided_at = ?, admin_id = ? WHERE store_id = ? AND request_id = ?`)
      .bind(approvedAt, adminId, storeId, requestId),
    env.DB.prepare(`
      INSERT INTO attendance_records
        (record_id, store_id, telegram_id, business_date, type, timestamp, latitude, longitude, late, early_leave, original_fine, fine)
      VALUES (?, ?, ?, ?, 'checkout', ?, ?, ?, 0, ?, ?, ?)
    `).bind(recordId, storeId, found.telegram_id, found.business_date, found.timestamp, found.latitude, found.longitude, found.early_leave, fineDecision.originalFine, fineDecision.fine)
  ]);
  for (const fineRecord of checkoutFineRecordDrafts(found.fine, applyFine)) {
    await insertSystemFine(env, storeId, found.telegram_id, fineRecord.fine, 'attendance_early', recordId, adminId, fineRecord.original_fine);
  }
  await audit(env, storeId, adminId, 'approve_checkout', requestId, found);
  return { ok: true, row: found, store, waivedFine: !applyFine && Number(found.fine || 0) > 0 };
}

export async function rejectCheckoutRequest(env, storeId, requestId, adminId, reason) {
  const found = await env.DB.prepare(`SELECT * FROM pending_checkout_requests WHERE store_id = ? AND request_id = ?`).bind(storeId, requestId).first();
  if (!found || found.status !== 'pending') return { ok: false };
  await env.DB.prepare(`
    UPDATE pending_checkout_requests
    SET status = 'rejected', decided_at = ?, admin_id = ?, reject_reason = ?
    WHERE store_id = ? AND request_id = ?
  `).bind(nowIso(), adminId, reason, storeId, requestId).run();
  await audit(env, storeId, adminId, 'reject_checkout', requestId, { reason, ...found });
  return { ok: true, row: found, reason };
}
