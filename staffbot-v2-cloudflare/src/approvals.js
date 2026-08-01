import { audit, makeId, nowIso } from './audit.js';
import { render } from './i18n.js';
import {
  absenceFineRecordDraft,
  approvedIncomeRecordDrafts,
  attendanceFineDecision,
  checkoutFineRecordDrafts,
  formatMoney,
  formatPercent
} from './money.js';
import {
  amountToMicros,
  payrollEntryFromIncomeRecordDraft,
  payrollEntryInsertStatement,
  payrollLedgerWriteMode,
  payrollLedgerWritesEnabled,
  reversePayrollEntry
} from './payroll-ledger.js';
import { getTotalIncome } from './payroll.js';
import { getStore } from './stores.js';

const APPROVAL_NOTIFICATION_SOURCES = {
  income: 'pending_income',
  leave: 'leave_requests',
  absence: 'absence_fine_requests',
  advance: 'salary_advance_requests'
};

export async function approvalResultNotification(env, storeId, type, requestId) {
  const table = APPROVAL_NOTIFICATION_SOURCES[String(type || '')];
  if (!table) return null;
  const row = await env.DB.prepare(`
    SELECT * FROM ${table} WHERE store_id = ? AND request_id = ?
  `).bind(String(storeId), String(requestId)).first();
  if (!row) return null;
  if (!['approved', 'rejected'].includes(row.status)) {
    return { error: 'decision_required' };
  }

  const store = await getStore(env, storeId);
  const preference = await env.DB.prepare(`
    SELECT language FROM user_preferences WHERE telegram_id = ?
  `).bind(row.telegram_id).first();
  const lang = String(preference && preference.language || 'zh');
  return {
    recipient: String(row.telegram_id),
    decision: String(row.status),
    text: approvalResultText(type, row, store, lang)
  };
}

function approvalResultText(type, row, store, lang) {
  if (type === 'income') {
    if (row.status === 'rejected') {
      return render(lang, 'income_rejected', { reason: row.reject_reason });
    }
    return render(lang, 'income_approved', {
      income: formatMoney(store, row.income),
      commission: formatPercent(row.commission_rate),
      commission_income: formatMoney(store, row.commission_income),
      fine: formatMoney(store, row.fine)
    });
  }
  if (type === 'leave') {
    return render(lang, row.status === 'approved' ? 'leave_approved' : 'leave_rejected', {
      date: row.leave_date,
      reason: row.reject_reason
    });
  }
  if (type === 'advance') {
    return render(lang, row.status === 'approved' ? 'advance_approved' : 'advance_rejected', {
      amount: formatMoney(store, row.amount),
      reason: row.reject_reason
    });
  }
  return absenceResultText(row, store, lang);
}

function absenceResultText(row, store, lang) {
  const messages = {
    approved: {
      zh: '你的缺勤罚款已批准。\n日期：{date}\n罚款：{fine}',
      en: 'Your absence fine was approved.\nDate: {date}\nFine: {fine}',
      vi: 'Khoản phạt vắng mặt của bạn đã được duyệt.\nNgày: {date}\nTiền phạt: {fine}',
      ru: 'Штраф за отсутствие одобрен.\nДата: {date}\nШтраф: {fine}'
    },
    rejected: {
      zh: '你的缺勤罚款已被驳回。\n日期：{date}\n原因：{reason}',
      en: 'Your absence fine was rejected.\nDate: {date}\nReason: {reason}',
      vi: 'Khoản phạt vắng mặt của bạn đã bị từ chối.\nNgày: {date}\nLý do: {reason}',
      ru: 'Штраф за отсутствие отклонен.\nДата: {date}\nПричина: {reason}'
    }
  };
  return (messages[row.status][lang] || messages[row.status].zh)
    .replace('{date}', String(row.business_date))
    .replace('{fine}', formatMoney(store, row.fine))
    .replace('{reason}', String(row.reject_reason || ''));
}

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

