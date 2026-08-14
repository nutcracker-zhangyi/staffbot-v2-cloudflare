import { addIsoDays, dateRange, localDate } from './dates.js';
import { adminPage } from './admin-query.js';
import { serviceEnvironment } from './security.js';
import { isStoreAdmin } from './stores.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMPLOYEE_SORTS = new Set([
  'display_name',
  'gross_income_micros',
  'commission_micros',
  'fine_micros',
  'advance_micros',
  'net_payroll_micros',
  'paid_salary_micros'
]);

const MONEY_FIELDS = [
  'gross_income_micros',
  'commission_micros',
  'fine_micros',
  'advance_micros',
  'bonus_micros',
  'adjustment_micros',
  'negative_carry_micros',
  'reversal_micros',
  'net_payroll_micros',
  'paid_salary_micros'
];

const TYPE_FIELD = {
  income: 'commission_micros',
  fine: 'fine_micros',
  advance: 'advance_micros',
  bonus: 'bonus_micros',
  adjustment: 'adjustment_micros',
  negative_carry: 'negative_carry_micros',
  reversal: 'reversal_micros'
};

const LEDGER_TYPES = Object.keys(TYPE_FIELD);
const PERIODS_CTE = `
  WITH periods AS (
    SELECT
      CAST(json_extract(value, '$.store_id') AS TEXT) AS store_id,
      CAST(json_extract(value, '$.store_currency') AS TEXT) AS store_currency,
      CAST(json_extract(value, '$.month_key') AS TEXT) AS month_key,
      CAST(json_extract(value, '$.start_iso') AS TEXT) AS start_iso,
      CAST(json_extract(value, '$.end_iso') AS TEXT) AS end_iso
    FROM json_each(?)
  )
`;

export class DashboardInputError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'DashboardInputError';
    this.code = code;
    this.status = status;
  }
}

export function dashboardAvailable(env) {
  return serviceEnvironment(env) === 'staging';
}

function validIsoDate(value) {
  const text = String(value || '').trim();
  if (!ISO_DATE.test(text)) return '';
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text
    ? ''
    : text;
}

