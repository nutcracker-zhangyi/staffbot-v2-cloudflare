import { isGlobalAdmin } from './security.js';
import { isStoreAdmin } from './stores.js';

const TASK_TYPES = ['payroll', 'absence', 'leave', 'advance', 'income'];

export async function listManageStores(env, adminId) {
  const globalAdmin = isGlobalAdmin(env, adminId);
  const rows = await env.DB.prepare(`
    SELECT DISTINCT s.store_id, s.name, s.currency, s.timezone
    FROM stores s
    LEFT JOIN store_members m
      ON m.store_id = s.store_id
      AND m.telegram_id = ?
      AND m.status = 'active'
      AND m.role IN ('admin', 'owner')
    WHERE s.status = 'active' AND (? = 1 OR m.telegram_id IS NOT NULL)
    ORDER BY s.name, s.store_id
  `).bind(String(adminId), globalAdmin ? 1 : 0).all();
  return (rows.results || []).map((row) => ({
    store_id: String(row.store_id),
    name: String(row.name),
    currency: String(row.currency),
    timezone: String(row.timezone)
  }));
}

export async function listManageTasks(env, adminId, filters = {}, now = new Date()) {
  const stores = await listManageStores(env, adminId);
  const requestedStoreId = String(filters.store_id || '');
  const storeIds = stores
    .map((store) => String(store.store_id))
    .filter((storeId) => !requestedStoreId || storeId === requestedStoreId);
  if (storeIds.length === 0) return [];

  const requestedType = String(filters.type || '');
  const taskTypes = requestedType ? TASK_TYPES.filter((type) => type === requestedType) : TASK_TYPES;
  if (taskTypes.length === 0) return [];

  const placeholders = storeIds.map(() => '?').join(', ');
  const checkedAt = new Date(now).toISOString();
  const groups = await Promise.all(taskTypes.map(async (taskType) => {
    const statement = taskStatement(env, taskType, placeholders);
    const result = await statement.bind(...storeIds).all();
    return result.results || [];
  }));

  return groups.flat().map((row) => normalizeTaskRow(row, checkedAt)).sort((left, right) => {
    if (left.urgency !== right.urgency) return right.urgency - left.urgency;
    if (left.submitted_at !== right.submitted_at) {
      return left.submitted_at < right.submitted_at ? -1 : 1;
    }
    if (left.task_id === right.task_id) return 0;
    return left.task_id < right.task_id ? -1 : 1;
  });
}

export async function manageTaskDetail(env, adminId, task) {
  const taskType = String(task && task.task_type || '');
  const taskId = String(task && task.task_id || '');
  if (!TASK_TYPES.includes(taskType) || !taskId) return null;
  const tasks = await listManageTasks(env, adminId, { type: taskType }, new Date());
  return tasks.find((item) => item.task_id === taskId) || null;
}

