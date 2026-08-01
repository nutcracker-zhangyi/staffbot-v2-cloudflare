import {
  approvalResultNotification,
  approveAbsenceFineRequest,
  approveIncomeRequest,
  approveLeaveRequest,
  approveSalaryAdvanceRequest,
  rejectAbsenceFineRequest,
  rejectIncomeRequest,
  rejectLeaveRequest,
  rejectSalaryAdvanceRequest
} from './approvals.js';
import { audit, logError } from './audit.js';
import {
  requireAdminSession,
  requireManageMutation
} from './admin-auth.js';
import { json, readJson } from './http.js';
import {
  listManageStores,
  listManageTasks,
  listManagePayroll,
  loadPayrollDossier,
  manageApprovalDetail,
  manageTaskDetail
} from './manage-read-model.js';
import {
  createOrResumeDraftAttempt,
  saveAttemptSplit,
  submitPaymentAttempt
} from './payroll-payment-attempts.js';
import { deliverPaymentAttempt } from './payroll-notifications.js';
import { readPayrollPaymentQr } from './payroll-payment-qr.js';
import {
  deleteBrowserDraftProof,
  readPayrollProof,
  storeBrowserDraftProof
} from './payroll-proofs.js';
import { isGlobalAdmin } from './security.js';
import { isStoreAdmin } from './stores.js';
import {
  claimTask,
  forceTakeoverTask,
  requireActiveTaskClaim,
  releaseTaskClaim,
  renewTaskClaim
} from './task-claims.js';
import {
  sendMessage,
  telegramErrorSummary
} from './telegram-client.js';

const MAX_PROOF_MULTIPART_BYTES = 10 * 1024 * 1024 + 64 * 1024;

async function boundedProofMultipartRequest(request) {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      throw new TypeError('invalid payroll proof body');
    }
    if (Number(contentLength) > MAX_PROOF_MULTIPART_BYTES) {
      throw new RangeError('payroll proof body is too large');
    }
  }
  if (!request.body || typeof request.body.getReader !== 'function') {
    throw new TypeError('invalid payroll proof body');
  }

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new TypeError('invalid payroll proof body');
      }
      if (total + value.byteLength > MAX_PROOF_MULTIPART_BYTES) {
        try {
          await reader.cancel('payroll proof body is too large');
        } catch {
          // The size result remains authoritative even if cancellation fails.
        }
        throw new RangeError('payroll proof body is too large');
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch (error) {
    if (error instanceof RangeError) throw error;
    try {
      await reader.cancel('invalid payroll proof body');
    } catch {
      // Preserve the stable client error when an errored stream cannot cancel.
    }
    throw new TypeError('invalid payroll proof body');
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A cancelled or errored body can already have released its reader.
    }
  }
  if (total === 0) throw new TypeError('invalid payroll proof body');

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  return new Request(request.url, {
    method: request.method,
    headers,
    body
  });
}

