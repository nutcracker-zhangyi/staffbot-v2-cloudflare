import { DEFAULT_STORE_ID } from './constants.js';

const ADMIN_PAGE_SIZE = 100;

export function sumAttendanceEmployeeStats(rows) {
  const totals = { work_days: 0, late_days: 0, absence_days: 0, leave_days: 0 };
  const money = new Map();
  for (const row of rows || []) {
    totals.work_days += Number(row.work_days || 0);
    totals.late_days += Number(row.late_days || 0);
    totals.absence_days += Number(row.absence_days || 0);
    totals.leave_days += Number(row.leave_days || 0);
    const currency = String(row.currency || '');
    money.set(currency, (money.get(currency) || 0) + Number(row.fine_total || 0));
  }
  const fineTotals = [...money].map(([currency, amount]) => ({ currency, amount }));
  return {
    ...totals,
    fine_total: fineTotals.length <= 1 ? (fineTotals[0]?.amount || 0) : null,
    currency: fineTotals.length === 1 ? fineTotals[0].currency : null,
    fine_totals: fineTotals
  };
}

export function adminSortColumns(columns, tableAlias = '') {
  const prefix = tableAlias ? `${tableAlias}.` : '';
  return Object.fromEntries(columns.map((column) => [column, prefix + column]));
}

export function addRangeFilter(where, params, column, start, end) {
  if (start) {
    where.push(`${column} >= ?`);
    params.push(start);
  }
  if (end) {
    where.push(`${column} < ?`);
    params.push(end);
  }
}

export function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(',');
}

export function adminPage(rawPage, total) {
  const totalRows = Math.max(0, Math.floor(Number(total) || 0));
  const totalPages = Math.max(1, Math.ceil(totalRows / ADMIN_PAGE_SIZE));
  const pageNumber = Math.floor(Number(rawPage));
  const page = Math.min(Math.max(Number.isFinite(pageNumber) && pageNumber > 0 ? pageNumber : 1, 1), totalPages);
  return {
    page,
    page_size: ADMIN_PAGE_SIZE,
    total: totalRows,
    total_pages: totalPages,
    has_prev: page > 1,
    has_next: page < totalPages,
    limit: ADMIN_PAGE_SIZE,
    offset: (page - 1) * ADMIN_PAGE_SIZE
  };
}

export function visibleAdminStores(stores) {
  return (stores || []).filter((store) => !store.status || store.status === 'active');
}

export function currentAdminStoreId(stores, selectedStoreIds) {
  return (selectedStoreIds && selectedStoreIds[0]) || (stores[0] && stores[0].store_id) || DEFAULT_STORE_ID;
}

export function adminStoreWhere(tableAlias, storeIds) {
  const ids = storeIds && storeIds.length ? storeIds : [DEFAULT_STORE_ID];
  const prefix = tableAlias ? `${tableAlias}.` : '';
  return { sql: `${prefix}store_id IN (${placeholders(ids.length)})`, params: ids };
}

export function memberListQuery(filterQueryText, pageQueryText) {
  return [filterQueryText, pageQueryText].filter(Boolean).join('&');
}

export function adminOrderSql(url, pageParam, allowedColumns, defaultOrderSql, tieBreakerSql = '') {
  const prefix = String(pageParam || '').replace(/_page$/, '');
  const sort = url.searchParams.get(`${prefix}_sort`);
  const dir = String(url.searchParams.get(`${prefix}_dir`) || '').toLowerCase();
  if (!sort || !allowedColumns || !allowedColumns[sort] || !['asc', 'desc'].includes(dir)) return defaultOrderSql;
  const tieBreaker = tieBreakerSql ? `, ${tieBreakerSql}` : '';
  return `ORDER BY ${allowedColumns[sort]} ${dir.toUpperCase()}${tieBreaker}`;
}

export function absenceAdminSortColumns() {
  return {
    ...adminSortColumns([
      'request_id', 'store_id', 'telegram_id', 'business_date', 'original_fine', 'fine', 'status',
      'created_at', 'notified_at', 'decided_at', 'admin_id', 'reject_reason', 'cancellation_reason',
      'income_record_id'
    ], 'r'),
    display_name: 'display_name',
    username: 'u.username',
    store_name: 's.name',
    currency: 's.currency',
    actual_fine: 'actual_fine',
    notification_status: 'notification_status',
    notification_delivery: `CASE
      WHEN n.request_id IS NULL THEN 0
      WHEN n.sent_total = n.notification_total THEN 2000000000 + COALESCE(n.notification_total, 0)
      ELSE 1000000000 + COALESCE(n.notification_attempts, 0)
    END`,
    decision_reason: `COALESCE(NULLIF(r.reject_reason, ''), r.cancellation_reason, '')`
  };
}

export function resetAdminSortPages(pageState, tab, group) {
  const tabPages = pageState[tab] || {};
  const absencePageKey = tab === 'absence'
    ? { pending: 'absence_pending_page', history: 'absence_history_page' }[group]
    : '';
  const keys = absencePageKey ? [absencePageKey] : Object.keys(tabPages);
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(tabPages, key)) tabPages[key] = 1;
  }
}

export function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => csvCell(row[header])).join(','));
  }
  return lines.join('\n');
}

export function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  if (/[",\n]/.test(safe)) return `"${safe.replaceAll('"', '""')}"`;
  return safe;
}
