import {
  addRangeFilter,
  adminOrderSql,
  adminPage,
  adminSortColumns,
  adminStoreWhere,
  absenceAdminSortColumns,
  placeholders,
  sumAttendanceEmployeeStats,
  toCsv,
  visibleAdminStores
} from './admin-query.js';
import {
  approveAbsenceFineRequest,
  approveCheckoutRequest,
  approveIncomeRequest,
  approveLeaveRequest,
  approveSalaryAdvanceRequest,
  approveSalaryRequest,
  deleteIncomeRecord,
  deletePendingIncome,
  rejectAbsenceFineRequest,
  rejectCheckoutRequest,
  rejectIncomeRequest,
  rejectLeaveRequest,
  rejectSalaryAdvanceRequest,
  rejectSalaryRequest,
  updateIncomeFineRecord
} from './approvals.js';
import {
  audit,
  auditStatement,
  logError,
  makeId,
  makeStoreId,
  nowIso
} from './audit.js';
import { DEFAULT_STORE_ID } from './constants.js';
import {
  addIsoDays,
  completedAttendanceDate,
  dateRange,
  localDate,
  localTime,
  zonedMidnightIso
} from './dates.js';
import {
  DashboardInputError,
  dashboardAvailable,
  loadDashboard,
  loadDashboardEntries,
  resolveDashboardFilters
} from './dashboard.js';
import {
  CSV_HEADERS,
  clearSessionCookie,
  json,
  readJson,
  sessionCookieValue,
  setSessionCookie
} from './http.js';
import { render, t } from './i18n.js';
import {
  formatMoney,
  normalizeCommissionRate
} from './money.js';
import {
  maskPaymentValue,
  savePaymentSplit
} from './payroll-payments.js';
import { readPayrollPaymentQr } from './payroll-payment-qr.js';
import { readPayrollProof } from './payroll-proofs.js';
import {
  adminIds,
  isGlobalAdmin,
  nextLoginFailureState
} from './security.js';
import {
  getStore,
  isAnyAdmin,
  isStoreAdmin
} from './stores.js';
import { sendMessage } from './telegram-client.js';
import { normalizePositiveInt, validTime } from './validation.js';

function financialApprovalResponse(result) {
  if (!result.ok && result.error === 'already_decided') {
    return json(result, 409);
  }
  return json(result);
}

function validCalendarDate(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text
    ? ''
    : text;
}

export function normalizeMemberPayrollStart(
  body,
  currentMember,
  store,
  now = new Date()
) {
  const existingDate = currentMember
    ? currentMember.payroll_start_date || null
    : null;
  const existingStartedAt = currentMember
    ? currentMember.payroll_automation_started_at || null
    : null;
  const existingCycleStart = currentMember
    ? currentMember.cycle_start
    : null;
  if (!Object.prototype.hasOwnProperty.call(body, 'payroll_start_date')) {
    return {
      ok: true,
      payroll_start_date: existingDate,
      payroll_automation_started_at: existingStartedAt,
      cycle_start: existingCycleStart || now.toISOString()
    };
  }

  const rawDate = String(body.payroll_start_date || '').trim();
  if (!rawDate) {
    if (existingDate) {
      return { ok: false, error: 'payroll_start_date_required' };
    }
    return {
      ok: true,
      payroll_start_date: null,
      payroll_automation_started_at: null,
      cycle_start: existingCycleStart || now.toISOString()
    };
  }
  const payrollStartDate = validCalendarDate(rawDate);
  if (!payrollStartDate) {
    return { ok: false, error: 'invalid_payroll_start_date' };
  }
  if (existingDate && existingDate !== payrollStartDate) {
    return { ok: false, error: 'payroll_start_date_locked' };
  }

  return {
    ok: true,
    payroll_start_date: payrollStartDate,
    payroll_automation_started_at: existingStartedAt || now.toISOString(),
    cycle_start: existingCycleStart || zonedMidnightIso(
      payrollStartDate,
      store && store.timezone ? store.timezone : 'Asia/Tokyo'
    )
  };
}

function financialCorrectionResponse(result) {
  if (
    !result.ok
    && (
      result.error === 'already_reversed'
      || result.error === 'ledger_entry_not_found'
      || result.error === 'invalid_write_mode'
    )
  ) {
    return json(result, 409);
  }
  return json(result);
}

export async function handleAdminApi(request, env, url, ctx) {
  try {
    if (request.method === 'POST' && url.pathname === '/api/admin/login/start') return adminLoginStart(request, env);
    if (request.method === 'POST' && url.pathname === '/api/admin/login/verify') return adminLoginVerify(request, env);

    const session = await requireAdminSession(request, env);
    if (!session) return json({ ok: false, error: 'unauthorized' }, 401);

    if (request.method === 'POST' && url.pathname === '/api/admin/logout') {
      ctx.waitUntil(env.DB.prepare(`DELETE FROM admin_sessions WHERE token = ?`).bind(session.token).run());
      return json({ ok: true }, 200, clearSessionCookie());
    }

    if (request.method === 'GET' && url.pathname === '/api/admin/me') {
      return json({ ok: true, telegram_id: session.telegram_id, global_admin: isGlobalAdmin(env, session.telegram_id) });
    }

    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[2] !== 'stores') return json({ ok: false, error: 'not_found' }, 404);

    if (parts.length === 3) {
      if (request.method === 'GET') return listAdminStores(env, url, session.telegram_id);
      if (request.method === 'POST') return createAdminStore(request, env, session.telegram_id);
    }

    const storeId = decodeURIComponent(parts[3] || '');
    if (!storeId || !(await isStoreAdmin(env, session.telegram_id, storeId))) {
      return json({ ok: false, error: 'forbidden' }, 403);
    }

    if (parts.length === 4 && request.method === 'PATCH') return updateAdminStore(request, env, session.telegram_id, storeId);
    if (parts.length === 4 && request.method === 'DELETE') return deleteAdminStore(env, session.telegram_id, storeId);
    if (parts[4] === 'members') return handleAdminMembers(request, env, url, storeId, parts, session.telegram_id);
    if (parts[4] === 'payroll'
      && parts[5] === 'proofs'
      && parts[6]
      && parts.length === 7
      && request.method === 'GET') {
      return readPayrollProof(
        env,
        {
          telegram_id: session.telegram_id,
          store_id: storeId
        },
        parts[6]
      );
    }
    if (parts[4] === 'payroll') {
      return handleAdminPayroll(
        request,
        env,
        url,
        storeId,
        parts,
        session.telegram_id
      );
    }
    if (parts[4] === 'income') return handleAdminIncome(request, env, url, storeId, parts, session.telegram_id);
    if (parts[4] === 'salary') return handleAdminSalary(request, env, url, storeId, parts, session.telegram_id);
    if (parts[4] === 'advances') return handleAdminSalaryAdvances(request, env, url, storeId, parts, session.telegram_id);
    if (parts[4] === 'attendance') return handleAdminAttendance(request, env, url, storeId, parts, session.telegram_id);
    if (parts[4] === 'absence') return handleAdminAbsence(request, env, url, storeId, parts, session.telegram_id);
    if (parts[4] === 'leave') return handleAdminLeave(request, env, url, storeId, parts, session.telegram_id);
    if (parts[4] === 'dashboard') {
      return handleAdminDashboard(
        request,
        env,
        url,
        storeId,
        parts,
        session.telegram_id
      );
    }
    if (parts[4] === 'logs' && request.method === 'GET') {
      const result = await listPagedRows(
        env,
        url,
        'logs_page',
        'rows',
        `SELECT * FROM bot_logs WHERE store_id = ?`,
        `SELECT COUNT(*) AS total FROM bot_logs WHERE store_id = ?`,
        [storeId],
        `ORDER BY id DESC`,
        adminSortColumns(['id','store_id','level','event','telegram_id','message_text','payload_json','created_at'])
      );
      return json({ ok: true, rows: result.rows, pagination: { rows: result.pagination } });
    }
    if (parts[4] === 'export' && request.method === 'GET') return exportCsv(env, url, storeId, parts[5], session.telegram_id);

    return json({ ok: false, error: 'not_found' }, 404);
  } catch (error) {
    await logError(env, 'admin_api_error', error, { path: url.pathname });
    return json({ ok: false, error: 'server_error' }, 500);
  }
}