export async function manageApprovalDetail(env, adminId, storeId, type, id) {
  const approvalType = String(type || '');
  const requestId = String(id || '');
  const expectedStoreId = String(storeId || '');
  const source = approvalSources()[approvalType];
  if (!source || !requestId || !expectedStoreId) return null;
  if (!await isStoreAdmin(env, adminId, expectedStoreId)) return null;

  const row = await env.DB.prepare(`
    SELECT
      t.*,
      s.name AS store_name,
      s.currency AS store_currency,
      s.timezone AS store_timezone,
      COALESCE(
        NULLIF(m.display_name, ''),
        NULLIF(u.name, ''),
        NULLIF(u.username, ''),
        t.telegram_id
      ) AS employee_name,
      COALESCE(p.language, 'zh') AS employee_language,
      c.claimed_by,
      c.claimed_at,
      c.lease_expires_at
    FROM ${source.table} t
    JOIN stores s ON s.store_id = t.store_id AND s.status = 'active'
    LEFT JOIN store_members m
      ON m.store_id = t.store_id AND m.telegram_id = t.telegram_id
    LEFT JOIN users u ON u.telegram_id = t.telegram_id
    LEFT JOIN user_preferences p ON p.telegram_id = t.telegram_id
    LEFT JOIN admin_task_claims c
      ON c.task_type = ? AND c.task_id = t.${source.id}
      AND c.store_id = t.store_id
    WHERE t.store_id = ? AND t.${source.id} = ?
  `).bind(approvalType, expectedStoreId, requestId).first();
  if (!row) return null;

  const historyResult = await env.DB.prepare(`
    SELECT id, admin_id, action, details_json, created_at
    FROM admin_audit_logs
    WHERE store_id = ? AND target_id = ?
    ORDER BY created_at, id
  `).bind(expectedStoreId, requestId).all();
  const checkedAt = new Date().toISOString();
  const amount = Number(row[source.amount] || 0);
  return {
    task: {
      task_type: approvalType,
      task_id: requestId,
      store_id: expectedStoreId,
      store_name: String(row.store_name),
      employee_id: String(row.telegram_id),
      employee_name: String(row.employee_name),
      amount_micros: Math.round(amount * 1000000),
      currency: String(row.store_currency),
      business_date: String(row[source.businessDate] || '').slice(0, 10),
      submitted_at: String(row[source.submittedAt]),
      status: String(row.status),
      claim: row.claimed_by ? {
        claimed_by: String(row.claimed_by),
        claimed_at: String(row.claimed_at),
        lease_expires_at: String(row.lease_expires_at),
        active: String(row.lease_expires_at) > checkedAt
      } : null
    },
    request: source.facts(row),
    employee: {
      telegram_id: String(row.telegram_id),
      display_name: String(row.employee_name),
      language: String(row.employee_language)
    },
    store: {
      store_id: expectedStoreId,
      name: String(row.store_name),
      currency: String(row.store_currency),
      timezone: String(row.store_timezone)
    },
    attachments: [],
    history: (historyResult.results || []).map((item) => ({
      id: Number(item.id),
      admin_id: String(item.admin_id),
      action: String(item.action),
      details: parseDetails(item.details_json),
      created_at: String(item.created_at)
    }))
  };
}

function approvalSources() {
  return {
    income: {
      table: 'pending_income',
      id: 'request_id',
      amount: 'income',
      businessDate: 'submitted_at',
      submittedAt: 'submitted_at',
      facts: (row) => ({
        request_id: String(row.request_id),
        store_id: String(row.store_id),
        telegram_id: String(row.telegram_id),
        income: Number(row.income),
        commission_rate: Number(row.commission_rate),
        commission_income: Number(row.commission_income),
        fine: Number(row.fine),
        status: String(row.status),
        submitted_at: String(row.submitted_at),
        decided_at: row.decided_at ? String(row.decided_at) : null,
        admin_id: row.admin_id ? String(row.admin_id) : null,
        reject_reason: row.reject_reason ? String(row.reject_reason) : null
      })
    },
    leave: {
      table: 'leave_requests',
      id: 'request_id',
      amount: '',
      businessDate: 'leave_date',
      submittedAt: 'requested_at',
      facts: (row) => ({
        request_id: String(row.request_id),
        store_id: String(row.store_id),
        telegram_id: String(row.telegram_id),
        leave_date: String(row.leave_date),
        status: String(row.status),
        requested_at: String(row.requested_at),
        decided_at: row.decided_at ? String(row.decided_at) : null,
        admin_id: row.admin_id ? String(row.admin_id) : null,
        reject_reason: row.reject_reason ? String(row.reject_reason) : null
      })
    },
    absence: {
      table: 'absence_fine_requests',
      id: 'request_id',
      amount: 'fine',
      businessDate: 'business_date',
      submittedAt: 'created_at',
      facts: (row) => ({
        request_id: String(row.request_id),
        store_id: String(row.store_id),
        telegram_id: String(row.telegram_id),
        business_date: String(row.business_date),
        original_fine: Number(row.original_fine),
        fine: Number(row.fine),
        status: String(row.status),
        created_at: String(row.created_at),
        decided_at: row.decided_at ? String(row.decided_at) : null,
        admin_id: row.admin_id ? String(row.admin_id) : null,
        reject_reason: row.reject_reason ? String(row.reject_reason) : null,
        cancellation_reason: row.cancellation_reason
          ? String(row.cancellation_reason)
          : null
      })
    },
    advance: {
      table: 'salary_advance_requests',
      id: 'request_id',
      amount: 'amount',
      businessDate: 'requested_at',
      submittedAt: 'requested_at',
      facts: (row) => ({
        request_id: String(row.request_id),
        store_id: String(row.store_id),
        telegram_id: String(row.telegram_id),
        amount: Number(row.amount),
        status: String(row.status),
        requested_at: String(row.requested_at),
        decided_at: row.decided_at ? String(row.decided_at) : null,
        admin_id: row.admin_id ? String(row.admin_id) : null,
        reject_reason: row.reject_reason ? String(row.reject_reason) : null
      })
    }
  };
}

