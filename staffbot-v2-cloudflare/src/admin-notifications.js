import { logEvent } from './audit.js';
import { adminIds, manageBaseUrl } from './security.js';
import { sendMessage } from './telegram-client.js';

const MANAGE_TASK_TYPES = new Set([
  'income',
  'leave',
  'absence',
  'advance',
  'payroll'
]);

function normalizedTask(task) {
  const taskType = String(task && task.task_type || '');
  const taskId = String(task && task.task_id || '');
  const storeId = String(task && task.store_id || '');
  if (!MANAGE_TASK_TYPES.has(taskType)) {
    throw new TypeError('unsupported manage task type');
  }
  if (!taskId || !storeId) {
    throw new TypeError('manage task id and store are required');
  }
  return { task_type: taskType, task_id: taskId, store_id: storeId };
}

export function manageTaskUrl(env, task) {
  const value = normalizedTask(task);
  const query = new URLSearchParams({ store: value.store_id });
  return `${manageBaseUrl(env)}/manage/tasks/${
    encodeURIComponent(value.task_type)
  }/${encodeURIComponent(value.task_id)}?${query.toString()}`;
}

export function manageTaskKeyboard(env, task) {
  return {
    inline_keyboard: [[{
      text: '去处理',
      url: manageTaskUrl(env, task)
    }]]
  };
}

async function storeAdminRecipients(env, storeId) {
  const rows = await env.DB.prepare(`
    SELECT telegram_id FROM store_members
    WHERE store_id = ? AND status = 'active' AND role IN ('admin', 'owner')
  `).bind(storeId).all();
  return new Set([
    ...(rows.results || []).map((row) => String(row.telegram_id)),
    ...adminIds(env)
  ]);
}

async function logDeliveryFailure(env, task, adminId, code) {
  try {
    await logEvent(env, 'warn', 'manage_task_notification_failed', {
      store_id: task.store_id,
      task_type: task.task_type,
      task_id: task.task_id,
      admin_id: String(adminId),
      code
    });
  } catch {
    // Notification delivery must remain isolated per recipient, including logs.
  }
}

export async function notifyStoreAdminsOfTask(
  env,
  storeId,
  task,
  text
) {
  const value = normalizedTask(task);
  if (value.store_id !== String(storeId)) {
    throw new Error('manage task store mismatch');
  }
  const keyboard = manageTaskKeyboard(env, value);
  const recipients = await storeAdminRecipients(env, value.store_id);
  const summary = { attempted: recipients.size, sent: 0, failed: 0 };
  for (const adminId of recipients) {
    let result;
    try {
      result = await sendMessage(env, adminId, String(text), keyboard);
    } catch {
      result = null;
    }
    if (result && result.ok === true) {
      summary.sent += 1;
      continue;
    }
    summary.failed += 1;
    await logDeliveryFailure(
      env,
      value,
      adminId,
      result && result.description === 'staging_recipient_blocked'
        ? 'staging_recipient_blocked'
        : 'telegram_delivery_failed'
    );
  }
  return summary;
}