export async function handleManageApi(request, env, url, ctx) {
  try {
    const session = await requireAdminSession(request, env);
    if (!session) return json({ ok: false, error: 'unauthorized' }, 401);
    if (request.method !== 'GET' && !requireManageMutation(request, session)) {
      return json({ ok: false, error: 'forbidden' }, 403);
    }

    if (request.method === 'GET' && url.pathname === '/api/manage/session') {
      return json({
        ok: true,
        telegram_id: session.telegram_id,
        global_admin: isGlobalAdmin(env, session.telegram_id),
        csrf_token: session.csrf_token
      });
    }
    if (request.method === 'GET' && url.pathname === '/api/manage/stores') {
      return json({
        ok: true,
        stores: await listManageStores(env, session.telegram_id)
      });
    }
    if (request.method === 'GET' && url.pathname === '/api/manage/tasks') {
      const filters = {
        store_id: url.searchParams.get('store_id') || '',
        type: url.searchParams.get('type') || ''
      };
      if (filters.store_id && !await isStoreAdmin(env, session.telegram_id, filters.store_id)) {
        return json({ ok: false, error: 'forbidden' }, 403);
      }
      return json({
        ok: true,
        tasks: await listManageTasks(env, session.telegram_id, filters, new Date())
      });
    }

    const parts = url.pathname.split('/').filter(Boolean);
    if (
      parts[0] === 'api'
      && parts[1] === 'manage'
      && parts[2] === 'stores'
      && parts[4] === 'payroll'
    ) {
      return await handleManagePayroll(
        request,
        env,
        session,
        parts.map((part) => decodeURIComponent(part))
      );
    }
    if (
      parts[0] === 'api'
      && parts[1] === 'manage'
      && parts[2] === 'stores'
      && parts[4] === 'approvals'
    ) {
      return await handleManageApproval(
        request,
        env,
        session,
        parts.map((part) => decodeURIComponent(part))
      );
    }
    if (
      request.method !== 'POST'
      || parts.length !== 6
      || parts[0] !== 'api'
      || parts[1] !== 'manage'
      || parts[2] !== 'tasks'
    ) {
      return json({ ok: false, error: 'not_found' }, 404);
    }
    const taskType = decodeURIComponent(parts[3]);
    const taskId = decodeURIComponent(parts[4]);
    const action = decodeURIComponent(parts[5]);
    const task = await manageTaskDetail(env, session.telegram_id, {
      task_type: taskType,
      task_id: taskId
    });
    if (!task || !await isStoreAdmin(env, session.telegram_id, task.store_id)) {
      return json({ ok: false, error: 'forbidden' }, 403);
    }

    const now = new Date();
    let claim;
    if (action === 'claim') {
      claim = await claimTask(env, session.telegram_id, task, now);
    } else if (action === 'renew') {
      claim = await renewTaskClaim(env, session.telegram_id, task, now);
    } else if (action === 'release') {
      await releaseTaskClaim(env, session.telegram_id, task, now);
      claim = null;
    } else if (action === 'takeover') {
      const body = await readJson(request);
      claim = await forceTakeoverTask(
        env,
        session.telegram_id,
        task,
        String(body.reason || ''),
        now
      );
    } else {
      return json({ ok: false, error: 'not_found' }, 404);
    }
    return json({ ok: true, claim });
  } catch (error) {
    if (error instanceof URIError) return json({ ok: false, error: 'invalid_id' }, 400);
    if (error && error.message === 'forbidden') {
      return json({ ok: false, error: 'forbidden' }, 403);
    }
    if (error && ['task_claimed', 'task_claim_required'].includes(error.message)) {
      return json({ ok: false, error: error.message }, 409);
    }
    throw error;
  }
}