function parseDetails(value) {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
}

function taskStatement(env, taskType, placeholders) {
  const sources = {
    payroll: {
      table: 'payroll_disbursements',
      alias: 't',
      id: 't.payroll_id',
      amount: 't.amount_snapshot_micros',
      currency: 't.currency',
      businessDate: 't.scheduled_date',
      submittedAt: 't.created_at',
      statusWhere: "t.status IN ('disputed', 'awaiting_admin_payment')",
      urgency: "CASE WHEN t.status = 'disputed' THEN 600 ELSE 500 END"
    },
    absence: {
      table: 'absence_fine_requests',
      alias: 't',
      id: 't.request_id',
      amount: 'CAST(ROUND(t.fine * 1000000) AS INTEGER)',
      currency: 's.currency',
      businessDate: 't.business_date',
      submittedAt: 't.created_at',
      statusWhere: "t.status = 'pending'",
      urgency: '400'
    },
    leave: {
      table: 'leave_requests',
      alias: 't',
      id: 't.request_id',
      amount: '0',
      currency: 's.currency',
      businessDate: 't.leave_date',
      submittedAt: 't.requested_at',
      statusWhere: "t.status = 'pending'",
      urgency: '300'
    },
    advance: {
      table: 'salary_advance_requests',
      alias: 't',
      id: 't.request_id',
      amount: 'CAST(ROUND(t.amount * 1000000) AS INTEGER)',
      currency: 's.currency',
      businessDate: 'substr(t.requested_at, 1, 10)',
      submittedAt: 't.requested_at',
      statusWhere: "t.status = 'pending'",
      urgency: '200'
    },
    income: {
      table: 'pending_income',
      alias: 't',
      id: 't.request_id',
      amount: 'CAST(ROUND(t.income * 1000000) AS INTEGER)',
      currency: 's.currency',
      businessDate: 'substr(t.submitted_at, 1, 10)',
      submittedAt: 't.submitted_at',
      statusWhere: "t.status = 'pending'",
      urgency: '100'
    }
  };
  const source = sources[taskType];
  return env.DB.prepare(`
    SELECT
      '${taskType}' AS task_type,
      ${source.id} AS task_id,
      t.store_id,
      s.name AS store_name,
      t.telegram_id AS employee_id,
      COALESCE(
        NULLIF(m.display_name, ''),
        NULLIF(u.name, ''),
        NULLIF(u.username, ''),
        t.telegram_id
      ) AS employee_name,
      ${source.amount} AS amount_micros,
      ${source.currency} AS currency,
      ${source.businessDate} AS business_date,
      ${source.submittedAt} AS submitted_at,
      t.status,
      ${source.urgency} AS urgency,
      c.claimed_by,
      c.claimed_at,
      c.lease_expires_at
    FROM ${source.table} ${source.alias}
    JOIN stores s ON s.store_id = t.store_id AND s.status = 'active'
    LEFT JOIN store_members m
      ON m.store_id = t.store_id AND m.telegram_id = t.telegram_id
    LEFT JOIN users u ON u.telegram_id = t.telegram_id
    LEFT JOIN admin_task_claims c
      ON c.task_type = '${taskType}'
      AND c.task_id = ${source.id}
      AND c.store_id = t.store_id
    WHERE t.store_id IN (${placeholders}) AND ${source.statusWhere}
  `);
}

function normalizeTaskRow(row, checkedAt) {
  return {
    task_type: String(row.task_type),
    task_id: String(row.task_id),
    store_id: String(row.store_id),
    store_name: String(row.store_name),
    employee_id: String(row.employee_id),
    employee_name: String(row.employee_name),
    amount_micros: Number(row.amount_micros),
    currency: String(row.currency),
    business_date: String(row.business_date),
    submitted_at: String(row.submitted_at),
    status: String(row.status),
    urgency: Number(row.urgency),
    claim: row.claimed_by ? {
      claimed_by: String(row.claimed_by),
      claimed_at: String(row.claimed_at),
      lease_expires_at: String(row.lease_expires_at),
      active: String(row.lease_expires_at) > checkedAt
    } : null
  };
}
