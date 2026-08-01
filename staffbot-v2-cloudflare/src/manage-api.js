import {
  requireAdminSession,
  requireManageMutation
} from './admin-auth.js';
import { json, readJson } from './http.js';
import {
  listManageStores,
  listManageTasks,
  manageTaskDetail
} from './manage-read-model.js';
import { isGlobalAdmin } from './security.js';
import { isStoreAdmin } from './stores.js';
import {
  claimTask,
  forceTakeoverTask,
  releaseTaskClaim,
  renewTaskClaim
} from './task-claims.js';

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