function lastDayOfMonth(isoDate) {
  const [year, month] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

export function dashboardSelection(
  dateFromRaw,
  dateToRaw,
  fallbackTimezone = 'UTC',
  now = new Date()
) {
  const rawFrom = String(dateFromRaw || '').trim();
  const rawTo = String(dateToRaw || '').trim();
  if (!rawFrom && !rawTo) {
    const currentLocalDate = localDate(now, fallbackTimezone || 'UTC');
    const dateFrom = `${currentLocalDate.slice(0, 7)}-01`;
    return {
      date_from: dateFrom,
      date_to: lastDayOfMonth(dateFrom)
    };
  }
  const dateFrom = validIsoDate(rawFrom);
  const dateTo = validIsoDate(rawTo);
  if (!dateFrom || !dateTo || dateFrom > dateTo) {
    throw new DashboardInputError('invalid_date_range');
  }
  return { date_from: dateFrom, date_to: dateTo };
}

function monthSegments(dateFrom, dateTo) {
  const segments = [];
  let cursor = dateFrom;
  while (cursor <= dateTo) {
    const segmentEnd = [lastDayOfMonth(cursor), dateTo].sort()[0];
    segments.push({
      month_key: cursor.slice(0, 7),
      date_from: cursor,
      date_to: segmentEnd
    });
    cursor = addIsoDays(segmentEnd, 1);
  }
  return segments;
}

export function dashboardPeriods(stores, selection) {
  return monthSegments(selection.date_from, selection.date_to).flatMap((segment) =>
    stores.map((store) => {
      const range = dateRange(
        segment.date_from,
        segment.date_to,
        store.timezone || 'UTC'
      );
      return {
        store_id: store.store_id,
        store_currency: store.currency,
        timezone: store.timezone || 'UTC',
        month_key: segment.month_key,
        start_iso: range.startIso,
        end_iso: range.endIso
      };
    })
  );
}

export function dashboardPeriodsJson(periods) {
  return JSON.stringify(periods);
}

function dashboardStoreIds(url, fallbackStoreId) {
  const selected = String(url.searchParams.get('stores') || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const storeIds = [...new Set(selected)];
  return storeIds.length ? storeIds : [String(fallbackStoreId || '').trim()];
}

function dashboardEmployeeSort(url) {
  const sort = url.searchParams.get('employees_sort');
  const direction = url.searchParams.get('employees_dir');
  if ((sort && !EMPLOYEE_SORTS.has(sort))
    || (direction && !['asc', 'desc'].includes(direction))) {
    throw new DashboardInputError('invalid_sort');
  }
  return {
    employeeSort: sort || 'net_payroll_micros',
    employeeDir: direction || 'desc'
  };
}

export async function resolveDashboardFilters(
  env,
  url,
  fallbackStoreId,
  adminId,
  now = new Date()
) {
  const storeIds = dashboardStoreIds(url, fallbackStoreId);
  for (const storeId of storeIds) {
    if (!await isStoreAdmin(env, adminId, storeId)) {
      throw new DashboardInputError('forbidden_store', 403);
    }
  }

  const storeRows = await env.DB.prepare(`
    SELECT store_id, timezone, currency
    FROM stores
    WHERE status = 'active'
      AND store_id IN (SELECT value FROM json_each(?))
    ORDER BY store_id
  `).bind(JSON.stringify(storeIds)).all();
  const stores = storeRows.results || [];
  if (stores.length !== storeIds.length) {
    throw new DashboardInputError('unknown_store');
  }

  let fallbackStore = stores.find((store) => store.store_id === fallbackStoreId);
  if (!fallbackStore) {
    fallbackStore = await env.DB.prepare(`
      SELECT timezone FROM stores WHERE store_id = ? AND status = 'active'
    `).bind(fallbackStoreId).first();
  }
  const selection = dashboardSelection(
    url.searchParams.get('date_from'),
    url.searchParams.get('date_to'),
    fallbackStore?.timezone || 'UTC',
    now
  );
  const rawEmployee = String(url.searchParams.get('employee') || '').trim();
  const employeeId = rawEmployee && rawEmployee !== 'all' ? rawEmployee : '';
  if (employeeId) {
    const member = await env.DB.prepare(`
      SELECT 1 FROM store_members
      WHERE telegram_id = ?
        AND store_id IN (SELECT value FROM json_each(?))
      LIMIT 1
    `).bind(employeeId, JSON.stringify(storeIds)).first();
    if (!member) throw new DashboardInputError('unknown_employee');
  }
  const { employeeSort, employeeDir } = dashboardEmployeeSort(url);

  return {
    storeIds,
    stores,
    employeeId,
    dateFrom: selection.date_from,
    dateTo: selection.date_to,
    periods: dashboardPeriods(stores, selection),
    employeeSort,
    employeeDir
  };
}

function zeroMoney() {
  return Object.fromEntries(MONEY_FIELDS.map((field) => [field, 0]));
}

function safeMicros(value) {
  const micros = Number(value);
  if (!Number.isSafeInteger(micros)) {
    throw new RangeError('unsafe_micros');
  }
  return micros;
}

function dashboardEmployee(telegramId, displayName, role = '') {
  return {
    telegram_id: telegramId,
    display_name: displayName || telegramId,
    role,
    ...zeroMoney()
  };
}

function dashboardGroup(currency) {
  return {
    currency,
    summary: { ...zeroMoney(), employee_count: 0 },
    months: [],
    employees: [],
    activeEmployeeIds: new Set(),
    composition: LEDGER_TYPES.map((type) => ({ type, amount_micros: 0 }))
  };
}

function groupMonth(group, monthKey) {
  let month = group.months.find((item) => item.month_key === monthKey);
  if (!month) {
    month = { month_key: monthKey, ...zeroMoney() };
    group.months.push(month);
  }
  return month;
}

function groupEmployee(group, telegramId, displayName, role = '') {
  let employee = group.employees.find((item) => item.telegram_id === telegramId);
  if (!employee) {
    employee = dashboardEmployee(telegramId, displayName, role);
    group.employees.push(employee);
  }
  return employee;
}

function addMoney(group, monthKey, telegramId, displayName, role, field, amount) {
  const micros = safeMicros(amount);
  const employee = groupEmployee(group, telegramId, displayName, role);
  const month = groupMonth(group, monthKey);
  group.summary[field] = safeAdd(group.summary[field], micros);
  employee[field] = safeAdd(employee[field], micros);
  month[field] = safeAdd(month[field], micros);
}

function safeAdd(left, right) {
  return safeMicros(safeMicros(left) + safeMicros(right));
}

function assertSafeDashboardMicros(group) {
  for (const row of [group.summary, ...group.months, ...group.employees]) {
    for (const field of MONEY_FIELDS) safeMicros(row[field]);
  }
  for (const item of group.composition) safeMicros(item.amount_micros);
}

export function sortDashboardEmployees(rows, sortKey, sortDirection) {
  return [...rows].sort((left, right) => {
    const leftValue = left[sortKey];
    const rightValue = right[sortKey];
    let comparison;
    if (sortKey === 'display_name') {
      comparison = String(leftValue).localeCompare(String(rightValue));
    } else {
      comparison = Number(leftValue) - Number(rightValue);
    }
    if (comparison) return sortDirection === 'desc' ? -comparison : comparison;
    return String(left.telegram_id).localeCompare(String(right.telegram_id));
  });
}

export async function loadDashboard(env, filters) {
  const periodsJson = dashboardPeriodsJson(filters.periods);
  const employee = filters.employeeId;
  const [memberResult, grossResult, ledgerResult, paymentResult] = await Promise.all([
    env.DB.prepare(`${PERIODS_CTE}
      SELECT
        s.currency AS currency,
        m.telegram_id,
        MIN(COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), m.telegram_id)) AS display_name,
        MIN(m.role) AS role
      FROM store_members m
      JOIN stores s ON s.store_id = m.store_id
      JOIN (SELECT DISTINCT store_id FROM periods) p ON p.store_id = m.store_id
      LEFT JOIN users u ON u.telegram_id = m.telegram_id
      WHERE s.status = 'active'
        AND m.status = 'active'
        AND (? = '' OR m.telegram_id = ?)
      GROUP BY s.currency, m.telegram_id
    `).bind(periodsJson, employee, employee).all(),
    env.DB.prepare(`${PERIODS_CTE}
      SELECT
        p.store_currency AS currency,
        p.month_key,
        r.telegram_id,
        MIN(COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), r.telegram_id)) AS display_name,
        MIN(COALESCE(m.role, '')) AS role,
        SUM(ROUND(r.income * 1000000)) AS gross_income_micros
      FROM income_records r
      JOIN periods p ON p.store_id = r.store_id
      LEFT JOIN store_members m ON m.store_id = r.store_id AND m.telegram_id = r.telegram_id
      LEFT JOIN users u ON u.telegram_id = r.telegram_id
      WHERE r.type = 'income'
        AND r.approved_at >= p.start_iso
        AND r.approved_at < p.end_iso
        AND (? = '' OR r.telegram_id = ?)
      GROUP BY p.store_currency, p.month_key, r.telegram_id
    `).bind(periodsJson, employee, employee).all(),
    env.DB.prepare(`${PERIODS_CTE}
      SELECT
        e.currency AS currency,
        p.month_key,
        e.telegram_id,
        e.type,
        MIN(COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), e.telegram_id)) AS display_name,
        MIN(COALESCE(m.role, '')) AS role,
        SUM(e.amount_micros) AS amount_micros
      FROM payroll_entries e
      JOIN periods p ON p.store_id = e.store_id
      LEFT JOIN store_members m ON m.store_id = e.store_id AND m.telegram_id = e.telegram_id
      LEFT JOIN users u ON u.telegram_id = e.telegram_id
      WHERE e.effective_at >= p.start_iso
        AND e.effective_at < p.end_iso
        AND (? = '' OR e.telegram_id = ?)
      GROUP BY e.currency, p.month_key, e.telegram_id, e.type
    `).bind(periodsJson, employee, employee).all(),
    env.DB.prepare(`${PERIODS_CTE}
      SELECT
        p.store_currency AS currency,
        p.month_key,
        s.telegram_id,
        MIN(COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), s.telegram_id)) AS display_name,
        MIN(COALESCE(m.role, '')) AS role,
        SUM(ROUND(s.amount * 1000000)) AS paid_salary_micros
      FROM salary_records s
      JOIN periods p ON p.store_id = s.store_id
      LEFT JOIN store_members m ON m.store_id = s.store_id AND m.telegram_id = s.telegram_id
      LEFT JOIN users u ON u.telegram_id = s.telegram_id
      WHERE s.approved_at >= p.start_iso
        AND s.approved_at < p.end_iso
        AND (? = '' OR s.telegram_id = ?)
      GROUP BY p.store_currency, p.month_key, s.telegram_id
    `).bind(periodsJson, employee, employee).all()
  ]);

  const groups = new Map();
  const getGroup = (currency) => {
    if (!groups.has(currency)) groups.set(currency, dashboardGroup(currency));
    return groups.get(currency);
  };
  for (const row of memberResult.results || []) {
    const group = getGroup(row.currency);
    group.activeEmployeeIds.add(row.telegram_id);
    groupEmployee(group, row.telegram_id, row.display_name, row.role);
  }
  for (const row of grossResult.results || []) {
    addMoney(getGroup(row.currency), row.month_key, row.telegram_id, row.display_name, row.role,
      'gross_income_micros', row.gross_income_micros);
  }
  for (const row of ledgerResult.results || []) {
    const field = TYPE_FIELD[row.type];
    if (!field) continue;
    const group = getGroup(row.currency);
    const amount = safeMicros(row.amount_micros);
    addMoney(group, row.month_key, row.telegram_id, row.display_name, row.role, field, amount);
    addMoney(group, row.month_key, row.telegram_id, row.display_name, row.role, 'net_payroll_micros', amount);
    const composition = group.composition.find((item) => item.type === row.type);
    composition.amount_micros = safeAdd(composition.amount_micros, amount);
  }
  for (const row of paymentResult.results || []) {
    addMoney(getGroup(row.currency), row.month_key, row.telegram_id, row.display_name, row.role,
      'paid_salary_micros', row.paid_salary_micros);
  }

  for (const period of filters.periods) {
    const group = groups.get(period.store_currency);
    if (group) groupMonth(group, period.month_key);
  }
  for (const group of groups.values()) assertSafeDashboardMicros(group);
  const orderedGroups = [...groups.values()].sort((left, right) =>
    left.currency.localeCompare(right.currency)
  ).map(({ activeEmployeeIds, ...group }) => ({
    ...group,
    months: group.months.sort((left, right) => left.month_key.localeCompare(right.month_key)),
    employees: sortDashboardEmployees(group.employees, filters.employeeSort, filters.employeeDir),
    summary: { ...group.summary, employee_count: activeEmployeeIds.size }
  }));

  return {
    ok: true,
    filters: {
      store_ids: filters.storeIds,
      date_from: filters.dateFrom,
      date_to: filters.dateTo,
      employee: filters.employeeId || null
    },
    groups: orderedGroups
  };
}

export async function loadDashboardEntries(env, url, filters) {
  const periodsJson = dashboardPeriodsJson(filters.periods);
  const employee = filters.employeeId;
  const count = await env.DB.prepare(`${PERIODS_CTE}
    SELECT COUNT(*) AS total
    FROM payroll_entries e
    JOIN periods p
      ON p.store_id = e.store_id
     AND e.effective_at >= p.start_iso
     AND e.effective_at < p.end_iso
    WHERE (? = '' OR e.telegram_id = ?)
  `).bind(periodsJson, employee, employee).first();
  const pagination = adminPage(url.searchParams.get('entries_page'), count?.total);
  const entryResult = await env.DB.prepare(`${PERIODS_CTE}
    SELECT
      e.entry_id,
      e.store_id,
      e.telegram_id,
      COALESCE(
        NULLIF(m.display_name, ''),
        NULLIF(u.name, ''),
        NULLIF(u.username, ''),
        e.telegram_id
      ) AS display_name,
      e.type,
      e.amount_micros,
      e.currency,
      e.effective_at,
      e.source,
      e.source_id,
      e.created_at,
      e.reverses_entry_id
    FROM payroll_entries e
    JOIN periods p
      ON p.store_id = e.store_id
     AND e.effective_at >= p.start_iso
     AND e.effective_at < p.end_iso
    LEFT JOIN store_members m
      ON m.store_id = e.store_id
     AND m.telegram_id = e.telegram_id
    LEFT JOIN users u ON u.telegram_id = e.telegram_id
    WHERE (? = '' OR e.telegram_id = ?)
    ORDER BY e.effective_at DESC, e.entry_id DESC
    LIMIT ? OFFSET ?
  `).bind(
    periodsJson,
    employee,
    employee,
    pagination.limit,
    pagination.offset
  ).all();
  const entries = (entryResult.results || []).map((entry) => ({
    ...entry,
    amount_micros: safeMicros(entry.amount_micros)
  }));

  return {
    ok: true,
    entries,
    pagination: { entries: pagination }
  };
}