async function handleAdminPayroll(
  request,
  env,
  url,
  storeId,
  parts,
  adminId
) {
  if (parts.length === 5 && request.method === 'GET') {
    const count = await env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM payroll_disbursements
      WHERE store_id = ?
    `).bind(storeId).first();
    const pagination = adminPage(
      url.searchParams.get('page'),
      count && count.total
    );
    const rows = await env.DB.prepare(`
      SELECT
        d.payroll_id,
        d.telegram_id,
        COALESCE(NULLIF(m.display_name, ''), d.telegram_id) AS employee,
        d.scheduled_date,
        d.period_start,
        d.cutoff_at,
        d.amount_snapshot_micros,
        d.currency,
        d.bank_micros,
        d.usdt_micros,
        d.cash_micros,
        d.status,
        d.current_admin_id,
        d.confirmed_at,
        d.bank_details_snapshot,
        d.usdt_details_snapshot,
        CASE WHEN q.qr_id IS NULL THEN 0 ELSE 1 END
          AS has_usdt_qr,
        COALESCE(p.proof_count, 0) AS proof_count,
        COALESCE(e.status, '') AS email_status
      FROM payroll_disbursements d
      LEFT JOIN store_members m
        ON m.store_id = d.store_id
       AND m.telegram_id = d.telegram_id
      LEFT JOIN (
        SELECT payroll_id, COUNT(*) AS proof_count
        FROM payroll_payment_proofs
        WHERE superseded_at IS NULL
        GROUP BY payroll_id
      ) p ON p.payroll_id = d.payroll_id
      LEFT JOIN payroll_payment_qr_codes q
        ON q.qr_id = d.usdt_qr_id_snapshot
       AND q.store_id = d.store_id
       AND q.telegram_id = d.telegram_id
      LEFT JOIN payroll_email_outbox e
        ON e.payroll_id = d.payroll_id
      WHERE d.store_id = ?
      ORDER BY d.cutoff_at DESC, d.payroll_id DESC
      LIMIT ? OFFSET ?
    `).bind(
      storeId,
      pagination.limit,
      pagination.offset
    ).all();
    return json({
      ok: true,
      payroll: (rows.results || []).map((row) => ({
        ...row,
        has_usdt_qr: Number(row.has_usdt_qr) === 1,
        bank_details_snapshot: maskPaymentValue(
          row.bank_details_snapshot
        ),
        usdt_details_snapshot: maskPaymentValue(
          row.usdt_details_snapshot
        )
      })),
      pagination
    });
  }

  const payrollId = decodeURIComponent(parts[5] || '');
  if (!payrollId) return json({ ok: false, error: 'not_found' }, 404);
  if (parts.length === 7
    && parts[6] === 'usdt-qr'
    && request.method === 'GET') {
    const scopedPayroll = await env.DB.prepare(`
      SELECT 1
      FROM payroll_disbursements
      WHERE store_id = ?
        AND payroll_id = ?
    `).bind(storeId, payrollId).first();
    if (!scopedPayroll) {
      return json({ ok: false, error: 'not_found' }, 404);
    }
    return readPayrollPaymentQr(
      env,
      {
        telegram_id: adminId,
        store_id: storeId
      },
      payrollId
    );
  }
  if (parts.length === 6 && request.method === 'GET') {
    const payroll = await env.DB.prepare(`
      SELECT
        d.*,
        COALESCE(NULLIF(m.display_name, ''), d.telegram_id) AS employee,
        COALESCE(e.status, '') AS email_status,
        COALESCE(e.attempt_count, 0) AS email_attempt_count,
        e.last_error AS email_last_error,
        CASE WHEN q.qr_id IS NULL THEN 0 ELSE 1 END
          AS has_usdt_qr
      FROM payroll_disbursements d
      LEFT JOIN store_members m
        ON m.store_id = d.store_id
       AND m.telegram_id = d.telegram_id
      LEFT JOIN payroll_email_outbox e
        ON e.payroll_id = d.payroll_id
      LEFT JOIN payroll_payment_qr_codes q
        ON q.qr_id = d.usdt_qr_id_snapshot
       AND q.store_id = d.store_id
       AND q.telegram_id = d.telegram_id
      WHERE d.store_id = ? AND d.payroll_id = ?
    `).bind(storeId, payrollId).first();
    if (!payroll) return json({ ok: false, error: 'not_found' }, 404);
    const proofs = await env.DB.prepare(`
      SELECT
        proof_id, method, mime_type, size_bytes,
        sort_order, uploaded_by, superseded_at, uploaded_at
      FROM payroll_payment_proofs
      WHERE payroll_id = ?
      ORDER BY method, sort_order
    `).bind(payrollId).all();
    return json({
      ok: true,
      payroll: {
        ...payroll,
        bank_details_snapshot: maskPaymentValue(
          payroll.bank_details_snapshot
        ),
        usdt_details_snapshot: maskPaymentValue(
          payroll.usdt_details_snapshot
        ),
        has_usdt_qr: Number(payroll.has_usdt_qr) === 1,
        usdt_qr_url: Number(payroll.has_usdt_qr) === 1
          ? [
              '/api/admin/stores',
              encodeURIComponent(storeId),
              'payroll',
              encodeURIComponent(payrollId),
              'usdt-qr'
            ].join('/')
          : null
      },
      proofs: proofs.results || []
    });
  }
  if (parts.length === 7
    && parts[6] === 'split'
    && request.method === 'POST') {
    const scopedPayroll = await env.DB.prepare(`
      SELECT 1 FROM payroll_disbursements
      WHERE store_id = ? AND payroll_id = ?
    `).bind(storeId, payrollId).first();
    if (!scopedPayroll) {
      return json({ ok: false, error: 'not_found' }, 404);
    }
    const body = await readJson(request);
    try {
      const payroll = await savePaymentSplit(
        env,
        adminId,
        payrollId,
        {
          bank_micros: body.bank_micros,
          usdt_micros: body.usdt_micros,
          cash_micros: body.cash_micros
        }
      );
      return json({ ok: true, payroll });
    } catch (error) {
      const message = String(error && error.message || '');
      if (message.includes('not found')) {
        return json({ ok: false, error: 'not_found' }, 404);
      }
      if (message.includes('permission')) {
        return json({ ok: false, error: 'forbidden' }, 403);
      }
      return json({ ok: false, error: 'invalid_payroll_split' }, 409);
    }
  }
  return json({ ok: false, error: 'not_found' }, 404);
}

async function handleAdminDashboard(
  request,
  env,
  url,
  storeId,
  parts,
  adminId
) {
  if (!dashboardAvailable(env) || request.method !== 'GET') {
    return json({ ok: false, error: 'not_found' }, 404);
  }
  try {
    const filters = await resolveDashboardFilters(
      env,
      url,
      storeId,
      adminId
    );
    if (parts.length === 5) {
      return json(await loadDashboard(env, filters));
    }
    if (parts.length === 6 && parts[5] === 'entries') {
      return json(await loadDashboardEntries(env, url, filters));
    }
    return json({ ok: false, error: 'not_found' }, 404);
  } catch (error) {
    if (error instanceof DashboardInputError) {
      return json(
        { ok: false, error: error.code },
        error.status || 400
      );
    }
    throw error;
  }
}

async function adminLoginStart(request, env) {
  const body = await readJson(request);
  const telegramId = String(body.telegram_id || '').trim();
  if (!telegramId || !(await isAnyAdmin(env, telegramId))) {
    return json({ ok: false, error: 'forbidden' }, 403);
  }
  const existing = await env.DB.prepare(`SELECT locked_until FROM admin_login_codes WHERE telegram_id = ?`).bind(telegramId).first();
  if (existing && existing.locked_until && existing.locked_until > nowIso()) {
    return json({ ok: false, error: 'too_many_attempts' }, 429);
  }
  const code = makeNumericCode();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
  await env.DB.prepare(`
    INSERT INTO admin_login_codes (telegram_id, code, expires_at, created_at, failed_attempts, locked_until)
    VALUES (?, ?, ?, ?, 0, NULL)
    ON CONFLICT(telegram_id) DO UPDATE SET
      code = excluded.code,
      expires_at = excluded.expires_at,
      created_at = excluded.created_at,
      failed_attempts = 0,
      locked_until = NULL
  `).bind(telegramId, code, expiresAt, now.toISOString()).run();
  await sendMessage(env, telegramId, `StaffBot 后台登录验证码：${code}\n10 分钟内有效。`);
  return json({ ok: true });
}

async function adminLoginVerify(request, env) {
  const body = await readJson(request);
  const telegramId = String(body.telegram_id || '').trim();
  const code = String(body.code || '').trim();
  const found = await env.DB.prepare(`SELECT * FROM admin_login_codes WHERE telegram_id = ?`).bind(telegramId).first();
  if (found && found.locked_until && found.locked_until > nowIso()) {
    return json({ ok: false, error: 'too_many_attempts' }, 429);
  }
  if (!found || found.code !== code || found.expires_at <= nowIso() || !(await isAnyAdmin(env, telegramId))) {
    if (found) {
      const next = nextLoginFailureState(found.failed_attempts, new Date());
      await env.DB.prepare(`
        UPDATE admin_login_codes SET failed_attempts = ?, locked_until = ? WHERE telegram_id = ?
      `).bind(next.failedAttempts, next.lockedUntil, telegramId).run();
    }
    return json({ ok: false, error: 'invalid_code' }, 403);
  }
  await env.DB.prepare(`DELETE FROM admin_login_codes WHERE telegram_id = ?`).bind(telegramId).run();
  const token = makeId('SESS');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(`
    INSERT INTO admin_sessions (token, telegram_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).bind(token, telegramId, expiresAt, now.toISOString()).run();
  return json({ ok: true }, 200, setSessionCookie(token, expiresAt));
}

async function requireAdminSession(request, env) {
  const token = sessionCookieValue(request.headers.get('cookie') || '');
  if (!token) return null;
  const row = await env.DB.prepare(`SELECT * FROM admin_sessions WHERE token = ? AND expires_at > ?`).bind(token, nowIso()).first();
  if (!row || !(await isAnyAdmin(env, row.telegram_id))) return null;
  return { ...row, token };
}

async function listAdminStores(env, url, adminId) {
  const orderSql = adminOrderSql(url, 'stores_page', adminSortColumns([
    'store_id','name','status','timezone','currency','checkin_time','checkout_time',
    'late_fine','early_leave_fine','leave_min_notice_days','leave_max_notice_days',
    'leave_monthly_limit','leave_daily_limit','leave_same_day_cutoff_hour','absence_fine',
    'absence_fine_enabled_at','absence_last_checked_date'
  ], 's'), 'ORDER BY s.name');
  const allRows = isGlobalAdmin(env, adminId)
    ? await env.DB.prepare(`SELECT s.* FROM stores s WHERE s.status = 'active' ${orderSql}`).all()
    : await env.DB.prepare(`
        SELECT s.* FROM stores s
        JOIN store_members m ON m.store_id = s.store_id
        WHERE m.telegram_id = ? AND m.status = 'active' AND m.role IN ('admin', 'owner') AND s.status = 'active'
        ${orderSql}
      `).bind(adminId).all();
  const allStores = visibleAdminStores(allRows.results || []);
  const pagination = adminPage(url.searchParams.get('stores_page'), allStores.length);
  return json({
    ok: true,
    stores: allStores.slice(pagination.offset, pagination.offset + pagination.limit),
    all_stores: allStores,
    pagination: { stores: pagination }
  });
}

async function createAdminStore(request, env, adminId) {
  if (!isGlobalAdmin(env, adminId)) return json({ ok: false, error: 'forbidden' }, 403);
  const body = await readJson(request);
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const storeId = cleanStoreId(body.store_id || body.name || makeStoreId());
  const name = String(body.name || storeId).trim();
  const normalizedStore = normalizeStoreInput({ ...body, store_id: storeId, name });
  const store = {
    ...normalizedStore,
    ...normalizeAbsenceFineSetting(body, normalizedStore, nowDate)
  };
  const globalAdminMembers = adminIds(env).map((telegramId) => env.DB.prepare(`
    INSERT INTO store_members (store_id, telegram_id, role, status, cycle_start, joined_at, updated_at)
    VALUES (?, ?, 'admin', 'active', ?, ?, ?)
    ON CONFLICT(store_id, telegram_id) DO UPDATE SET
      role = 'admin',
      status = 'active',
      updated_at = excluded.updated_at
  `).bind(store.store_id, telegramId, now, now, now));
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO stores (
        store_id, name, status, timezone, currency, checkin_time, checkout_time,
        late_fine, early_leave_fine, leave_min_notice_days, leave_max_notice_days,
        leave_monthly_limit, leave_daily_limit, leave_same_day_cutoff_hour,
        absence_fine, absence_fine_enabled_at, absence_last_checked_date, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      store.store_id, store.name, store.status, store.timezone, store.currency,
      store.checkin_time, store.checkout_time, store.late_fine, store.early_leave_fine,
      store.leave_min_notice_days, store.leave_max_notice_days, store.leave_monthly_limit,
      store.leave_daily_limit, store.leave_same_day_cutoff_hour, store.absence_fine,
      store.absence_fine_enabled_at, store.absence_last_checked_date, now, now
    ),
    ...globalAdminMembers
  ]);
  await audit(env, store.store_id, adminId, 'create_store', store.store_id, store);
  return json({ ok: true, store });
}