async function handleManagePayroll(request, env, session, parts) {
  const storeId = parts[3];
  if (!await isStoreAdmin(env, session.telegram_id, storeId)) {
    return json({ ok: false, error: 'forbidden' }, 403);
  }
  if (request.method === 'GET' && parts.length === 5) {
    return json({
      ok: true,
      payroll: await listManagePayroll(env, session.telegram_id, storeId)
    });
  }
  if (
    request.method === 'GET'
    && parts.length === 7
    && parts[5] === 'proofs'
    && parts[6]
  ) {
    return readPayrollProof(
      env,
      {
        telegram_id: session.telegram_id,
        store_id: storeId,
        access: 'admin'
      },
      parts[6]
    );
  }

  const payrollId = parts[5] || '';
  if (!payrollId) return json({ ok: false, error: 'not_found' }, 404);
  const dossier = await loadPayrollDossier(
    env,
    session.telegram_id,
    storeId,
    payrollId
  );
  if (!dossier) return json({ ok: false, error: 'not_found' }, 404);

  if (request.method === 'GET' && parts.length === 6) {
    return json(dossier);
  }
  if (
    request.method === 'GET'
    && parts.length === 7
    && parts[6] === 'usdt-qr'
  ) {
    return readPayrollPaymentQr(
      env,
      { telegram_id: session.telegram_id, store_id: storeId },
      payrollId
    );
  }
  if (
    request.method === 'POST'
    && parts.length === 8
    && parts[6] === 'attempts'
    && parts[7] === 'draft'
  ) {
    try {
      const attempt = await createOrResumeDraftAttempt(
        env,
        session.telegram_id,
        payrollId,
        new Date()
      );
      return json({ ok: true, attempt });
    } catch (error) {
      return managePayrollError(error);
    }
  }
  if (
    request.method === 'PUT'
    && parts.length === 9
    && parts[6] === 'attempts'
    && parts[8] === 'split'
  ) {
    const attemptId = parts[7];
    const belongs = dossier.attempts.some(
      (attempt) => attempt.attempt_id === attemptId
    );
    if (!belongs) return json({ ok: false, error: 'not_found' }, 404);
    const body = await readJson(request);
    try {
      const attempt = await saveAttemptSplit(
        env,
        session.telegram_id,
        attemptId,
        {
          bank_micros: body.bank_micros,
          usdt_micros: body.usdt_micros,
          cash_micros: body.cash_micros
        },
        new Date()
      );
      return json({ ok: true, attempt });
    } catch (error) {
      return managePayrollError(error);
    }
  }
  if (
    request.method === 'POST'
    && parts.length === 9
    && parts[6] === 'attempts'
    && parts[8] === 'submit'
  ) {
    const attemptId = parts[7];
    if (!dossier.attempts.some((attempt) => attempt.attempt_id === attemptId)) {
      return json({ ok: false, error: 'not_found' }, 404);
    }
    const idempotencyKey = request.headers.get('idempotency-key');
    if (!idempotencyKey || !idempotencyKey.trim()
      || idempotencyKey.length > 256) {
      return json({ ok: false, error: 'invalid_idempotency_key' }, 400);
    }
    let attempt;
    try {
      attempt = await submitPaymentAttempt(
        env,
        session.telegram_id,
        attemptId,
        idempotencyKey,
        new Date()
      );
    } catch (error) {
      return managePayrollError(error);
    }
    if (attempt.status !== 'submitted') {
      return json({
        ok: true,
        attempt,
        notification: { status: 'sent', retryable: false }
      });
    }
    try {
      await deliverPaymentAttempt(
        env,
        session.telegram_id,
        attemptId,
        new Date()
      );
      return json({
        ok: true,
        attempt,
        notification: { status: 'sent', retryable: false }
      });
    } catch {
      return json({
        ok: true,
        attempt,
        notification: { status: 'failed', retryable: true }
      });
    }
  }
  if (
    request.method === 'POST'
    && parts.length === 10
    && parts[6] === 'attempts'
    && parts[8] === 'notify'
    && parts[9] === 'retry'
  ) {
    const attemptId = parts[7];
    if (!dossier.attempts.some((attempt) => attempt.attempt_id === attemptId)) {
      return json({ ok: false, error: 'not_found' }, 404);
    }
    try {
      await deliverPaymentAttempt(
        env,
        session.telegram_id,
        attemptId,
        new Date()
      );
      return json({
        ok: true,
        notification: { status: 'sent', retryable: false }
      });
    } catch (error) {
      const message = String(error && error.message || '');
      if (message.includes('conflict')
        || message.includes('delivery in progress')) {
        return managePayrollError(error);
      }
      return json({
        ok: false,
        notification: { status: 'failed', retryable: true }
      }, 502);
    }
  }
  if (
    request.method === 'POST'
    && parts.length === 9
    && parts[6] === 'attempts'
    && parts[8] === 'proofs'
  ) {
    const attemptId = parts[7];
    if (!dossier.attempts.some((attempt) => attempt.attempt_id === attemptId)) {
      return json({ ok: false, error: 'not_found' }, 404);
    }
    try {
      const multipartRequest = await boundedProofMultipartRequest(request);
      let form;
      try {
        form = await multipartRequest.formData();
      } catch (error) {
        const invalid = new TypeError('invalid payroll proof body');
        invalid.cause = error;
        throw invalid;
      }
      const proof = await storeBrowserDraftProof(
        env,
        session.telegram_id,
        attemptId,
        form.get('method'),
        form.get('proof')
      );
      return json({ ok: true, proof: manageProof(proof) });
    } catch (error) {
      return managePayrollError(error);
    }
  }
  if (
    request.method === 'DELETE'
    && parts.length === 10
    && parts[6] === 'attempts'
    && parts[8] === 'proofs'
    && parts[9]
  ) {
    const attemptId = parts[7];
    const attempt = dossier.attempts.find(
      (item) => item.attempt_id === attemptId
    );
    if (!attempt || !attempt.proofs.some(
      (proof) => proof.proof_id === parts[9]
    )) {
      return json({ ok: false, error: 'not_found' }, 404);
    }
    try {
      await deleteBrowserDraftProof(
        env,
        session.telegram_id,
        parts[9],
        new Date()
      );
      return json({ ok: true });
    } catch (error) {
      return managePayrollError(error);
    }
  }
  return json({ ok: false, error: 'not_found' }, 404);
}