function claimGuard(claim) {
  if (!claim) return { sql: '', params: [] };
  return {
    sql: `
      AND EXISTS (
        SELECT 1 FROM admin_task_claims c
        WHERE c.task_type = ? AND c.task_id = ? AND c.store_id = ?
          AND c.claimed_by = ? AND c.updated_at = ?
          AND c.lease_expires_at > ?
      )
    `,
    params: [
      claim.task_type,
      claim.task_id,
      claim.store_id,
      claim.claimed_by,
      claim.updated_at,
      claim.checked_at
    ]
  };
}

function claimAt(claim, checkedAt) {
  return claim ? { ...claim, checked_at: checkedAt } : null;
}

function claimConsumeStatement(
  env,
  claim,
  tableName,
  status,
  adminId,
  decidedAt
) {
  if (!claim) return null;
  return env.DB.prepare(`
    DELETE FROM admin_task_claims
    WHERE task_type = ? AND task_id = ? AND store_id = ?
      AND claimed_by = ? AND updated_at = ? AND lease_expires_at > ?
      AND EXISTS (
        SELECT 1 FROM ${tableName} r
        WHERE r.store_id = ? AND r.request_id = ? AND r.status = ?
          AND r.admin_id = ? AND r.decided_at = ?
      )
  `).bind(
    claim.task_type,
    claim.task_id,
    claim.store_id,
    claim.claimed_by,
    claim.updated_at,
    claim.checked_at,
    claim.store_id,
    claim.task_id,
    status,
    adminId,
    decidedAt
  );
}

async function decisionFailure(env, claim) {
  if (!claim) return { ok: false, error: 'already_decided' };
  const current = await env.DB.prepare(`
    SELECT 1 FROM admin_task_claims
    WHERE task_type = ? AND task_id = ? AND store_id = ?
      AND claimed_by = ? AND updated_at = ?
      AND lease_expires_at > ?
  `).bind(
    claim.task_type,
    claim.task_id,
    claim.store_id,
    claim.claimed_by,
    claim.updated_at,
    claim.checked_at
  ).first();
  return {
    ok: false,
    error: current ? 'already_decided' : 'task_claim_required'
  };
}