async function updateAdminStore(request, env, adminId, storeId) {
  const body = await readJson(request);
  const current = await getStore(env, storeId);
  if (!current) return json({ ok: false, error: 'not_found' }, 404);
  const now = new Date();
  const next = {
    ...normalizeStoreInput({ ...current, ...body, store_id: storeId }),
    ...normalizeAbsenceFineSetting(body, current, now)
  };
  await env.DB.prepare(`
    UPDATE stores SET
      name = ?, status = ?, timezone = ?, currency = ?, checkin_time = ?,
      checkout_time = ?, late_fine = ?, early_leave_fine = ?,
      leave_min_notice_days = ?, leave_max_notice_days = ?,
      leave_monthly_limit = ?, leave_daily_limit = ?, leave_same_day_cutoff_hour = ?,
      absence_fine = ?, absence_fine_enabled_at = ?, absence_last_checked_date = ?, updated_at = ?
    WHERE store_id = ?
  `).bind(
    next.name, next.status, next.timezone, next.currency, next.checkin_time,
    next.checkout_time, next.late_fine, next.early_leave_fine,
    next.leave_min_notice_days, next.leave_max_notice_days, next.leave_monthly_limit,
    next.leave_daily_limit, next.leave_same_day_cutoff_hour, next.absence_fine,
    next.absence_fine_enabled_at, next.absence_last_checked_date, now.toISOString(), storeId
  ).run();
  await audit(env, storeId, adminId, 'update_store', storeId, body);
  return json({ ok: true, store: next });
}

async function deleteAdminStore(env, adminId, storeId) {
  if (storeId === DEFAULT_STORE_ID) return json({ ok: false, error: 'default_store_cannot_be_deleted' }, 400);
  await env.DB.prepare(`
    UPDATE stores SET status = 'disabled', updated_at = ? WHERE store_id = ?
  `).bind(nowIso(), storeId).run();
  await audit(env, storeId, adminId, 'delete_store', storeId, {});
  return json({ ok: true });
}

async function handleAdminMembers(request, env, url, storeId, parts, adminId) {
  if (request.method === 'GET') {
    if (url.searchParams.get('all') === '1') {
      return listRows(env, `
        SELECT
          m.store_id,
          m.telegram_id,
          COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), m.telegram_id) AS display_name,
          u.name AS telegram_name,
          u.username,
          m.role,
          m.status,
          m.commission_rate,
          m.absence_check_enabled,
          m.payroll_start_date,
          m.payroll_automation_started_at,
          m.cycle_start,
          m.joined_at,
          m.updated_at
        FROM store_members m
        LEFT JOIN users u ON u.telegram_id = m.telegram_id
        WHERE m.store_id = ? ORDER BY m.role DESC, display_name, m.telegram_id
      `, [storeId], 'members');
    }
    const filters = await adminFilters(env, url, storeId, adminId);
    if (!filters.ok) return json({ ok: false, error: filters.error }, filters.status);
    const storeWhere = adminStoreWhere('m', filters.storeIds);
    const memberSort = {
      ...adminSortColumns(['store_id','telegram_id','role','status','commission_rate','payroll_start_date','payroll_automation_started_at','cycle_start','joined_at','updated_at'], 'm'),
      display_name: 'display_name',
      telegram_name: 'u.name',
      username: 'u.username'
    };
    const result = await listPagedRows(env, url, 'members_page', 'members', `
      SELECT
        m.store_id,
        m.telegram_id,
        COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), m.telegram_id) AS display_name,
        u.name AS telegram_name,
        u.username,
        m.role,
        m.status,
        m.commission_rate,
        m.absence_check_enabled,
        m.payroll_start_date,
        m.payroll_automation_started_at,
        m.cycle_start,
        m.joined_at,
        m.updated_at
      FROM store_members m
      LEFT JOIN users u ON u.telegram_id = m.telegram_id
      WHERE ${storeWhere.sql}
    `, `SELECT COUNT(*) AS total FROM store_members m WHERE ${storeWhere.sql}`, storeWhere.params, `ORDER BY m.role DESC, display_name, m.telegram_id`, memberSort);
    return json({ ok: true, members: result.members, pagination: { members: result.pagination } });
  }
  if (request.method === 'DELETE' && parts[5]) {
    const telegramId = decodeURIComponent(parts[5]);
    await env.DB.prepare(`
      DELETE FROM store_members WHERE store_id = ? AND telegram_id = ?
    `).bind(storeId, telegramId).run();
    await audit(env, storeId, adminId, 'delete_member', telegramId, {});
    return json({ ok: true });
  }
  const body = await readJson(request);
  const telegramId = String(body.telegram_id || '').trim();
  if (!telegramId) return json({ ok: false, error: 'telegram_id_required' }, 400);
  if (Object.prototype.hasOwnProperty.call(body, 'absence_check_enabled')
    && typeof body.absence_check_enabled !== 'boolean') {
    return json({ ok: false, error: 'invalid_absence_check_enabled' }, 400);
  }
  const role = ['employee', 'admin', 'owner'].includes(body.role) ? body.role : 'employee';
  const status = ['active', 'pending', 'disabled'].includes(body.status) ? body.status : 'active';
  const commissionRate = normalizeCommissionRate(body.commission_rate);
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const currentMember = await env.DB.prepare(`
    SELECT
      absence_check_enabled,
      absence_check_enabled_at,
      cycle_start,
      payroll_start_date,
      payroll_automation_started_at
    FROM store_members WHERE store_id = ? AND telegram_id = ?
  `).bind(storeId, telegramId).first();
  const needsPayrollTimezone = Object.prototype.hasOwnProperty.call(
    body,
    'payroll_start_date'
  ) && String(body.payroll_start_date || '').trim()
    && !(currentMember && currentMember.cycle_start);
  const store = needsPayrollTimezone
    ? await getStore(env, storeId)
    : null;
  const payrollStart = normalizeMemberPayrollStart(
    body,
    currentMember,
    store,
    nowDate
  );
  if (!payrollStart.ok) {
    return json({ ok: false, error: payrollStart.error }, 400);
  }
  const absenceCheck = normalizeEmployeeAbsenceCheck(body, currentMember, nowDate);
  const disablingAbsenceCheck = !!currentMember
    && Number(currentMember.absence_check_enabled) === 1
    && absenceCheck.absence_check_enabled === 0;
  const statements = [
    env.DB.prepare(`
      INSERT INTO users (telegram_id, name, username, role, status, cycle_start, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET
        name = COALESCE(NULLIF(excluded.name, ''), users.name),
        username = COALESCE(NULLIF(excluded.username, ''), users.username),
        updated_at = excluded.updated_at
    `).bind(telegramId, String(body.name || ''), String(body.username || ''), role, status, now, now, now),
    env.DB.prepare(`
      INSERT INTO store_members (
        store_id, telegram_id, display_name, role, status, commission_rate,
        cycle_start, joined_at, updated_at,
        absence_check_enabled, absence_check_enabled_at,
        payroll_start_date, payroll_automation_started_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(store_id, telegram_id) DO UPDATE SET
        display_name = COALESCE(NULLIF(excluded.display_name, ''), store_members.display_name),
        role = excluded.role,
        status = excluded.status,
        commission_rate = excluded.commission_rate,
        absence_check_enabled = excluded.absence_check_enabled,
        absence_check_enabled_at = excluded.absence_check_enabled_at,
        payroll_start_date = excluded.payroll_start_date,
        payroll_automation_started_at = excluded.payroll_automation_started_at,
        updated_at = excluded.updated_at
    `).bind(
      storeId, telegramId, String(body.name || ''), role, status, commissionRate,
      payrollStart.cycle_start,
      now,
      now,
      absenceCheck.absence_check_enabled,
      absenceCheck.absence_check_enabled_at,
      payrollStart.payroll_start_date,
      payrollStart.payroll_automation_started_at
    )
  ];
  if (disablingAbsenceCheck) {
    statements.push(
      env.DB.prepare(`
        UPDATE absence_fine_requests
        SET status = 'cancelled', cancellation_reason = 'absence_check_disabled',
            decided_at = ?, admin_id = ?
        WHERE store_id = ? AND telegram_id = ? AND status = 'pending'
      `).bind(now, adminId, storeId, telegramId),
      env.DB.prepare(`
        UPDATE absence_fine_notifications
        SET status = 'cancelled', last_error = 'absence_check_disabled'
        WHERE status IN ('pending', 'sending')
          AND request_id IN (
            SELECT request_id FROM absence_fine_requests
            WHERE store_id = ? AND telegram_id = ?
              AND status = 'cancelled'
              AND cancellation_reason = 'absence_check_disabled'
          )
      `).bind(storeId, telegramId)
    );
  }
  statements.push(auditStatement(env, storeId, adminId, 'update_member', telegramId, {
    absence_check: {
      before: currentMember ? Number(currentMember.absence_check_enabled) : null,
      after: absenceCheck.absence_check_enabled
    },
    payroll_start: {
      before: currentMember ? currentMember.payroll_start_date : null,
      after: payrollStart.payroll_start_date,
      automation_started_at: payrollStart.payroll_automation_started_at
    }
  }, now));
  await env.DB.batch(statements);
  return json({ ok: true });
}