function manageProof(proof) {
  return {
    proof_id: String(proof.proof_id),
    attempt_id: String(proof.attempt_id),
    method: String(proof.method),
    file_name: proof.file_name ? String(proof.file_name) : null,
    mime_type: String(proof.mime_type),
    size_bytes: Number(proof.size_bytes),
    sort_order: Number(proof.sort_order),
    uploaded_by: String(proof.uploaded_by),
    uploaded_at: String(proof.uploaded_at)
  };
}

function managePayrollError(error) {
  const message = String(error && error.message || '');
  if (message.includes('storage is not configured')) {
    return json({ ok: false, error: 'storage_not_configured' }, 503);
  }
  if (message === 'proof method has no payment') {
    return json({ ok: false, error: 'proof_method_not_payable' }, 409);
  }
  if (error instanceof RangeError && message.includes('too large')) {
    return json({ ok: false, error: 'proof_too_large' }, 413);
  }
  if (error instanceof RangeError && message.includes('proof limit')) {
    return json({ ok: false, error: 'proof_limit_reached' }, 409);
  }
  if (error instanceof TypeError && message.includes('proof')) {
    return json({ ok: false, error: 'invalid_proof' }, 400);
  }
  if (error instanceof RangeError || error instanceof TypeError) {
    return json({ ok: false, error: 'invalid_payroll_split' }, 400);
  }
  if (message.includes('not found')) {
    return json({ ok: false, error: 'not_found' }, 404);
  }
  if (message.includes('permission') || message === 'forbidden') {
    return json({ ok: false, error: 'forbidden' }, 403);
  }
  if (message === 'task_claim_required'
    || message.includes('conflict')
    || message.includes('delivery in progress')
    || message.includes('not editable')) {
    return json({ ok: false, error: message }, 409);
  }
  if (message.includes('not accepting')) {
    return json({ ok: false, error: 'invalid_payroll_state' }, 409);
  }
  throw error;
}