function pendingRequestIncomeRecordStatement(env, tableName, draft, claim = null) {
  const guard = claimGuard(claim);
  return env.DB.prepare(`
    INSERT INTO income_records (
      record_id, store_id, telegram_id, income, commission_rate,
      commission_income, original_fine, fine, type, source,
      request_id, approved_at, admin_id
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    FROM ${tableName}
    WHERE store_id = ? AND request_id = ? AND status = 'pending'
      ${guard.sql}
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
    draft.request_id,
    ...guard.params
  );
}

function pendingRequestLedgerStatement(env, tableName, entry, storeId, requestId, claim = null) {
  const guard = claimGuard(claim);
  return env.DB.prepare(`
    INSERT INTO payroll_entries (
      entry_id, store_id, telegram_id, type, amount_micros, currency,
      effective_at, source, source_id, created_by, created_at,
      reverses_entry_id, metadata_json
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    FROM ${tableName}
    WHERE store_id = ? AND request_id = ? AND status = 'pending'
      ${guard.sql}
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
    requestId,
    ...guard.params
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
  createdAt,
  claim = null
) {
  const guard = claimGuard(claim);
  return env.DB.prepare(`
    INSERT INTO admin_audit_logs (
      store_id, admin_id, action, target_id, details_json, created_at
    )
    SELECT ?, ?, ?, ?, ?, ?
    FROM ${tableName}
    WHERE store_id = ? AND request_id = ? AND status = 'pending'
      ${guard.sql}
  `).bind(
    storeId,
    adminId,
    action,
    requestId,
    JSON.stringify(details || {}),
    createdAt,
    storeId,
    requestId,
    ...guard.params
  );
}

function pendingAbsenceLedgerStatement(env, entry, requestId, expectedStoreId, claim = null) {
  const storeSql = expectedStoreId ? ` AND store_id = ?` : '';
  const requestParams = expectedStoreId
    ? [requestId, expectedStoreId]
    : [requestId];
  const guard = claimGuard(claim);
  return env.DB.prepare(`
    INSERT INTO payroll_entries (
      entry_id, store_id, telegram_id, type, amount_micros, currency,
      effective_at, source, source_id, created_by, created_at,
      reverses_entry_id, metadata_json
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    FROM absence_fine_requests
    WHERE request_id = ? AND status = 'pending'${storeSql}
      ${guard.sql}
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
    ...requestParams,
    ...guard.params
  );
}

function pendingAbsenceAuditStatement(env, found, adminId, decidedAt, expectedStoreId, claim = null) {
  const storeSql = expectedStoreId ? ` AND store_id = ?` : '';
  const requestParams = expectedStoreId
    ? [found.request_id, expectedStoreId]
    : [found.request_id];
  const guard = claimGuard(claim);
  return env.DB.prepare(`
    INSERT INTO admin_audit_logs (
      store_id, admin_id, action, target_id, details_json, created_at
    )
    SELECT ?, ?, 'approve_absence_fine', ?, ?, ?
    FROM absence_fine_requests
    WHERE request_id = ? AND status = 'pending'${storeSql}
      ${guard.sql}
  `).bind(
    found.store_id,
    adminId,
    found.request_id,
    JSON.stringify(found),
    decidedAt,
    ...requestParams,
    ...guard.params
  );
}

export async function approveAbsenceFineRequest(env, requestId, adminId, expectedStoreId = '', claim = null) {
  const storeSql = expectedStoreId ? ` AND store_id = ?` : '';
  const requestParams = expectedStoreId ? [requestId, expectedStoreId] : [requestId];
  const found = await env.DB.prepare(`
    SELECT * FROM absence_fine_requests WHERE request_id = ? AND status = 'pending'${storeSql}
  `).bind(...requestParams).first();
  if (!found) {
    const existing = await env.DB.prepare(`
      SELECT status FROM absence_fine_requests WHERE request_id = ?${storeSql}
    `).bind(...requestParams).first();
    return existing
      ? { ok: false, error: 'already_decided' }
      : { ok: false };
  }

  const decidedAt = nowIso();
  claim = claimAt(claim, decidedAt);
  const recordId = makeId('REC');
  const draft = absenceFineRecordDraft(found, adminId, decidedAt, recordId);
  const guard = claimGuard(claim);
  const statements = [
    env.DB.prepare(`
      INSERT INTO income_records
        (record_id, store_id, telegram_id, income, commission_rate, commission_income, original_fine, fine, type, source, request_id, approved_at, admin_id)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      FROM absence_fine_requests WHERE request_id = ? AND status = 'pending'${storeSql}
        ${guard.sql}
    `).bind(
      draft.record_id, draft.store_id, draft.telegram_id, draft.income, draft.commission_rate,
      draft.commission_income, draft.original_fine, draft.fine, draft.type, draft.source, draft.request_id,
      draft.approved_at, draft.admin_id, ...requestParams, ...guard.params
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
          expectedStoreId,
          claim
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
      expectedStoreId,
      claim
    )
  );
  const updateIndex = statements.length;
  statements.push(
    env.DB.prepare(`
      UPDATE absence_fine_requests
      SET status = 'approved', decided_at = ?, admin_id = ?, income_record_id = ?
      WHERE request_id = ? AND status = 'pending'${storeSql}
        ${guard.sql}
    `).bind(decidedAt, adminId, recordId, ...requestParams, ...guard.params)
  );
  const claimIndex = claim ? statements.length : -1;
  if (claim) {
    statements.push(claimConsumeStatement(
      env,
      claim,
      'absence_fine_requests',
      'approved',
      adminId,
      decidedAt
    ));
  }
  const results = await env.DB.batch(statements);
  if (
    mutationCount(results[updateIndex]) !== 1
    || (claim && mutationCount(results[claimIndex]) !== 1)
  ) {
    return decisionFailure(env, claim);
  }
  return { ok: true, row: found, recordId };
}

export async function rejectAbsenceFineRequest(env, requestId, adminId, reason = 'Rejected by admin', expectedStoreId = '', claim = null) {
  const storeSql = expectedStoreId ? ` AND store_id = ?` : '';
  const requestParams = expectedStoreId ? [requestId, expectedStoreId] : [requestId];
  const found = await env.DB.prepare(`
    SELECT * FROM absence_fine_requests WHERE request_id = ? AND status = 'pending'${storeSql}
  `).bind(...requestParams).first();
  if (!found) {
    const existing = await env.DB.prepare(`
      SELECT status FROM absence_fine_requests WHERE request_id = ?${storeSql}
    `).bind(...requestParams).first();
    return existing
      ? { ok: false, error: 'already_decided' }
      : { ok: false };
  }

  const decidedAt = nowIso();
  claim = claimAt(claim, decidedAt);
  const guard = claimGuard(claim);
  const updateStatement = env.DB.prepare(`
    UPDATE absence_fine_requests
    SET status = 'rejected', decided_at = ?, admin_id = ?, reject_reason = ?
    WHERE request_id = ? AND status = 'pending'${storeSql}
      ${guard.sql}
  `).bind(decidedAt, adminId, reason, ...requestParams, ...guard.params);
  let updateResult;
  let claimResult = null;
  if (claim) {
    [updateResult, claimResult] = await env.DB.batch([
      updateStatement,
      claimConsumeStatement(
        env,
        claim,
        'absence_fine_requests',
        'rejected',
        adminId,
        decidedAt
      )
    ]);
  } else {
    updateResult = await updateStatement.run();
  }
  if (
    mutationCount(updateResult) !== 1
    || (claim && mutationCount(claimResult) !== 1)
  ) {
    return decisionFailure(env, claim);
  }
  await audit(env, found.store_id, adminId, 'reject_absence_fine', requestId, { reason, ...found });
  return { ok: true, row: found, reason };
}

export async function approveIncomeRequest(env, storeId, requestId, adminId, claim = null) {
  const found = await env.DB.prepare(`SELECT * FROM pending_income WHERE store_id = ? AND request_id = ?`).bind(storeId, requestId).first();
  if (!found) return { ok: false };
  if (found.status !== 'pending') {
    return { ok: false, error: 'already_decided' };
  }
  const store = await getStore(env, storeId);
  const approvedAt = nowIso();
  claim = claimAt(claim, approvedAt);
  const drafts = approvedIncomeRecordDrafts(found, adminId, approvedAt, [makeId('REC'), makeId('REC')]);
  const statements = drafts.map((draft) => (
    pendingRequestIncomeRecordStatement(env, 'pending_income', draft, claim)
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
            requestId,
            claim
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
      approvedAt,
      claim
    )
  );
  const guard = claimGuard(claim);
  const updateIndex = statements.length;
  statements.push(
    env.DB.prepare(`
      UPDATE pending_income
      SET status = 'approved', decided_at = ?, admin_id = ?
      WHERE store_id = ? AND request_id = ? AND status = 'pending'
        ${guard.sql}
    `).bind(approvedAt, adminId, storeId, requestId, ...guard.params)
  );
  const claimIndex = claim ? statements.length : -1;
  if (claim) {
    statements.push(claimConsumeStatement(
      env,
      claim,
      'pending_income',
      'approved',
      adminId,
      approvedAt
    ));
  }
  const results = await env.DB.batch(statements);
  if (
    mutationCount(results[updateIndex]) !== 1
    || (claim && mutationCount(results[claimIndex]) !== 1)
  ) {
    return decisionFailure(env, claim);
  }
  return { ok: true, row: found, store };
}

export async function rejectIncomeRequest(env, storeId, requestId, adminId, reason, claim = null) {
  const found = await env.DB.prepare(`SELECT * FROM pending_income WHERE store_id = ? AND request_id = ?`).bind(storeId, requestId).first();
  if (!found) return { ok: false };
  if (found.status !== 'pending') {
    return { ok: false, error: 'already_decided' };
  }
  const decidedAt = nowIso();
  claim = claimAt(claim, decidedAt);
  const statements = [
    pendingRequestAuditStatement(
      env,
      'pending_income',
      storeId,
      requestId,
      adminId,
      'reject_income',
      { reason, ...found },
      decidedAt,
      claim
    ),
  ];
  const guard = claimGuard(claim);
  statements.push(
    env.DB.prepare(`
      UPDATE pending_income
      SET status = 'rejected', decided_at = ?, admin_id = ?, reject_reason = ?
      WHERE store_id = ? AND request_id = ? AND status = 'pending'
        ${guard.sql}
    `).bind(decidedAt, adminId, reason, storeId, requestId, ...guard.params)
  );
  const updateIndex = statements.length - 1;
  const claimIndex = claim ? statements.length : -1;
  if (claim) {
    statements.push(claimConsumeStatement(
      env,
      claim,
      'pending_income',
      'rejected',
      adminId,
      decidedAt
    ));
  }
  const results = await env.DB.batch(statements);
  if (
    mutationCount(results[updateIndex]) !== 1
    || (claim && mutationCount(results[claimIndex]) !== 1)
  ) {
    return decisionFailure(env, claim);
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

async function payrollEntryForIncomeRecord(env, record) {
  const requestId = record.request_id || record.record_id;
  return env.DB.prepare(`
    SELECT * FROM payroll_entries
    WHERE store_id = ?
      AND source = ?
      AND source_id IN (?, ?)
      AND type != 'reversal'
    ORDER BY CASE WHEN source_id = ? THEN 0 ELSE 1 END
    LIMIT 1
  `).bind(
    record.store_id,
    record.source,
    requestId,
    record.record_id,
    requestId
  ).first();
}

export async function deleteIncomeRecord(env, storeId, recordId, adminId) {
  const found = await env.DB.prepare(`SELECT * FROM income_records WHERE store_id = ? AND record_id = ?`).bind(storeId, recordId).first();
  if (!found) return { ok: false, error: 'not_found' };
  const writeMode = payrollLedgerWriteMode(env);
  if (writeMode === 'invalid') {
    return { ok: false, error: 'invalid_write_mode' };
  }
  if (writeMode === 'dual') {
    const originalEntry = await payrollEntryForIncomeRecord(env, found);
    if (!originalEntry) {
      return { ok: false, error: 'ledger_entry_not_found' };
    }
    return reversePayrollEntry(
      env,
      storeId,
      originalEntry.entry_id,
      adminId,
      nowIso()
    );
  }
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
  const writeMode = payrollLedgerWriteMode(env);
  if (writeMode === 'invalid') {
    return { ok: false, error: 'invalid_write_mode' };
  }
  if (writeMode === 'dual') {
    let fineMicros;
    try {
      fineMicros = amountToMicros(amount);
    } catch {
      return { ok: false, error: 'invalid_fine' };
    }
    if (fineMicros < 0) return { ok: false, error: 'invalid_fine' };

    const originalEntry = await payrollEntryForIncomeRecord(env, found);
    if (!originalEntry) {
      return { ok: false, error: 'ledger_entry_not_found' };
    }
    const effectiveAt = nowIso();
    const replacementEntryId = makeId('PAY-CORR');
    const replacementEntry = fineMicros === 0
      ? null
      : {
          entry_id: replacementEntryId,
          store_id: originalEntry.store_id,
          telegram_id: originalEntry.telegram_id,
          type: 'fine',
          amount_micros: -fineMicros,
          currency: originalEntry.currency,
          effective_at: effectiveAt,
          source: 'fine_correction',
          source_id: replacementEntryId,
          created_by: adminId,
          created_at: effectiveAt,
          reverses_entry_id: null,
          metadata_json: JSON.stringify({
            corrects_entry_id: originalEntry.entry_id,
            legacy_record_id: recordId,
            requested_fine: amount
          })
        };
    return reversePayrollEntry(
      env,
      storeId,
      originalEntry.entry_id,
      adminId,
      effectiveAt,
      replacementEntry
    );
  }
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

export async function approveSalaryAdvanceRequest(env, storeId, requestId, adminId, claim = null) {
  const found = await env.DB.prepare(`SELECT * FROM salary_advance_requests WHERE store_id = ? AND request_id = ?`).bind(storeId, requestId).first();
  if (!found) return { ok: false };
  if (found.status !== 'pending') {
    return { ok: false, error: 'already_decided' };
  }
  const store = await getStore(env, storeId);
  const total = await getTotalIncome(env, storeId, found.telegram_id);
  if (Number(found.amount || 0) > total) return { ok: false, error: 'amount_exceeds_salary', store, total };
  const decidedAt = nowIso();
  claim = claimAt(claim, decidedAt);
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
      draft,
      claim
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
          requestId,
          claim
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
      decidedAt,
      claim
    )
  );
  const guard = claimGuard(claim);
  const updateIndex = statements.length;
  statements.push(
    env.DB.prepare(`
      UPDATE salary_advance_requests
      SET status = 'approved', decided_at = ?, admin_id = ?
      WHERE store_id = ? AND request_id = ? AND status = 'pending'
        ${guard.sql}
    `).bind(decidedAt, adminId, storeId, requestId, ...guard.params)
  );
  const claimIndex = claim ? statements.length : -1;
  if (claim) {
    statements.push(claimConsumeStatement(
      env,
      claim,
      'salary_advance_requests',
      'approved',
      adminId,
      decidedAt
    ));
  }
  const results = await env.DB.batch(statements);
  if (
    mutationCount(results[updateIndex]) !== 1
    || (claim && mutationCount(results[claimIndex]) !== 1)
  ) {
    return decisionFailure(env, claim);
  }
  return { ok: true, row: found, store };
}

export async function rejectSalaryAdvanceRequest(env, storeId, requestId, adminId, reason, claim = null) {
  const found = await env.DB.prepare(`SELECT * FROM salary_advance_requests WHERE store_id = ? AND request_id = ?`).bind(storeId, requestId).first();
  if (!found) return { ok: false };
  if (found.status !== 'pending') {
    return { ok: false, error: 'already_decided' };
  }
  const decidedAt = nowIso();
  claim = claimAt(claim, decidedAt);
  const statements = [
    pendingRequestAuditStatement(
      env,
      'salary_advance_requests',
      storeId,
      requestId,
      adminId,
      'reject_salary_advance',
      { reason, ...found },
      decidedAt,
      claim
    ),
  ];
  const guard = claimGuard(claim);
  statements.push(
    env.DB.prepare(`
      UPDATE salary_advance_requests
      SET status = 'rejected', decided_at = ?, admin_id = ?, reject_reason = ?
      WHERE store_id = ? AND request_id = ? AND status = 'pending'
        ${guard.sql}
    `).bind(decidedAt, adminId, reason, storeId, requestId, ...guard.params)
  );
  const updateIndex = statements.length - 1;
  const claimIndex = claim ? statements.length : -1;
  if (claim) {
    statements.push(claimConsumeStatement(
      env,
      claim,
      'salary_advance_requests',
      'rejected',
      adminId,
      decidedAt
    ));
  }
  const results = await env.DB.batch(statements);
  if (
    mutationCount(results[updateIndex]) !== 1
    || (claim && mutationCount(results[claimIndex]) !== 1)
  ) {
    return decisionFailure(env, claim);
  }
  return { ok: true, row: found, reason };
}

export async function approveLeaveRequest(env, storeId, requestId, adminId, claim = null) {
  const found = await env.DB.prepare(`SELECT * FROM leave_requests WHERE store_id = ? AND request_id = ?`).bind(storeId, requestId).first();
  if (!found) return { ok: false };
  if (!['pending', 'approved'].includes(found.status)) {
    return { ok: false, error: 'already_decided' };
  }
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
  if (found.status === 'approved' && !absence) {
    return { ok: false, error: 'already_decided' };
  }

  const decidedAt = nowIso();
  claim = claimAt(claim, decidedAt);
  const statements = [];
  const guard = claimGuard(claim);
  let leaveUpdateIndex = -1;
  if (found.status === 'pending') {
    leaveUpdateIndex = statements.length;
    statements.push(env.DB.prepare(`
      UPDATE leave_requests SET status = 'approved', decided_at = ?, admin_id = ?
      WHERE store_id = ? AND request_id = ? AND status = 'pending'
        ${guard.sql}
    `).bind(decidedAt, adminId, storeId, requestId, ...guard.params));
  }
  let absenceUpdateIndex = -1;
  if (absence) {
    absenceUpdateIndex = statements.length + 1;
    statements.push(...absenceCancellationStatements(
      env,
      storeId,
      absence.request_id,
      decidedAt,
      adminId,
      claim
    ));
  }
  const claimIndex = claim ? statements.length : -1;
  if (claim) {
    statements.push(claimConsumeStatement(
      env,
      claim,
      'leave_requests',
      'approved',
      adminId,
      decidedAt
    ));
  }
  const results = await env.DB.batch(statements);
  if (
    found.status === 'pending'
    && (
      mutationCount(results[leaveUpdateIndex]) !== 1
      || (claim && mutationCount(results[claimIndex]) !== 1)
    )
  ) {
    return decisionFailure(env, claim);
  }
  if (found.status === 'pending') await audit(env, storeId, adminId, 'approve_leave', requestId, found);
  if (absence && mutationCount(results[absenceUpdateIndex]) === 1) {
    await audit(env, storeId, adminId, 'cancel_absence_for_leave', absence.request_id, absence);
  }
  return { ok: true, row: found };
}

export function absenceCancellationStatements(env, storeId, requestId, decidedAt, adminId, claim = null) {
  const guard = claimGuard(claim);
  return [
    env.DB.prepare(`
      UPDATE income_records SET fine = 0
      WHERE store_id = ? AND source = 'attendance_absence'
        AND record_id = (
          SELECT income_record_id FROM absence_fine_requests
          WHERE request_id = ? AND status = 'approved'
            ${guard.sql}
        )
    `).bind(storeId, requestId, ...guard.params),
    env.DB.prepare(`
      UPDATE absence_fine_requests
      SET status = 'cancelled', cancellation_reason = 'Approved leave',
          decided_at = COALESCE(decided_at, ?), admin_id = COALESCE(admin_id, ?)
      WHERE request_id = ? AND status IN ('pending', 'approved', 'rejected')
        ${guard.sql}
    `).bind(decidedAt, adminId, requestId, ...guard.params)
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

export async function rejectLeaveRequest(env, storeId, requestId, adminId, reason, claim = null) {
  const found = await env.DB.prepare(`SELECT * FROM leave_requests WHERE store_id = ? AND request_id = ?`).bind(storeId, requestId).first();
  if (!found) return { ok: false };
  if (found.status !== 'pending') {
    return { ok: false, error: 'already_decided' };
  }
  const decidedAt = nowIso();
  claim = claimAt(claim, decidedAt);
  const guard = claimGuard(claim);
  const updateStatement = env.DB.prepare(`
    UPDATE leave_requests
    SET status = 'rejected', decided_at = ?, admin_id = ?, reject_reason = ?
    WHERE store_id = ? AND request_id = ? AND status = 'pending'
      ${guard.sql}
  `).bind(decidedAt, adminId, reason, storeId, requestId, ...guard.params);
  let updateResult;
  let claimResult = null;
  if (claim) {
    [updateResult, claimResult] = await env.DB.batch([
      updateStatement,
      claimConsumeStatement(
        env,
        claim,
        'leave_requests',
        'rejected',
        adminId,
        decidedAt
      )
    ]);
  } else {
    updateResult = await updateStatement.run();
  }
  if (
    mutationCount(updateResult) !== 1
    || (claim && mutationCount(claimResult) !== 1)
  ) {
    return decisionFailure(env, claim);
  }
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