async function handleAdminIncome(request, env, url, storeId, parts, adminId) {
  if (parts.length === 5 && request.method === 'GET') {
    const filters = await adminFilters(env, url, storeId, adminId);
    if (!filters.ok) return json({ ok: false, error: filters.error }, filters.status);
    const pendingWhere = [
      `p.store_id IN (${placeholders(filters.storeIds.length)})`,
      `p.status = 'pending'`
    ];
    const pendingParams = [...filters.storeIds];
    const rejectedWhere = [
      `p.store_id IN (${placeholders(filters.storeIds.length)})`,
      `p.status = 'rejected'`
    ];
    const rejectedParams = [...filters.storeIds];
    const recordWhere = [
      `r.store_id IN (${placeholders(filters.storeIds.length)})`
    ];
    const recordParams = [...filters.storeIds];
    if (filters.employeeId) {
      pendingWhere.push(`p.telegram_id = ?`);
      pendingParams.push(filters.employeeId);
      rejectedWhere.push(`p.telegram_id = ?`);
      rejectedParams.push(filters.employeeId);
      recordWhere.push(`r.telegram_id = ?`);
      recordParams.push(filters.employeeId);
    }
    addRangeFilter(pendingWhere, pendingParams, 'p.submitted_at', filters.monthStart, filters.monthEnd);
    addRangeFilter(rejectedWhere, rejectedParams, 'p.submitted_at', filters.monthStart, filters.monthEnd);
    addRangeFilter(recordWhere, recordParams, 'r.approved_at', filters.monthStart, filters.monthEnd);
    const pendingSort = {
      ...adminSortColumns(['request_id','store_id','telegram_id','income','commission_rate','commission_income','fine','status','submitted_at','decided_at','admin_id','reject_reason'], 'p'),
      original_fine: 'p.fine',
      display_name: 'display_name',
      username: 'u.username'
    };
    const recordSort = {
      ...adminSortColumns(['record_id','store_id','telegram_id','type','income','commission_rate','commission_income','original_fine','fine','approved_at','admin_id'], 'r'),
      submitted_at: 'p.submitted_at',
      display_name: 'display_name',
      username: 'u.username'
    };
    const pending = await listPagedRows(env, url, 'pending_page', 'pending', `
      SELECT p.*, p.fine AS original_fine, COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), p.telegram_id) AS display_name, u.username
      FROM pending_income p
      LEFT JOIN users u ON u.telegram_id = p.telegram_id
      LEFT JOIN store_members m ON m.store_id = p.store_id AND m.telegram_id = p.telegram_id
      WHERE ${pendingWhere.join(' AND ')}
    `, `SELECT COUNT(*) AS total FROM pending_income p WHERE ${pendingWhere.join(' AND ')}`, pendingParams, `ORDER BY p.submitted_at DESC`, pendingSort);
    const rejected = await listPagedRows(env, url, 'rejected_page', 'rejected', `
      SELECT p.*, COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), p.telegram_id) AS display_name, u.username
      FROM pending_income p
      LEFT JOIN users u ON u.telegram_id = p.telegram_id
      LEFT JOIN store_members m ON m.store_id = p.store_id AND m.telegram_id = p.telegram_id
      WHERE ${rejectedWhere.join(' AND ')}
    `, `SELECT COUNT(*) AS total FROM pending_income p WHERE ${rejectedWhere.join(' AND ')}`, rejectedParams, `ORDER BY COALESCE(p.decided_at, p.submitted_at) DESC`, pendingSort);
    const records = await listPagedRows(env, url, 'records_page', 'records', `
      SELECT r.*, p.submitted_at, COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), r.telegram_id) AS display_name, u.username
      FROM income_records r
      LEFT JOIN pending_income p ON p.store_id = r.store_id AND p.request_id = r.request_id
      LEFT JOIN users u ON u.telegram_id = r.telegram_id
      LEFT JOIN store_members m ON m.store_id = r.store_id AND m.telegram_id = r.telegram_id
      WHERE ${recordWhere.join(' AND ')}
    `, `SELECT COUNT(*) AS total FROM income_records r WHERE ${recordWhere.join(' AND ')}`, recordParams, `ORDER BY r.approved_at DESC`, recordSort);
    return json({
      ok: true,
      pending: pending.pending,
      records: records.records,
      rejected: rejected.rejected,
      filters,
      pagination: { pending: pending.pagination, records: records.pagination, rejected: rejected.pagination }
    });
  }
  if (parts.length >= 7 && request.method === 'POST') {
    const requestId = decodeURIComponent(parts[5]);
    if (parts[6] === 'approve') {
      return financialApprovalResponse(
        await approveIncomeRequest(env, storeId, requestId, adminId)
      );
    }
    if (parts[6] === 'reject') {
      const body = await readJson(request);
      return financialApprovalResponse(
        await rejectIncomeRequest(env, storeId, requestId, adminId, String(body.reason || 'Rejected from admin page'))
      );
    }
  }
  if (parts.length === 7 && request.method === 'PATCH' && parts[5] === 'records') {
    const body = await readJson(request);
    return financialCorrectionResponse(
      await updateIncomeFineRecord(env, storeId, decodeURIComponent(parts[6]), adminId, body.fine)
    );
  }
  if (parts.length === 7 && request.method === 'DELETE') {
    const kind = parts[5];
    const id = decodeURIComponent(parts[6]);
    if (kind === 'pending') return json(await deletePendingIncome(env, storeId, id, adminId));
    if (kind === 'records') {
      return financialCorrectionResponse(
        await deleteIncomeRecord(env, storeId, id, adminId)
      );
    }
  }
  return json({ ok: false, error: 'not_found' }, 404);
}

async function handleAdminSalary(request, env, url, storeId, parts, adminId) {
  if (parts.length === 5 && request.method === 'GET') {
    const filters = await adminFilters(env, url, storeId, adminId);
    if (!filters.ok) return json({ ok: false, error: filters.error }, filters.status);
    const requestWhere = [
      `s.store_id IN (${placeholders(filters.storeIds.length)})`,
      `s.status = 'pending'`
    ];
    const requestParams = [...filters.storeIds];
    const rejectedWhere = [
      `s.store_id IN (${placeholders(filters.storeIds.length)})`,
      `s.status = 'rejected'`
    ];
    const rejectedParams = [...filters.storeIds];
    const recordWhere = [
      `r.store_id IN (${placeholders(filters.storeIds.length)})`
    ];
    const recordParams = [...filters.storeIds];
    if (filters.employeeId) {
      requestWhere.push(`s.telegram_id = ?`);
      requestParams.push(filters.employeeId);
      rejectedWhere.push(`s.telegram_id = ?`);
      rejectedParams.push(filters.employeeId);
      recordWhere.push(`r.telegram_id = ?`);
      recordParams.push(filters.employeeId);
    }
    addRangeFilter(requestWhere, requestParams, 's.requested_at', filters.monthStart, filters.monthEnd);
    addRangeFilter(rejectedWhere, rejectedParams, 's.requested_at', filters.monthStart, filters.monthEnd);
    addRangeFilter(recordWhere, recordParams, 'r.approved_at', filters.monthStart, filters.monthEnd);
    const requestSort = {
      ...adminSortColumns(['request_id','store_id','telegram_id','amount_snapshot','status','requested_at','decided_at','admin_id','reject_reason'], 's'),
      display_name: 'display_name',
      username: 'u.username'
    };
    const salaryRecordSort = {
      ...adminSortColumns(['record_id','store_id','telegram_id','amount','period_start','period_end','approved_at','admin_id'], 'r'),
      display_name: 'display_name',
      username: 'u.username'
    };
    const requests = await listPagedRows(env, url, 'requests_page', 'requests', `
      SELECT s.*, COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), s.telegram_id) AS display_name, u.username FROM salary_requests s
      LEFT JOIN users u ON u.telegram_id = s.telegram_id
      LEFT JOIN store_members m ON m.store_id = s.store_id AND m.telegram_id = s.telegram_id
      WHERE ${requestWhere.join(' AND ')}
    `, `SELECT COUNT(*) AS total FROM salary_requests s WHERE ${requestWhere.join(' AND ')}`, requestParams, `ORDER BY s.requested_at DESC`, requestSort);
    const rejected = await listPagedRows(env, url, 'rejected_page', 'rejected', `
      SELECT s.*, COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), s.telegram_id) AS display_name, u.username FROM salary_requests s
      LEFT JOIN users u ON u.telegram_id = s.telegram_id
      LEFT JOIN store_members m ON m.store_id = s.store_id AND m.telegram_id = s.telegram_id
      WHERE ${rejectedWhere.join(' AND ')}
    `, `SELECT COUNT(*) AS total FROM salary_requests s WHERE ${rejectedWhere.join(' AND ')}`, rejectedParams, `ORDER BY COALESCE(s.decided_at, s.requested_at) DESC`, requestSort);
    const records = await listPagedRows(env, url, 'records_page', 'records', `
      SELECT r.*, COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), r.telegram_id) AS display_name, u.username FROM salary_records r
      LEFT JOIN users u ON u.telegram_id = r.telegram_id
      LEFT JOIN store_members m ON m.store_id = r.store_id AND m.telegram_id = r.telegram_id
      WHERE ${recordWhere.join(' AND ')}
    `, `SELECT COUNT(*) AS total FROM salary_records r WHERE ${recordWhere.join(' AND ')}`, recordParams, `ORDER BY r.approved_at DESC`, salaryRecordSort);
    return json({
      ok: true,
      requests: requests.requests,
      records: records.records,
      rejected: rejected.rejected,
      filters,
      pagination: { requests: requests.pagination, records: records.pagination, rejected: rejected.pagination }
    });
  }
  if (parts.length >= 7 && request.method === 'POST') {
    const requestId = decodeURIComponent(parts[5]);
    if (parts[6] === 'approve') {
      return financialApprovalResponse(
        await approveSalaryRequest(env, storeId, requestId, adminId)
      );
    }
    if (parts[6] === 'reject') {
      const body = await readJson(request);
      return financialApprovalResponse(
        await rejectSalaryRequest(env, storeId, requestId, adminId, String(body.reason || 'Rejected from admin page'))
      );
    }
  }
  return json({ ok: false, error: 'not_found' }, 404);
}

