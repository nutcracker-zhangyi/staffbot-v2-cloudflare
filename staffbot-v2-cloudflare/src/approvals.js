import { audit, makeId, nowIso } from './audit.js';
import {
  absenceFineRecordDraft,
  approvedIncomeRecordDrafts,
  attendanceFineDecision,
  checkoutFineRecordDrafts
} from './money.js';
import {
  payrollEntryFromIncomeRecordDraft,
  payrollEntryInsertStatement,
  payrollLedgerWritesEnabled
} from './payroll-ledger.js';
import { getTotalIncome } from './payroll.js';
import { getStore } from './stores.js';

export async function insertSystemFine(env, storeId, userId, fine, source, sourceId, adminId = 'SYSTEM', originalFine = fine) {
  const approvedAt = nowIso();
  const draft = {
    record_id: makeId('REC'),
    store_id: storeId,
    telegram_id: userId,
    income: 0,
    commission_rate: 0.6,
    commission_income: 0,
    original_fine: Number(originalFine || 0),
    fine: Number(fine || 0),
    type: 'fine',
    source,
    request_id: sourceId,
    approved_at: approvedAt,
    admin_id: adminId
  };
  const legacyStatement = env.DB.prepare(`
    INSERT INTO income_records
      (record_id, store_id, telegram_id, income, commission_rate, commission_income, original_fine, fine, type, source, request_id, approved_at, admin_id)
    VALUES (?, ?, ?, 0, 0.6, 0, ?, ?, 'fine', ?, ?, ?, ?)
  `).bind(
    draft.record_id,
    draft.store_id,
    draft.telegram_id,
    draft.original_fine,
    draft.fine,
    draft.source,
    draft.request_id,
    draft.approved_at,
    draft.admin_id
  );
  if (!payrollLedgerWritesEnabled(env)) {
    await legacyStatement.run();
    return;
  }

  const store = await getStore(env, storeId);
  const entry = payrollEntryFromIncomeRecordDraft(
    draft,
    store.currency,
    makeId('PAY')
  );
  const statements = [legacyStatement];
  if (entry) statements.push(payrollEntryInsertStatement(env, entry));
  await env.DB.batch(statements);
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

function pendingRequestIncomeRecordStatement(env, tableName, draft) {
  return env.DB.prepare(`
    INSERT INTO income_records (
      record_id, store_id, telegram_id, income, commission_rate,
      commission_income, original_fine, fine, type, source,
      request_id, approved_at, admin_id
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    FROM ${tableName}
    WHERE store_id = ? AND request_id = ? AND status = 'pending'
  `).bind(
    draft.record_id,
    draft.store_id,
    draft.telegram_id,
    draft.income,
    draft.commission_rate,
    draft.commission_income,
    draft.original_fine,
    draft.fine,
    draft.type,
    draft.source,
    draft.request_id,
    draft.approved_at,
    draft.admin_id,
    draft.store_id,
    draft.request_id
  );
}

function pendingRequestLedgerStatement(env, tableName, entry, storeId, requestId) {
  return env.DB.prepare(`
    INSERT INTO payroll_entries (
      entry_id, store_id, telegram_id, type, amount_micros, currency,
      effective_at, source, source_id, created_by, created_at,
      reverses_entry_id, metadata_json
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    FROM ${tableName}
    WHERE store_id = ? AND request_id = ? AND status = 'pending'
  `).bind(
    entry.entry_id,
    entry.store_id,
    entry.telegram_id,
    entry.type,
    entry.amount_micros,
    entry.currency,
    entry.effective_at,
    entry.source,
    entry.source_id,
    entry.created_by,
    entry.created_at,
    entry.reverses_entry_id,
    entry.metadata_json,
    storeId,
    requestId
  );
}

function pendingRequestAuditStatement(
  env,
  tableName,
  storeId,
  requestId,
  adminId,
  action,
  details,
  createdAt
) {
  return env.DB.prepare(`
    INSERT INTO admin_audit_logs (
      store_id, admin_id, action, target_id, details_json, created_at
    )
    SELECT ?, ?, ?, ?, ?, ?
    FROM ${tableName}
    WHERE store_id = ? AND request_id = ? AND status = 'pending'
  `).bind(
    storeId,
    adminId,
    action,
    requestId,
    JSON.stringify(details || {}),
    createdAt,
    storeId,
    requestId
  );
}

function pendingAbsenceLedgerStatement(env, entry, requestId, expectedStoreId) {
  const storeSql = expectedStoreId ? ` AND store_id = ?` : '';
  const requestParams = expectedStoreId
    ? [requestId, expectedStoreId]
    : [requestId];
  return env.DB.prepare(`
    INSERT INTO payroll_entries (
      entry_id, store_id, telegram_id, type, amount_micros, currency,
      effective_at, source, source_id, created_by, created_at,
      reverses_entry_id, metadata_json
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    FROM absence_fine_requests
    WHERE request_id = ? AND status = 'pending'${storeSql}
  `).bind(
    entry.entry_id,
    entry.store_id,
    entry.telegram_id,
    entry.type,
    entry.amount_micros,
    entry.currency,
    entry.effective_at,
    entry.source,
    entry.source_id,
    entry.created_by,
    entry.created_at,
    entry.reverses_entry_id,
    entry.metadata_json,
    ...requestParams
  );
}

function pendingAbsenceAuditStatement(env, found, adminId, decidedAt, expectedStoreId) {
  const storeSql = expectedStoreId ? ` AND store_id = ?` : '';
  const requestParams = expectedStoreId
    ? [found.request_id, expectedStoreId]
    : [found.request_id];
  return env.DB.prepare(`
    INSERT INTO admin_audit_logs (
      store_id, admin_id, action, target_id, details_json, created_at
    )
    SELECT ?, ?, 'approve_absence_fine', ?, ?, ?
    FROM absence_fine_requests
    WHERE request_id = ? AND status = 'pending'${storeSql}
  `).bind(
    found.store_id,
    adminId,
    found.request_id,
    JSON.stringify(found),
    decidedAt,
    ...requestParams
  );
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
  const statements = [
    env.DB.prepare(`
      INSERT INTO income_records
        (record_id, store_id, telegram_id, income, commission_rate, commission_income, original_fine, fine, type, source, request_id, approved_at, admin_id)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      FROM absence_fine_requests WHERE request_id = ? AND status = 'pending'${storeSql}
    `).bind(
      draft.record_id, draft.store_id, draft.telegram_id, draft.income, draft.commission_rate,
      draft.commission_income, draft.original_fine, draft.fine, draft.type, draft.source, draft.request_id,
      draft.approved_at, draft.admin_id, ...requestParams
    )
  ];
  if (payrollLedgerWritesEnabled(env)) {
    const store = await getStore(env, found.store_id);
    const entry = payrollEntryFromIncomeRecordDraft(
      draft,
      store.currency,
      makeId('PAY')
    );
    if (entry) {
      statements.push(
        pendingAbsenceLedgerStatement(
          env,
          entry,
          requestId,
          expectedStoreId
        )
      );
    }
  }
  statements.push(
    pendingAbsenceAuditStatement(
      env,
      found,
      adminId,
      decidedAt,
      expectedStoreId
    )
  );
  const updateIndex = statements.length;
  statements.push(
    env.DB.prepare(`
      UPDATE absence_fine_requests
      SET status = 'approved', decided_at = ?, admin_id = ?, income_record_id = ?
      WHERE request_id = ? AND status = 'pending'${storeSql}
    `).bind(decidedAt, adminId, recordId, ...requestParams)
  );
  const results = await env.DB.batch(statements);
  if (mutationCount(results[updateIndex]) !== 1) return { ok: false };
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
  if (!found) return { ok: false };
  if (found.status !== 'pending') {
    return { ok: false, error: 'already_decided' };
  }
  const store = await getStore(env, storeId);
  const approvedAt = nowIso();
  const drafts = approvedIncomeRecordDrafts(found, adminId, approvedAt, [makeId('REC'), makeId('REC')]);
  const statements = drafts.map((draft) => (
    pendingRequestIncomeRecordStatement(env, 'pending_income', draft)
  ));
  if (payrollLedgerWritesEnabled(env)) {
    for (const draft of drafts) {
      const entry = payrollEntryFromIncomeRecordDraft(
        draft,
        store.currency,
        makeId('PAY')
      );
      if (entry) {
        statements.push(
          pendingRequestLedgerStatement(
            env,
            'pending_income',
            entry,
            storeId,
            requestId
          )
        );
      }
    }
  }
  statements.push(
    pendingRequestAuditStatement(
      env,
      'pending_income',
      storeId,
      requestId,
      adminId,
      'approve_income',
      found,
      approvedAt
    )
  );
  const updateIndex = statements.length;
  statements.push(
    env.DB.prepare(`
      UPDATE pending_income
      SET status = 'approved', decided_at = ?, admin_id = ?
      WHERE store_id = ? AND request_id = ? AND status = 'pending'
    `).bind(approvedAt, adminId, storeId, requestId)
  );
  const results = await env.DB.batch(statements);
  if (mutationCount(results[updateIndex]) !== 1) {
    return { ok: false, error: 'already_decided' };
  }
  return { ok: true, row: found, store };
}

export async function rejectIncomeRequest(env, storeId, requestId, adminId, reason) {
  const found = await env.DB.prepare(`SELECT * FROM pending_income WHERE store_id = ? AND request_id = ?`).bind(storeId, requestId).first();
  if (!found) return { ok: false };
  if (found.status !== 'pending') {
    return { ok: false, error: 'already_decided' };
  }
  const decidedAt = nowIso();
  const statements = [
    pendingRequestAuditStatement(
      env,
      'pending_income',
      storeId,
      requestId,
      adminId,
      'reject_income',
      { reason, ...found },
      decidedAt
    ),
    env.DB.prepare(`
      UPDATE pending_income
      SET status = 'rejected', decided_at = ?, admin_id = ?, reject_reason = ?
      WHERE store_id = ? AND request_id = ? AND status = 'pending'
    `).bind(decidedAt, adminId, reason, storeId, requestId)
  ];
  const results = await env.DB.batch(statements);
  if (mutationCount(results[1]) !== 1) {
    return { ok: false, error: 'already_decided' };
  }
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
  if (!found) return { ok: false };
  if (found.status !== 'pending') {
    return { ok: false, error: 'already_decided' };
  }
  const store = await getStore(env, storeId);
  const member = await env.DB.prepare(`SELECT cycle_start, commission_rate FROM store_members WHERE store_id = ? AND telegram_id = ?`).bind(storeId, found.telegram_id).first();
  const periodStart = member ? member.cycle_start : found.requested_at;
  const periodEnd = nowIso();
  const finalAmount = await getTotalIncome(env, storeId, found.telegram_id);
  const recordId = makeId('SAL');

  const statements = [
    env.DB.prepare(`
      INSERT INTO salary_records
        (
          record_id, store_id, telegram_id, amount, period_start,
          period_end, approved_at, admin_id, request_id
        )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
      FROM salary_requests
      WHERE store_id = ? AND request_id = ? AND status = 'pending'
    `).bind(
      recordId,
      storeId,
      found.telegram_id,
      finalAmount,
      periodStart,
      periodEnd,
      periodEnd,
      adminId,
      requestId,
      storeId,
      requestId
    ),
    env.DB.prepare(`
      UPDATE store_members
      SET cycle_start = ?, updated_at = ?
      WHERE store_id = ? AND telegram_id = ?
        AND EXISTS (
          SELECT 1 FROM salary_requests
          WHERE store_id = ? AND request_id = ? AND status = 'pending'
        )
    `).bind(
      periodEnd,
      periodEnd,
      storeId,
      found.telegram_id,
      storeId,
      requestId
    ),
    pendingRequestAuditStatement(
      env,
      'salary_requests',
      storeId,
      requestId,
      adminId,
      'approve_salary',
      { amount: finalAmount, ...found },
      periodEnd
    )
  ];
  const updateIndex = statements.length;
  statements.push(
    env.DB.prepare(`
      UPDATE salary_requests
      SET status = 'approved', decided_at = ?, admin_id = ?
      WHERE store_id = ? AND request_id = ? AND status = 'pending'
    `).bind(periodEnd, adminId, storeId, requestId)
  );
  const results = await env.DB.batch(statements);
  if (mutationCount(results[updateIndex]) !== 1) {
    return { ok: false, error: 'already_decided' };
  }
  return { ok: true, row: found, store, amount: finalAmount, periodStart, periodEnd };
}

export async function rejectSalaryRequest(env, storeId, requestId, adminId, reason) {
  const found = await env.DB.prepare(`SELECT * FROM salary_requests WHERE store_id = ? AND request_id = ?`).bind(storeId, requestId).first();
  if (!found) return { ok: false };
  if (found.status !== 'pending') {
    return { ok: false, error: 'already_decided' };
  }
  const decidedAt = nowIso();
  const statements = [
    pendingRequestAuditStatement(
      env,
      'salary_requests',
      storeId,
      requestId,
      adminId,
      'reject_salary',
      { reason, ...found },
      decidedAt
    ),
    env.DB.prepare(`
      UPDATE salary_requests
      SET status = 'rejected', decided_at = ?, admin_id = ?, reject_reason = ?
      WHERE store_id = ? AND request_id = ? AND status = 'pending'
    `).bind(decidedAt, adminId, reason, storeId, requestId)
  ];
  const results = await env.DB.batch(statements);
  if (mutationCount(results[1]) !== 1) {
    return { ok: false, error: 'already_decided' };
  }
  return { ok: true, row: found, reason };
}

export async function approveSalaryAdvanceRequest(env, storeId, requestId, adminId) {
  const found = await env.DB.prepare(`SELECT * FROM salary_advance_requests WHERE store_id = ? AND request_id = ?`).bind(storeId, requestId).first();
  if (!found) return { ok: false };
  if (found.status !== 'pending') {
    return { ok: false, error: 'already_decided' };
  }
  const store = await getStore(env, storeId);
  const total = await getTotalIncome(env, storeId, found.telegram_id);
  if (Number(found.amount || 0) > total) return { ok: false, error: 'amount_exceeds_salary', store, total };
  const decidedAt = nowIso();
  const recordId = makeId('REC');
  const draft = {
    record_id: recordId,
    store_id: storeId,
    telegram_id: found.telegram_id,
    income: 0,
    commission_rate: 0.6,
    commission_income: 0,
    original_fine: Number(found.amount || 0),
    fine: Number(found.amount || 0),
    type: 'advance',
    source: 'salary_advance',
    request_id: requestId,
    approved_at: decidedAt,
    admin_id: adminId
  };
  const statements = [
    pendingRequestIncomeRecordStatement(
      env,
      'salary_advance_requests',
      draft
    )
  ];
  if (payrollLedgerWritesEnabled(env)) {
    const entry = payrollEntryFromIncomeRecordDraft(
      draft,
      store.currency,
      makeId('PAY')
    );
    if (entry) {
      statements.push(
        pendingRequestLedgerStatement(
          env,
          'salary_advance_requests',
          entry,
          storeId,
          requestId
        )
      );
    }
  }
  statements.push(
    pendingRequestAuditStatement(
      env,
      'salary_advance_requests',
      storeId,
      requestId,
      adminId,
      'approve_salary_advance',
      found,
      decidedAt
    )
  );
  const updateIndex = statements.length;
  statements.push(
    env.DB.prepare(`
      UPDATE salary_advance_requests
      SET status = 'approved', decided_at = ?, admin_id = ?
      WHERE store_id = ? AND request_id = ? AND status = 'pending'
    `).bind(decidedAt, adminId, storeId, requestId)
  );
  const results = await env.DB.batch(statements);
  if (mutationCount(results[updateIndex]) !== 1) {
    return { ok: false, error: 'already_decided' };
  }
  return { ok: true, row: found, store };
}

export async function rejectSalaryAdvanceRequest(env, storeId, requestId, adminId, reason) {
  const found = await env.DB.prepare(`SELECT * FROM salary_advance_requests WHERE store_id = ? AND request_id = ?`).bind(storeId, requestId).first();
  if (!found) return { ok: false };
  if (found.status !== 'pending') {
    return { ok: false, error: 'already_decided' };
  }
  const decidedAt = nowIso();
  const statements = [
    pendingRequestAuditStatement(
      env,
      'salary_advance_requests',
      storeId,
      requestId,
      adminId,
      'reject_salary_advance',
      { reason, ...found },
      decidedAt
    ),
    env.DB.prepare(`
      UPDATE salary_advance_requests
      SET status = 'rejected', decided_at = ?, admin_id = ?, reject_reason = ?
      WHERE store_id = ? AND request_id = ? AND status = 'pending'
    `).bind(decidedAt, adminId, reason, storeId, requestId)
  ];
  const results = await env.DB.batch(statements);
  if (mutationCount(results[1]) !== 1) {
    return { ok: false, error: 'already_decided' };
  }
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