async function handleManageApproval(request, env, session, parts) {
  const storeId = parts[3];
  const type = parts[5];
  const requestId = parts[6];
  const detail = await manageApprovalDetail(
    env,
    session.telegram_id,
    storeId,
    type,
    requestId
  );
  if (!detail) return json({ ok: false, error: 'not_found' }, 404);

  if (request.method === 'GET' && parts.length === 7) {
    return json(detail);
  }
  if (request.method !== 'POST') {
    return json({ ok: false, error: 'not_found' }, 404);
  }
  if (parts.length === 9 && parts[7] === 'notify' && parts[8] === 'retry') {
    if (detail.request.status === 'pending') {
      return json({ ok: false, error: 'decision_required' }, 409);
    }
    const notification = await approvalResultNotification(
      env,
      storeId,
      type,
      requestId
    );
    if (!notification) return json({ ok: false, error: 'not_found' }, 404);
    if (notification.error) {
      return json({ ok: false, error: notification.error }, 409);
    }
    const retryClaimed = await claimApprovalNotificationRetry(
      env,
      session.telegram_id,
      storeId,
      type,
      requestId
    );
    if (!retryClaimed) {
      return existingApprovalNotificationResult(
        env,
        storeId,
        type,
        requestId
      );
    }
    return deliverApprovalNotification(
      env,
      session.telegram_id,
      storeId,
      type,
      requestId,
      true,
      notification
    );
  }
  if (parts.length !== 8 || !['approve', 'reject'].includes(parts[7])) {
    return json({ ok: false, error: 'not_found' }, 404);
  }

  const action = parts[7];
  let reason = '';
  if (action === 'reject') {
    const body = await readJson(request);
    reason = String(body.reason || '').trim();
    if (!reason) {
      return json({ ok: false, error: 'rejection_reason_required' }, 400);
    }
  }
  if (detail.request.status !== 'pending') {
    return json({ ok: false, error: 'already_decided' }, 409);
  }

  const checkedAt = new Date();
  const activeClaim = await requireActiveTaskClaim(
    env,
    session.telegram_id,
    detail.task,
    checkedAt
  );
  const claim = {
    ...activeClaim,
    checked_at: checkedAt.toISOString()
  };
  const result = await decideApproval(
    env,
    storeId,
    type,
    requestId,
    session.telegram_id,
    action,
    reason,
    claim
  );
  if (!result.ok) {
    return json({
      ok: false,
      error: result.error || 'already_decided'
    }, 409);
  }

  return deliverApprovalNotification(
    env,
    session.telegram_id,
    storeId,
    type,
    requestId,
    false
  );
}

function decideApproval(env, storeId, type, requestId, adminId, action, reason, claim) {
  if (type === 'income') {
    return action === 'approve'
      ? approveIncomeRequest(env, storeId, requestId, adminId, claim)
      : rejectIncomeRequest(env, storeId, requestId, adminId, reason, claim);
  }
  if (type === 'leave') {
    return action === 'approve'
      ? approveLeaveRequest(env, storeId, requestId, adminId, claim)
      : rejectLeaveRequest(env, storeId, requestId, adminId, reason, claim);
  }
  if (type === 'absence') {
    return action === 'approve'
      ? approveAbsenceFineRequest(env, requestId, adminId, storeId, claim)
      : rejectAbsenceFineRequest(env, requestId, adminId, reason, storeId, claim);
  }
  if (type === 'advance') {
    return action === 'approve'
      ? approveSalaryAdvanceRequest(env, storeId, requestId, adminId, claim)
      : rejectSalaryAdvanceRequest(env, storeId, requestId, adminId, reason, claim);
  }
  return Promise.resolve({ ok: false, error: 'not_found' });
}