async function handleAdminSalaryAdvances(request, env, url, storeId, parts, adminId) {
  if (parts.length === 5 && request.method === 'GET') {
    const filters = await adminFilters(env, url, storeId, adminId);
    if (!filters.ok) return json({ ok: false, error: filters.error }, filters.status);
    const pendingWhere = [
      `a.store_id IN (${placeholders(filters.storeIds.length)})`,
      `a.status = 'pending'`
    ];
    const pendingParams = [...filters.storeIds];
    const approvedWhere = [
      `a.store_id IN (${placeholders(filters.storeIds.length)})`,
      `a.status = 'approved'`
    ];
    const approvedParams = [...filters.storeIds];
    const rejectedWhere = [
      `a.store_id IN (${placeholders(filters.storeIds.length)})`,
      `a.status = 'rejected'`
    ];
    const rejectedParams = [...filters.storeIds];
    if (filters.employeeId) {
      pendingWhere.push(`a.telegram_id = ?`);
      pendingParams.push(filters.employeeId);
      approvedWhere.push(`a.telegram_id = ?`);
      approvedParams.push(filters.employeeId);
      rejectedWhere.push(`a.telegram_id = ?`);
      rejectedParams.push(filters.employeeId);
    }
    addRangeFilter(pendingWhere, pendingParams, 'a.requested_at', filters.monthStart, filters.monthEnd);
    addRangeFilter(approvedWhere, approvedParams, 'a.decided_at', filters.monthStart, filters.monthEnd);
    addRangeFilter(rejectedWhere, rejectedParams, 'a.requested_at', filters.monthStart, filters.monthEnd);
    const advanceSort = {
      ...adminSortColumns(['request_id','store_id','telegram_id','amount','status','requested_at','decided_at','admin_id','reject_reason'], 'a'),
      display_name: 'display_name',
      username: 'u.username'
    };
    const selectSql = (where) => `
      SELECT a.*, COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), a.telegram_id) AS display_name, u.username
      FROM salary_advance_requests a
      LEFT JOIN users u ON u.telegram_id = a.telegram_id
      LEFT JOIN store_members m ON m.store_id = a.store_id AND m.telegram_id = a.telegram_id
      WHERE ${where.join(' AND ')}
    `;
    const pending = await listPagedRows(env, url, 'pending_page', 'pending', selectSql(pendingWhere), `SELECT COUNT(*) AS total FROM salary_advance_requests a WHERE ${pendingWhere.join(' AND ')}`, pendingParams, `ORDER BY a.requested_at DESC`, advanceSort);
    const approved = await listPagedRows(env, url, 'approved_page', 'approved', selectSql(approvedWhere), `SELECT COUNT(*) AS total FROM salary_advance_requests a WHERE ${approvedWhere.join(' AND ')}`, approvedParams, `ORDER BY a.decided_at DESC`, advanceSort);
    const rejected = await listPagedRows(env, url, 'rejected_page', 'rejected', selectSql(rejectedWhere), `SELECT COUNT(*) AS total FROM salary_advance_requests a WHERE ${rejectedWhere.join(' AND ')}`, rejectedParams, `ORDER BY COALESCE(a.decided_at, a.requested_at) DESC`, advanceSort);
    return json({
      ok: true,
      pending: pending.pending,
      approved: approved.approved,
      rejected: rejected.rejected,
      filters,
      pagination: { pending: pending.pagination, approved: approved.pagination, rejected: rejected.pagination }
    });
  }
  if (parts.length >= 7 && request.method === 'POST') {
    const requestId = decodeURIComponent(parts[5]);
    if (parts[6] === 'approve') {
      return financialApprovalResponse(
        await approveSalaryAdvanceRequest(env, storeId, requestId, adminId)
      );
    }
    if (parts[6] === 'reject') {
      const body = await readJson(request);
      return financialApprovalResponse(
        await rejectSalaryAdvanceRequest(env, storeId, requestId, adminId, String(body.reason || 'Rejected from admin page'))
      );
    }
  }
  return json({ ok: false, error: 'not_found' }, 404);
}

async function handleAdminAttendance(request, env, url, storeId, parts, adminId) {
  if (parts.length === 5 && request.method === 'GET') {
    const filters = await adminFilters(env, url, storeId, adminId);
    if (!filters.ok) return json({ ok: false, error: filters.error }, filters.status);
    const employeeStats = await attendanceEmployeeStats(env, filters);
    const pendingWhere = [
      `p.store_id IN (${placeholders(filters.storeIds.length)})`,
      `p.status = 'pending'`
    ];
    const pendingParams = [...filters.storeIds];
    const approvedWhere = [`a.store_id IN (${placeholders(filters.storeIds.length)})`];
    const approvedParams = [...filters.storeIds];
    const rejectedWhere = [
      `p.store_id IN (${placeholders(filters.storeIds.length)})`,
      `p.status = 'rejected'`
    ];
    const rejectedParams = [...filters.storeIds];
    if (filters.employeeId) {
      pendingWhere.push(`p.telegram_id = ?`);
      pendingParams.push(filters.employeeId);
      approvedWhere.push(`a.telegram_id = ?`);
      approvedParams.push(filters.employeeId);
      rejectedWhere.push(`p.telegram_id = ?`);
      rejectedParams.push(filters.employeeId);
    }
    addRangeFilter(pendingWhere, pendingParams, 'p.business_date', filters.monthDateStart, filters.monthDateEnd);
    addRangeFilter(approvedWhere, approvedParams, 'a.business_date', filters.monthDateStart, filters.monthDateEnd);
    addRangeFilter(rejectedWhere, rejectedParams, 'p.business_date', filters.monthDateStart, filters.monthDateEnd);
    const pendingSelect = (where) => `
      SELECT p.*, COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), p.telegram_id) AS display_name, u.username
      FROM pending_checkout_requests p
      LEFT JOIN users u ON u.telegram_id = p.telegram_id
      LEFT JOIN store_members m ON m.store_id = p.store_id AND m.telegram_id = p.telegram_id
      WHERE ${where.join(' AND ')}
    `;
    const pendingSort = {
      ...adminSortColumns(['request_id','store_id','telegram_id','business_date','timestamp','early_leave','fine','original_fine','status','submitted_at','decided_at','admin_id','reject_reason'], 'p'),
      display_name: 'display_name',
      username: 'u.username'
    };
    const approvedSort = {
      ...adminSortColumns(['record_id','store_id','telegram_id','business_date','type','timestamp','late','early_leave','fine','original_fine'], 'a'),
      display_name: 'display_name',
      username: 'u.username'
    };
    const approved = await listPagedRows(env, url, 'approved_page', 'approved', `
      SELECT
        a.*,
        COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), a.telegram_id) AS display_name,
        u.username
      FROM attendance_records a
      LEFT JOIN users u ON u.telegram_id = a.telegram_id
      LEFT JOIN store_members m ON m.store_id = a.store_id AND m.telegram_id = a.telegram_id
      WHERE ${approvedWhere.join(' AND ')}
    `, `SELECT COUNT(*) AS total FROM attendance_records a WHERE ${approvedWhere.join(' AND ')}`, approvedParams, `ORDER BY a.timestamp DESC`, approvedSort);
    const pending = await listPagedRows(env, url, 'pending_page', 'pending', pendingSelect(pendingWhere), `SELECT COUNT(*) AS total FROM pending_checkout_requests p WHERE ${pendingWhere.join(' AND ')}`, pendingParams, `ORDER BY p.submitted_at DESC`, pendingSort);
    const rejected = await listPagedRows(env, url, 'rejected_page', 'rejected', pendingSelect(rejectedWhere), `SELECT COUNT(*) AS total FROM pending_checkout_requests p WHERE ${rejectedWhere.join(' AND ')}`, rejectedParams, `ORDER BY COALESCE(p.decided_at, p.submitted_at) DESC`, pendingSort);
    return json({
      ok: true,
      pending: pending.pending,
      approved: approved.approved,
      rejected: rejected.rejected,
      employee_stats: employeeStats,
      summary: sumAttendanceEmployeeStats(employeeStats),
      filters,
      pagination: { pending: pending.pagination, approved: approved.pagination, rejected: rejected.pagination }
    });
  }
  if (parts.length >= 7 && request.method === 'POST') {
    const requestId = decodeURIComponent(parts[5]);
    if (parts[6] === 'approve' || parts[6] === 'approve_fine' || parts[6] === 'approve_no_fine') {
      const result = await approveCheckoutRequest(env, storeId, requestId, adminId, parts[6] !== 'approve_no_fine');
      if (result.ok) {
        const empLang = await getUserLang(env, result.row.telegram_id);
        const time = localTime(new Date(result.row.timestamp), result.store.timezone);
        const extra = result.row.early_leave
          ? render(empLang, result.waivedFine ? 'early_waived' : 'early', { fine: formatMoney(result.store, result.row.fine) })
          : t(empLang, 'ontime');
        await sendMessage(env, result.row.telegram_id, render(empLang, 'checkout_done', { date: result.row.business_date, time, extra }));
      }
      return json(result);
    }
    if (parts[6] === 'reject') {
      const body = await readJson(request);
      const result = await rejectCheckoutRequest(env, storeId, requestId, adminId, String(body.reason || 'Rejected from admin page'));
      if (result.ok) {
        const empLang = await getUserLang(env, result.row.telegram_id);
        await sendMessage(env, result.row.telegram_id, render(empLang, 'checkout_rejected', { date: result.row.business_date, reason: result.reason }));
      }
      return json(result);
    }
  }
  return json({ ok: false, error: 'not_found' }, 404);
}

