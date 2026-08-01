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
  manageApprovalDetail,
  manageTaskDetail
} from './manage-read-model.js';
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
    return deliverApprovalNotification(
      env,
      session.telegram_id,
      storeId,
      type,
      requestId,
      true
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

  await requireActiveTaskClaim(
    env,
    session.telegram_id,
    detail.task,
    new Date()
  );
  const result = await decideApproval(
    env,
    storeId,
    type,
    requestId,
    session.telegram_id,
    action,
    reason
  );
  if (!result.ok) {
    return json({
      ok: false,
      error: result.error || 'already_decided'
    }, 409);
  }

  await releaseTaskClaim(env, session.telegram_id, detail.task, new Date());
  return deliverApprovalNotification(
    env,
    session.telegram_id,
    storeId,
    type,
    requestId,
    false
  );
}

function decideApproval(env, storeId, type, requestId, adminId, action, reason) {
  if (type === 'income') {
    return action === 'approve'
      ? approveIncomeRequest(env, storeId, requestId, adminId)
      : rejectIncomeRequest(env, storeId, requestId, adminId, reason);
  }
  if (type === 'leave') {
    return action === 'approve'
      ? approveLeaveRequest(env, storeId, requestId, adminId)
      : rejectLeaveRequest(env, storeId, requestId, adminId, reason);
  }
  if (type === 'absence') {
    return action === 'approve'
      ? approveAbsenceFineRequest(env, requestId, adminId, storeId)
      : rejectAbsenceFineRequest(env, requestId, adminId, reason, storeId);
  }
  if (type === 'advance') {
    return action === 'approve'
      ? approveSalaryAdvanceRequest(env, storeId, requestId, adminId)
      : rejectSalaryAdvanceRequest(env, storeId, requestId, adminId, reason);
  }
  return Promise.resolve({ ok: false, error: 'not_found' });
}

async function deliverApprovalNotification(
  env,
  adminId,
  storeId,
  type,
  requestId,
  retried
) {
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