async function deliverApprovalNotification(
  env,
  adminId,
  storeId,
  type,
  requestId,
  retried,
  preparedNotification = null
) {
  const notification = preparedNotification || await approvalResultNotification(
    env,
    storeId,
    type,
    requestId
  );
  if (!notification) return json({ ok: false, error: 'not_found' }, 404);
  if (notification.error) {
    return json({ ok: false, error: notification.error }, 409);
  }

  let result = null;
  let failure = null;
  try {
    result = await sendMessage(
      env,
      notification.recipient,
      notification.text
    );
    if (!result || !result.ok) {
      failure = new Error(telegramErrorSummary(result).description);
    }
  } catch (error) {
    failure = error;
  }

  if (failure) {
    const telegram = telegramErrorSummary(result, failure);
    await logError(env, 'approval_notification_failed', failure, {
      store_id: storeId,
      telegram_id: notification.recipient,
      task_type: type,
      task_id: requestId,
      decision: notification.decision,
      error_code: telegram.error_code,
      description: telegram.description
    });
    await audit(
      env,
      storeId,
      adminId,
      'approval_notification_failed',
      requestId,
      {
        task_type: type,
        recipient: notification.recipient,
        decision: notification.decision,
        telegram
      }
    );
    return json({
      ok: !retried,
      notification: { status: 'failed', retryable: true }
    }, retried ? 502 : 200);
  }

  if (retried) {
    await audit(
      env,
      storeId,
      adminId,
      'approval_notification_retried',
      requestId,
      {
        task_type: type,
        recipient: notification.recipient,
        decision: notification.decision
      }
    );
  } else {
    await audit(
      env,
      storeId,
      adminId,
      'approval_notification_sent',
      requestId,
      {
        task_type: type,
        recipient: notification.recipient,
        decision: notification.decision
      }
    );
  }
  return json({
    ok: true,
    notification: { status: 'sent', retryable: false }
  });
}

const NOTIFICATION_RETRY_LEASE_MS = 15 * 60 * 1000;
const NOTIFICATION_STATE_ACTIONS = [
  'approval_notification_failed',
  'approval_notification_retry_claimed',
  'approval_notification_retried',
  'approval_notification_sent'
];

async function approvalNotificationState(env, storeId, type, requestId) {
  const placeholders = NOTIFICATION_STATE_ACTIONS.map(() => '?').join(', ');
  return env.DB.prepare(`
    SELECT action, details_json, created_at
    FROM admin_audit_logs
    WHERE store_id = ? AND target_id = ?
      AND action IN (${placeholders})
      AND json_extract(details_json, '$.task_type') = ?
    ORDER BY id DESC
    LIMIT 1
  `).bind(
    storeId,
    requestId,
    ...NOTIFICATION_STATE_ACTIONS,
    type
  ).first();
}

async function claimApprovalNotificationRetry(
  env,
  adminId,
  storeId,
  type,
  requestId
) {
  const claimedAt = new Date().toISOString();
  const staleBefore = new Date(
    new Date(claimedAt).getTime() - NOTIFICATION_RETRY_LEASE_MS
  ).toISOString();
  const details = JSON.stringify({ task_type: type });
  const result = await env.DB.prepare(`
    INSERT INTO admin_audit_logs (
      store_id, admin_id, action, target_id, details_json, created_at
    )
    SELECT ?, ?, 'approval_notification_retry_claimed', ?, ?, ?
    WHERE COALESCE((
      SELECT CASE
        WHEN action = 'approval_notification_failed' THEN 1
        WHEN action = 'approval_notification_retry_claimed' AND created_at <= ? THEN 1
        ELSE 0
      END
      FROM admin_audit_logs
      WHERE store_id = ? AND target_id = ?
        AND action IN (
          'approval_notification_failed',
          'approval_notification_retry_claimed',
          'approval_notification_retried',
          'approval_notification_sent'
        )
        AND json_extract(details_json, '$.task_type') = ?
      ORDER BY id DESC
      LIMIT 1
    ), 0) = 1
  `).bind(
    storeId,
    adminId,
    requestId,
    details,
    claimedAt,
    staleBefore,
    storeId,
    requestId,
    type
  ).run();
  return Number(result && result.meta ? result.meta.changes : 0) === 1;
}

async function existingApprovalNotificationResult(env, storeId, type, requestId) {
  const state = await approvalNotificationState(env, storeId, type, requestId);
  if (state && state.action === 'approval_notification_retried') {
    return json({
      ok: true,
      notification: { status: 'sent', retryable: false }
    });
  }
  if (state && state.action === 'approval_notification_retry_claimed') {
    return json({
      ok: true,
      notification: { status: 'retrying', retryable: false }
    });
  }
  return json({ ok: false, error: 'notification_retry_not_available' }, 409);
}