export async function attendanceEmployeeStats(env, filters, now = new Date()) {
  const stores = await env.DB.prepare(`
    SELECT store_id, name, timezone, currency
    FROM stores
    WHERE store_id IN (${placeholders(filters.storeIds.length)})
  `).bind(...filters.storeIds).all();
  const storesById = new Map((stores.results || []).map((store) => [store.store_id, store]));
  const employeeStats = [];

  for (const storeId of filters.storeIds) {
    const store = storesById.get(storeId);
    if (!store) continue;
    const timezone = store.timezone || 'Asia/Tokyo';
    const completedDate = completedAttendanceDate(now, timezone);
    const selectedEnd = filters.monthDateEnd ? addIsoDays(filters.monthDateEnd, -1) : completedDate;
    const endDate = selectedEnd < completedDate ? selectedEnd : completedDate;
    const queryStart = filters.monthDateStart || '0000-01-01';
    const memberWhere = [
      `m.store_id = (SELECT store_id FROM target)`,
      `m.status = 'active'`,
      `((SELECT employee_id FROM target) = '' OR m.telegram_id = (SELECT employee_id FROM target))`
    ];
    const params = [storeId, queryStart, endDate, filters.employeeId || ''];
    const rows = await env.DB.prepare(`
      WITH target AS (
        SELECT ? AS store_id, ? AS start_date, ? AS end_date, ? AS employee_id
      ), attendance_events AS (
        SELECT a.store_id, a.telegram_id, a.business_date, 'work' AS event_kind, 0 AS fine
        FROM attendance_records a, target t
        WHERE a.store_id = t.store_id AND a.business_date BETWEEN t.start_date AND t.end_date
          AND (t.employee_id = '' OR a.telegram_id = t.employee_id)
          AND a.type = 'checkin'
        UNION ALL
        SELECT a.store_id, a.telegram_id, a.business_date, 'late' AS event_kind, 0 AS fine
        FROM attendance_records a, target t
        WHERE a.store_id = t.store_id AND a.business_date BETWEEN t.start_date AND t.end_date
          AND (t.employee_id = '' OR a.telegram_id = t.employee_id)
          AND a.type = 'checkin' AND a.late = 1
      ), leave_events AS (
        SELECT l.store_id, l.telegram_id, l.leave_date AS business_date, 'leave' AS event_kind, 0 AS fine
        FROM leave_requests l, target t
        WHERE l.store_id = t.store_id AND l.leave_date BETWEEN t.start_date AND t.end_date
          AND (t.employee_id = '' OR l.telegram_id = t.employee_id)
          AND l.status = 'approved'
      ), attendance_fines AS (
        SELECT i.store_id, i.telegram_id, a.business_date, 'fine' AS event_kind, i.fine
        FROM income_records i
        JOIN target t ON t.store_id = i.store_id
        JOIN attendance_records a
          ON a.store_id = i.store_id
         AND a.telegram_id = i.telegram_id
         AND a.record_id = i.request_id
         AND a.business_date BETWEEN t.start_date AND t.end_date
         AND ((i.source = 'attendance_late' AND a.type = 'checkin')
           OR (i.source = 'attendance_early' AND a.type = 'checkout'))
        WHERE t.employee_id = '' OR i.telegram_id = t.employee_id
      ), absence_fines AS (
        SELECT i.store_id, i.telegram_id, r.business_date, 'fine' AS event_kind, i.fine
        FROM income_records i
        JOIN target t ON t.store_id = i.store_id
        JOIN absence_fine_requests r
          ON r.store_id = i.store_id
         AND r.telegram_id = i.telegram_id
         AND r.request_id = i.request_id
         AND r.business_date BETWEEN t.start_date AND t.end_date
        WHERE i.source = 'attendance_absence'
          AND (t.employee_id = '' OR i.telegram_id = t.employee_id)
      ), events AS (
        SELECT * FROM attendance_events
        UNION ALL SELECT * FROM leave_events
        UNION ALL SELECT * FROM attendance_fines
        UNION ALL SELECT * FROM absence_fines
      )
      SELECT
        m.store_id,
        s.name AS store_name,
        m.telegram_id,
        COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), m.telegram_id) AS display_name,
        m.joined_at,
        m.absence_check_enabled,
        m.absence_check_enabled_at,
        m.payroll_start_date,
        e.business_date,
        e.event_kind,
        e.fine
      FROM store_members m
      JOIN stores s ON s.store_id = m.store_id
      LEFT JOIN users u ON u.telegram_id = m.telegram_id
      LEFT JOIN events e
        ON e.store_id = m.store_id
       AND e.telegram_id = m.telegram_id
      WHERE ${memberWhere.join(' AND ')}
      ORDER BY display_name, m.telegram_id, e.business_date
    `).bind(...params).all();

    const members = new Map();
    for (const row of rows.results || []) {
      let member = members.get(row.telegram_id);
      if (!member) {
        const joinedDate = localDate(new Date(row.joined_at), timezone);
        const startDate = filters.monthDateStart && filters.monthDateStart > joinedDate
          ? filters.monthDateStart
          : joinedDate;
        const enabledDate = row.absence_check_enabled_at
          ? localDate(new Date(row.absence_check_enabled_at), timezone)
          : startDate;
        const absenceStartDate = [startDate, enabledDate, row.payroll_start_date]
          .filter(Boolean)
          .reduce((latest, date) => date > latest ? date : latest, startDate);
        member = {
          row: {
            store_id: row.store_id,
            store_name: row.store_name,
            currency: store.currency || '',
            telegram_id: row.telegram_id,
            display_name: row.display_name,
            work_days: 0,
            late_days: 0,
            absence_days: 0,
            leave_days: 0,
            fine_total: 0
          },
          startDate,
          absenceStartDate: Number(row.absence_check_enabled) === 1
            && row.payroll_start_date
            ? absenceStartDate
            : null,
          workDates: new Set(),
          lateDates: new Set(),
          leaveDates: new Set()
        };
        members.set(row.telegram_id, member);
      }
      if (!row.business_date || row.business_date < member.startDate || row.business_date > endDate) continue;
      if (row.event_kind === 'work') member.workDates.add(row.business_date);
      if (row.event_kind === 'late') member.lateDates.add(row.business_date);
      if (row.event_kind === 'leave') member.leaveDates.add(row.business_date);
      if (row.event_kind === 'fine') member.row.fine_total += Number(row.fine || 0);
    }

    for (const member of members.values()) {
      if (member.startDate <= endDate) {
        member.row.work_days = member.workDates.size;
        member.row.late_days = member.lateDates.size;
        member.row.leave_days = member.leaveDates.size;
        if (member.absenceStartDate && member.absenceStartDate <= endDate) {
          const attendedOrLeave = new Set(
            [...member.workDates, ...member.leaveDates]
              .filter((businessDate) => businessDate >= member.absenceStartDate)
          );
          const eligibleDays = Math.floor(
            (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${member.absenceStartDate}T00:00:00Z`)) / 86400000
          ) + 1;
          member.row.absence_days = eligibleDays - attendedOrLeave.size;
        }
      }
      employeeStats.push(member.row);
    }
  }

  return employeeStats;
}

async function handleAdminLeave(request, env, url, storeId, parts, adminId) {
  if (parts.length === 5 && request.method === 'GET') {
    const filters = await adminFilters(env, url, storeId, adminId);
    if (!filters.ok) return json({ ok: false, error: filters.error }, filters.status);
    const pendingWhere = [
      `l.store_id IN (${placeholders(filters.storeIds.length)})`,
      `l.status = 'pending'`
    ];
    const pendingParams = [...filters.storeIds];
    const approvedWhere = [
      `l.store_id IN (${placeholders(filters.storeIds.length)})`,
      `l.status = 'approved'`
    ];
    const approvedParams = [...filters.storeIds];
    const rejectedWhere = [
      `l.store_id IN (${placeholders(filters.storeIds.length)})`,
      `l.status = 'rejected'`
    ];
    const rejectedParams = [...filters.storeIds];
    if (filters.employeeId) {
      pendingWhere.push(`l.telegram_id = ?`);
      pendingParams.push(filters.employeeId);
      approvedWhere.push(`l.telegram_id = ?`);
      approvedParams.push(filters.employeeId);
      rejectedWhere.push(`l.telegram_id = ?`);
      rejectedParams.push(filters.employeeId);
    }
    addRangeFilter(pendingWhere, pendingParams, 'l.leave_date', filters.monthDateStart, filters.monthDateEnd);
    addRangeFilter(approvedWhere, approvedParams, 'l.leave_date', filters.monthDateStart, filters.monthDateEnd);
    addRangeFilter(rejectedWhere, rejectedParams, 'l.leave_date', filters.monthDateStart, filters.monthDateEnd);
    const selectSql = (where) => `
      SELECT l.*, COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), l.telegram_id) AS display_name, u.username
      FROM leave_requests l
      LEFT JOIN users u ON u.telegram_id = l.telegram_id
      LEFT JOIN store_members m ON m.store_id = l.store_id AND m.telegram_id = l.telegram_id
      WHERE ${where.join(' AND ')}
    `;
    const leaveSort = {
      ...adminSortColumns(['request_id','store_id','telegram_id','leave_date','status','requested_at','decided_at','admin_id','reject_reason'], 'l'),
      display_name: 'display_name',
      username: 'u.username'
    };
    const pending = await listPagedRows(env, url, 'pending_page', 'pending', selectSql(pendingWhere), `SELECT COUNT(*) AS total FROM leave_requests l WHERE ${pendingWhere.join(' AND ')}`, pendingParams, `ORDER BY l.requested_at DESC`, leaveSort);
    const approved = await listPagedRows(env, url, 'approved_page', 'approved', selectSql(approvedWhere), `SELECT COUNT(*) AS total FROM leave_requests l WHERE ${approvedWhere.join(' AND ')}`, approvedParams, `ORDER BY l.leave_date DESC`, leaveSort);
    const rejected = await listPagedRows(env, url, 'rejected_page', 'rejected', selectSql(rejectedWhere), `SELECT COUNT(*) AS total FROM leave_requests l WHERE ${rejectedWhere.join(' AND ')}`, rejectedParams, `ORDER BY COALESCE(l.decided_at, l.requested_at) DESC`, leaveSort);
    return json({
      ok: true,
      pending: pending.pending,
      approved: approved.approved,
      rejected: rejected.rejected,
      filters,
      pagination: { pending: pending.pagination, approved: approved.pagination, rejected: rejected.pagination }
    });
  }
  if (parts.length >= 7 && request.method === 'POST') {
    const requestId = decodeURIComponent(parts[5]);
    if (parts[6] === 'approve') {
      const result = await approveLeaveRequest(env, storeId, requestId, adminId);
      if (result.ok) {
        const empLang = await getUserLang(env, result.row.telegram_id);
        await sendMessage(env, result.row.telegram_id, render(empLang, 'leave_approved', { date: result.row.leave_date }));
      }
      return json(result);
    }
    if (parts[6] === 'reject') {
      const body = await readJson(request);
      const result = await rejectLeaveRequest(env, storeId, requestId, adminId, String(body.reason || 'Rejected from admin page'));
      if (result.ok) {
        const empLang = await getUserLang(env, result.row.telegram_id);
        await sendMessage(env, result.row.telegram_id, render(empLang, 'leave_rejected', { date: result.row.leave_date, reason: result.reason }));
      }
      return json(result);
    }
  }
  return json({ ok: false, error: 'not_found' }, 404);
}

async function handleAdminAbsence(request, env, url, storeId, parts, adminId) {
  if (parts.length === 5 && request.method === 'GET') {
    const filters = await adminFilters(env, url, storeId, adminId);
    if (!filters.ok) return json({ ok: false, error: filters.error }, filters.status);

    const storeWhere = adminStoreWhere('r', filters.storeIds);
    const baseWhere = [storeWhere.sql];
    const baseParams = [...storeWhere.params];
    if (filters.employeeId) {
      baseWhere.push(`r.telegram_id = ?`);
      baseParams.push(filters.employeeId);
    }
    addRangeFilter(baseWhere, baseParams, 'r.business_date', filters.monthDateStart, filters.monthDateEnd);
    const status = String(url.searchParams.get('status') || '').trim();
    if (['pending', 'approved', 'rejected', 'cancelled'].includes(status)) {
      baseWhere.push(`r.status = ?`);
      baseParams.push(status);
    }

    const pendingWhere = [...baseWhere, `r.status = 'pending'`];
    const historyWhere = [...baseWhere, `r.status <> 'pending'`];
    const selectSql = (where) => `
      WITH notification AS (
        SELECT
          request_id,
          COUNT(*) AS notification_total,
          SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent_total,
          MAX(attempts) AS notification_attempts,
          MAX(last_error) AS notification_last_error
        FROM absence_fine_notifications
        GROUP BY request_id
      )
      SELECT
        r.*,
        s.name AS store_name,
        s.currency,
        s.timezone,
        COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), r.telegram_id) AS display_name,
        u.username,
        i.fine AS actual_fine,
        COALESCE(i.fine, r.fine) AS current_fine,
        CASE
          WHEN n.request_id IS NULL THEN 'not_queued'
          WHEN n.sent_total = n.notification_total THEN 'sent'
          ELSE 'retrying'
        END AS notification_status,
        COALESCE(n.sent_total, 0) AS notification_sent_total,
        COALESCE(n.notification_total, 0) AS notification_total,
        COALESCE(n.notification_attempts, 0) AS notification_attempts,
        n.notification_last_error
      FROM absence_fine_requests r
      JOIN stores s ON s.store_id = r.store_id
      LEFT JOIN users u ON u.telegram_id = r.telegram_id
      LEFT JOIN store_members m ON m.store_id = r.store_id AND m.telegram_id = r.telegram_id
      LEFT JOIN income_records i
        ON i.record_id = r.income_record_id
       AND i.source = 'attendance_absence'
      LEFT JOIN notification n ON n.request_id = r.request_id
      WHERE ${where.join(' AND ')}
    `;
    const absenceSort = absenceAdminSortColumns();
    const pending = await listPagedRows(
      env, url, 'pending_page', 'pending', selectSql(pendingWhere),
      `SELECT COUNT(*) AS total FROM absence_fine_requests r WHERE ${pendingWhere.join(' AND ')}`,
      baseParams, `ORDER BY r.business_date DESC, r.created_at DESC, r.request_id DESC`, absenceSort, `r.request_id DESC`
    );
    const history = await listPagedRows(
      env, url, 'history_page', 'history', selectSql(historyWhere),
      `SELECT COUNT(*) AS total FROM absence_fine_requests r WHERE ${historyWhere.join(' AND ')}`,
      baseParams, `ORDER BY COALESCE(r.decided_at, r.created_at) DESC, r.request_id DESC`, absenceSort, `r.request_id DESC`
    );
    const statusRows = await env.DB.prepare(`
      SELECT r.status, COUNT(*) AS total
      FROM absence_fine_requests r
      WHERE ${baseWhere.join(' AND ')}
      GROUP BY r.status
    `).bind(...baseParams).all();
    const fineRows = await env.DB.prepare(`
      SELECT s.currency, SUM(i.fine) AS amount
      FROM absence_fine_requests r
      JOIN stores s ON s.store_id = r.store_id
      JOIN income_records i
        ON i.record_id = r.income_record_id
       AND i.source = 'attendance_absence'
      WHERE ${baseWhere.join(' AND ')} AND r.status = 'approved'
      GROUP BY s.currency
      ORDER BY s.currency
    `).bind(...baseParams).all();
    const notificationRows = await env.DB.prepare(`
      WITH notification AS (
        SELECT request_id, COUNT(*) AS notification_total,
          SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent_total
        FROM absence_fine_notifications
        GROUP BY request_id
      )
      SELECT
        CASE
          WHEN n.request_id IS NULL THEN 'not_queued'
          WHEN n.sent_total = n.notification_total THEN 'sent'
          ELSE 'retrying'
        END AS status,
        COUNT(*) AS total
      FROM absence_fine_requests r
      LEFT JOIN notification n ON n.request_id = r.request_id
      WHERE ${pendingWhere.join(' AND ')}
      GROUP BY 1
    `).bind(...baseParams).all();
    const statusCounts = Object.fromEntries(
      (statusRows.results || []).map((row) => [row.status, Number(row.total)])
    );
    const notificationCounts = Object.fromEntries(
      (notificationRows.results || []).map((row) => [row.status, Number(row.total)])
    );
    return json({
      ok: true,
      pending: pending.pending,
      history: history.history,
      summary: {
        status_counts: statusCounts,
        fine_totals: (fineRows.results || []).map((row) => ({
          currency: row.currency,
          amount: Number(row.amount || 0)
        })),
        notification_counts: notificationCounts
      },
      filters: { ...filters, status },
      pagination: { pending: pending.pagination, history: history.pagination }
    });
  }
  if (parts.length === 7 && request.method === 'POST') {
    const requestId = decodeURIComponent(parts[5]);
    const found = await env.DB.prepare(`
      SELECT status FROM absence_fine_requests WHERE request_id = ? AND store_id = ?
    `).bind(requestId, storeId).first();
    if (!found) return json({ ok: false, error: 'not_found' }, 404);
    if (found.status !== 'pending') return json({ ok: false, error: 'already_decided' }, 409);

    if (parts[6] === 'approve') {
      const result = await approveAbsenceFineRequest(env, requestId, adminId, storeId);
      return result.ok
        ? json(result)
        : json({ ...result, error: 'already_decided' }, 409);
    }
    if (parts[6] === 'reject') {
      const body = await readJson(request);
      const reason = body && typeof body === 'object' && !Array.isArray(body) && typeof body.reason === 'string'
        ? body.reason.trim()
        : '';
      if (!reason) {
        return json({ ok: false, error: 'rejection_reason_required' }, 400);
      }
      const result = await rejectAbsenceFineRequest(env, requestId, adminId, reason, storeId);
      return result.ok
        ? json(result)
        : json({ ...result, error: 'already_decided' }, 409);
    }
  }
  return json({ ok: false, error: 'not_found' }, 404);
}

async function exportCsv(env, url, storeId, type, adminId) {
  const filters = await adminFilters(env, url, storeId, adminId);
  if (!filters.ok) return json({ ok: false, error: filters.error }, filters.status);
  const storeWhere = `store_id IN (${placeholders(filters.storeIds.length)})`;
  const memberStoreWhere = adminStoreWhere('m', filters.storeIds);
  const map = {
    'members.csv': [`SELECT m.store_id, m.telegram_id, COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), m.telegram_id) AS display_name, u.name AS telegram_name, u.username, m.role, m.status, m.commission_rate, m.cycle_start, m.joined_at, m.updated_at FROM store_members m LEFT JOIN users u ON u.telegram_id = m.telegram_id WHERE ${memberStoreWhere.sql}`, memberStoreWhere.params],
    'income.csv': exportSql(`SELECT * FROM income_records WHERE ${storeWhere}`, [...filters.storeIds], filters, 'approved_at', false, 'ORDER BY approved_at DESC'),
    'salary.csv': exportSql(`SELECT * FROM salary_records WHERE ${storeWhere}`, [...filters.storeIds], filters, 'approved_at', false, 'ORDER BY approved_at DESC'),
    'advances.csv': exportSql(`SELECT * FROM salary_advance_requests WHERE ${storeWhere}`, [...filters.storeIds], filters, 'requested_at', false, 'ORDER BY requested_at DESC'),
    'attendance.csv': exportSql(`SELECT * FROM attendance_records WHERE ${storeWhere}`, [...filters.storeIds], filters, 'business_date', true, 'ORDER BY timestamp DESC'),
    'leave.csv': exportSql(`SELECT * FROM leave_requests WHERE ${storeWhere}`, [...filters.storeIds], filters, 'leave_date', true, 'ORDER BY leave_date DESC, requested_at DESC')
  };
  const item = map[type];
  if (!item) return json({ ok: false, error: 'unknown_export' }, 404);
  const rows = await env.DB.prepare(item[0]).bind(...item[1]).all();
  return new Response(toCsv(rows.results || []), { headers: CSV_HEADERS });
}

async function listRows(env, sql, params, key = 'rows') {
  const rows = await env.DB.prepare(sql).bind(...params).all();
  return json({ ok: true, [key]: rows.results || [] });
}

async function listPagedRows(env, url, pageParam, rowsKey, selectSql, countSql, params, orderSql, sortColumns, tieBreakerSql = '') {
  const totalRow = await env.DB.prepare(countSql).bind(...params).first();
  const pagination = adminPage(url.searchParams.get(pageParam), Number(totalRow && totalRow.total ? totalRow.total : 0));
  const rows = await env.DB.prepare(`${selectSql} ${adminOrderSql(url, pageParam, sortColumns, orderSql, tieBreakerSql)} LIMIT ? OFFSET ?`)
    .bind(...params, pagination.limit, pagination.offset)
    .all();
  return { [rowsKey]: rows.results || [], pagination };
}

async function adminFilters(env, url, fallbackStoreId, adminId) {
  const requestedStoreIds = String(url.searchParams.get('stores') || fallbackStoreId)
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const storeIds = Array.from(new Set(requestedStoreIds.length ? requestedStoreIds : [fallbackStoreId]));
  for (const id of storeIds) {
    if (!(await isStoreAdmin(env, adminId, id))) {
      return { ok: false, error: 'forbidden_store', status: 403 };
    }
  }

  const employeeRaw = String(url.searchParams.get('employee') || '').trim();
  const employeeId = employeeRaw && employeeRaw !== 'all' ? employeeRaw : '';
  const hasDateFilter = url.searchParams.has('date_from') || url.searchParams.has('date_to');
  const dateFrom = String(url.searchParams.get('date_from') || '').trim();
  const dateTo = String(url.searchParams.get('date_to') || '').trim();
  const store = await getStore(env, fallbackStoreId);
  const range = hasDateFilter ? dateRange(dateFrom, dateTo, store && store.timezone) : legacyMonthRange(url);
  return {
    ok: true,
    storeIds,
    employeeId,
    monthFrom: dateFrom,
    monthTo: dateTo,
    monthStart: range ? range.startIso : '',
    monthEnd: range ? range.endIso : '',
    monthDateStart: range ? range.startDate : '',
    monthDateEnd: range ? range.endDate : ''
  };
}

function exportSql(baseSql, params, filters, dateColumn, dateOnly, orderSql) {
  const where = [];
  const nextParams = [...params];
  if (filters.employeeId) {
    where.push('telegram_id = ?');
    nextParams.push(filters.employeeId);
  }
  addRangeFilter(
    where,
    nextParams,
    dateColumn,
    dateOnly ? filters.monthDateStart : filters.monthStart,
    dateOnly ? filters.monthDateEnd : filters.monthEnd
  );
  return [`${baseSql}${where.length ? ` AND ${where.join(' AND ')}` : ''} ${orderSql}`, nextParams];
}

function legacyMonthRange(url) {
  const legacyMonth = String(url.searchParams.get('month') || '').trim();
  const monthFrom = String(url.searchParams.get('month_from') || legacyMonth).trim();
  const monthTo = String(url.searchParams.get('month_to') || legacyMonth || monthFrom).trim();
  return monthRange(monthFrom, monthTo);
}

function parseMonth(month) {
  const match = /^(\d{4})-(\d{2})$/.exec(month || '');
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return null;
  return { year, monthIndex };
}

function monthRange(monthFrom, monthTo) {
  const from = parseMonth(monthFrom);
  const to = parseMonth(monthTo || monthFrom);
  if (!from && !to) return null;
  let startMonth = from || to;
  let endMonth = to || from;
  const startValue = startMonth.year * 12 + startMonth.monthIndex;
  const endValue = endMonth.year * 12 + endMonth.monthIndex;
  if (startValue > endValue) {
    const temp = startMonth;
    startMonth = endMonth;
    endMonth = temp;
  }
  const start = new Date(Date.UTC(startMonth.year, startMonth.monthIndex, 1));
  const end = new Date(Date.UTC(endMonth.year, endMonth.monthIndex + 1, 1));
  return {
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10)
  };
}

function makeNumericCode() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const value = ((bytes[0] << 24) >>> 0) + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3];
  return String(value % 1000000).padStart(6, '0');
}

function cleanStoreId(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40) || makeStoreId();
}

function normalizeStoreInput(input) {
  return {
    store_id: cleanStoreId(input.store_id),
    name: String(input.name || input.store_id || 'Store').trim().slice(0, 80),
    status: ['active', 'disabled'].includes(input.status) ? input.status : 'active',
    timezone: String(input.timezone || 'Asia/Tokyo').trim(),
    currency: String(input.currency || '$').trim().slice(0, 8),
    checkin_time: validTime(input.checkin_time) ? input.checkin_time : '18:30',
    checkout_time: validTime(input.checkout_time) ? input.checkout_time : '01:30',
    late_fine: Number.isFinite(Number(input.late_fine)) ? Number(input.late_fine) : 0.5,
    early_leave_fine: Number.isFinite(Number(input.early_leave_fine)) ? Number(input.early_leave_fine) : 1.5,
    leave_min_notice_days: normalizePositiveInt(input.leave_min_notice_days, 1, 1, 365),
    leave_max_notice_days: Math.max(
      normalizePositiveInt(input.leave_max_notice_days, 5, 1, 365),
      normalizePositiveInt(input.leave_min_notice_days, 1, 1, 365)
    ),
    leave_monthly_limit: normalizePositiveInt(input.leave_monthly_limit, 4, 1, 31),
    leave_daily_limit: normalizePositiveInt(input.leave_daily_limit, 1, 1, 100),
    leave_same_day_cutoff_hour: normalizePositiveInt(input.leave_same_day_cutoff_hour, 5, 0, 23)
  };
}

export function normalizeAbsenceFineSetting(input, currentStore = {}, now = new Date()) {
  const rawFine = Number(input && input.absence_fine);
  const absenceFine = Number.isFinite(rawFine) && rawFine >= 0
    ? rawFine
    : Number(currentStore.absence_fine ?? 1.5);
  const hasEnabled = !!input && Object.prototype.hasOwnProperty.call(input, 'absence_fine_enabled');
  const enabled = hasEnabled
    ? input.absence_fine_enabled === true
    : !!currentStore.absence_fine_enabled_at;
  if (!enabled) {
    return {
      absence_fine: absenceFine,
      absence_fine_enabled_at: null,
      absence_last_checked_date: null
    };
  }
  if (currentStore.absence_fine_enabled_at) {
    return {
      absence_fine: absenceFine,
      absence_fine_enabled_at: currentStore.absence_fine_enabled_at,
      absence_last_checked_date: currentStore.absence_last_checked_date || null
    };
  }
  const timezone = String((input && input.timezone) || currentStore.timezone || 'Asia/Tokyo').trim();
  const enabledDate = localDate(now, timezone);
  return {
    absence_fine: absenceFine,
    absence_fine_enabled_at: now.toISOString(),
    absence_last_checked_date: addIsoDays(enabledDate, -1)
  };
}

export function normalizeEmployeeAbsenceCheck(input, currentMember, now = new Date()) {
  const currentEnabled = currentMember
    ? Number(currentMember.absence_check_enabled) === 1
    : true;
  const currentEnabledAt = currentEnabled
    ? (currentMember ? currentMember.absence_check_enabled_at : now.toISOString())
    : null;
  if (!input || !Object.prototype.hasOwnProperty.call(input, 'absence_check_enabled')) {
    return {
      absence_check_enabled: currentEnabled ? 1 : 0,
      absence_check_enabled_at: currentEnabledAt
    };
  }
  if (input.absence_check_enabled !== true) {
    return { absence_check_enabled: 0, absence_check_enabled_at: null };
  }
  return {
    absence_check_enabled: 1,
    absence_check_enabled_at: currentEnabled ? currentEnabledAt : now.toISOString()
  };
}
