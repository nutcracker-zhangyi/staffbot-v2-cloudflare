import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  adminPage,
  adminStoreWhere,
  adminOrderSql,
  attendanceActionReplyMarkup,
  attendanceAdminActions,
  attendanceFineDecision,
  currentAdminStoreId,
  dateRange,
  checkoutApprovalKeyboard,
  formatAdminDateTime,
  formatAdminShortDateHour,
  makeStoreId,
  formatAdminMoney,
  memberListQuery,
  leaveDateOptions,
  leaveMonthRange,
  leaveRuleParams,
  validateLeaveDate,
  visibleAdminStores
} from '../src/index.js';

const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

test('normalizes admin pagination to 100 rows per page', () => {
  assert.deepEqual(adminPage('1', 250), {
    page: 1,
    page_size: 100,
    total: 250,
    total_pages: 3,
    has_prev: false,
    has_next: true,
    limit: 100,
    offset: 0
  });
  assert.equal(adminPage('2', 250).offset, 100);
  assert.equal(adminPage('bad', 250).page, 1);
});

test('hides disabled stores from admin store choices', () => {
  assert.deepEqual(visibleAdminStores([
    { store_id: 'A', status: 'active' },
    { store_id: 'B', status: 'disabled' },
    { store_id: 'C' }
  ]).map((store) => store.store_id), ['A', 'C']);
});

test('uses filter store before first active store', () => {
  assert.equal(currentAdminStoreId([{ store_id: 'A' }], ['B']), 'B');
  assert.equal(currentAdminStoreId([{ store_id: 'A' }], []), 'A');
  assert.equal(currentAdminStoreId([], []), 'DEFAULT');
});

test('builds member query and SQL for all selected stores', () => {
  assert.equal(memberListQuery('stores=A%2CB', 'members_page=2'), 'stores=A%2CB&members_page=2');
  assert.deepEqual(adminStoreWhere('m', ['A', 'B']), {
    sql: 'm.store_id IN (?,?)',
    params: ['A', 'B']
  });
});

test('scopes admin filter controls to the active tab', () => {
  for (const id of ['applyFilters', 'filterStores', 'filterMonthFrom', 'filterMonthTo', 'filterEmployee']) {
    assert.doesNotMatch(source, new RegExp(`id="${id}"`));
    assert.doesNotMatch(source, new RegExp(`\\$\\('${id}'\\)`));
  }
  for (const attr of ['data-apply-filters', 'data-filter-stores', 'data-filter-date-from', 'data-filter-date-to', 'data-filter-employee']) {
    assert.match(source, new RegExp(attr));
  }
  assert.doesNotMatch(source, /type="month"/);
});

test('syncs visible filter inputs before admin tab changes', () => {
  assert.match(source, /function syncFilterInputs\(/);
  assert.match(source, /document\.querySelectorAll\('nav button'\)\.forEach\(\(b\) => b\.onclick = \(\) => \{ syncFilterInputs\(\); currentTab = b\.dataset\.tab; loadTab\(\); \}\);/);
});

test('builds admin sort SQL only from allowed fields', () => {
  const allowed = { amount: 'amount', approved_at: 'approved_at' };
  assert.equal(adminOrderSql(new URL('https://x.test/?records_sort=amount&records_dir=asc'), 'records_page', allowed, 'ORDER BY approved_at DESC'), 'ORDER BY amount ASC');
  assert.equal(adminOrderSql(new URL('https://x.test/?records_sort=amount&records_dir=desc'), 'records_page', allowed, 'ORDER BY approved_at DESC'), 'ORDER BY amount DESC');
  assert.equal(adminOrderSql(new URL('https://x.test/?records_sort=1;DROP&records_dir=asc'), 'records_page', allowed, 'ORDER BY approved_at DESC'), 'ORDER BY approved_at DESC');
  assert.equal(adminOrderSql(new URL('https://x.test/?records_sort=amount&records_dir=bad'), 'records_page', allowed, 'ORDER BY approved_at DESC'), 'ORDER BY approved_at DESC');
});

test('formats admin money with comma separators', () => {
  assert.equal(formatAdminMoney(1500000), '1,500,000');
  assert.equal(formatAdminMoney(1234.5), '1,234.5');
  assert.equal(formatAdminMoney(''), '');
});

test('formats admin date time in store timezone', () => {
  assert.equal(formatAdminDateTime('2026-06-24T12:34:56.000Z', 'Asia/Tokyo'), '2026/06/24 21:34:56');
  assert.equal(formatAdminDateTime('2026-06-24', 'Asia/Tokyo'), '2026/06/24 00:00:00');
  assert.equal(formatAdminDateTime('', 'Asia/Tokyo'), '');
});

test('formats income request and approval times as month day and hour only', () => {
  assert.equal(formatAdminShortDateHour('2026-06-24T12:34:56.000Z', 'Asia/Tokyo'), '06/24 21点');
  assert.equal(formatAdminShortDateHour('', 'Asia/Tokyo'), '');
});

test('income records show request and approval time without source column', () => {
  assert.match(source, /incomeActionTable\(data\.records, \['record_id','telegram_id','display_name','type','income','commission_rate','commission_income','original_fine','fine','submitted_at','approved_at','admin_id'\]/);
  assert.doesNotMatch(source, /incomeActionTable\(data\.records, \[[^\]]*'source'[^\]]*\]/);
});

test('validates leave date in the next one to five local days', () => {
  const now = new Date('2026-06-22T12:00:00.000Z');
  const store = { timezone: 'Asia/Tokyo' };

  assert.deepEqual(validateLeaveDate(store, '2026-06-23', now), { ok: true, date: '2026-06-23' });
  assert.deepEqual(validateLeaveDate(store, '2026-06-27', now), { ok: true, date: '2026-06-27' });
  assert.equal(validateLeaveDate(store, '2026-06-22', now).ok, false);
  assert.equal(validateLeaveDate(store, '2026-06-28', now).ok, false);
  assert.equal(validateLeaveDate(store, '2026/06/23', now).ok, false);
});

test('allows same-day leave before 5am in the store timezone only', () => {
  const store = { timezone: 'Asia/Ho_Chi_Minh' };

  assert.deepEqual(validateLeaveDate(store, '2026-06-22', new Date('2026-06-21T21:59:00.000Z')), { ok: true, date: '2026-06-22' });
  assert.equal(validateLeaveDate(store, '2026-06-22', new Date('2026-06-21T22:00:00.000Z')).ok, false);
  assert.deepEqual(leaveDateOptions(store, new Date('2026-06-21T21:59:00.000Z'))[0], '2026-06-22');
});

test('uses store setting for same-day leave cutoff hour', () => {
  const store = { timezone: 'Asia/Ho_Chi_Minh', leave_same_day_cutoff_hour: 3 };

  assert.deepEqual(validateLeaveDate(store, '2026-06-22', new Date('2026-06-21T19:59:00.000Z')), { ok: true, date: '2026-06-22' });
  assert.equal(validateLeaveDate(store, '2026-06-22', new Date('2026-06-21T20:00:00.000Z')).ok, false);
  assert.deepEqual(leaveDateOptions(store, new Date('2026-06-21T19:59:00.000Z'))[0], '2026-06-22');
  assert.deepEqual(leaveRuleParams(store, new Date('2026-06-21T19:59:00.000Z')), { min: 0, max: 5 });
});

test('validates leave date with store-specific rule settings', () => {
  const now = new Date('2026-06-22T12:00:00.000Z');
  const store = { timezone: 'Asia/Tokyo', leave_min_notice_days: 2, leave_max_notice_days: 3 };

  assert.equal(validateLeaveDate(store, '2026-06-23', now).ok, false);
  assert.deepEqual(validateLeaveDate(store, '2026-06-24', now), { ok: true, date: '2026-06-24' });
  assert.deepEqual(validateLeaveDate(store, '2026-06-25', now), { ok: true, date: '2026-06-25' });
  assert.equal(validateLeaveDate(store, '2026-06-26', now).ok, false);
});

test('builds selectable leave date options from store settings', () => {
  const now = new Date('2026-06-22T12:00:00.000Z');
  const store = { timezone: 'Asia/Tokyo', leave_min_notice_days: 2, leave_max_notice_days: 4 };

  assert.deepEqual(leaveDateOptions(store, now), ['2026-06-24', '2026-06-25', '2026-06-26']);
});

test('returns leave month boundaries for counting monthly leave days', () => {
  assert.deepEqual(leaveMonthRange('2026-06-23'), {
    startDate: '2026-06-01',
    endDate: '2026-07-01'
  });
});

test('returns inclusive admin date filter boundaries', () => {
  assert.deepEqual(dateRange('', ''), {
    startIso: '',
    endIso: '',
    startDate: '',
    endDate: ''
  });
  assert.deepEqual(dateRange('2026-07-08', ''), {
    startIso: '2026-07-08T00:00:00.000Z',
    endIso: '',
    startDate: '2026-07-08',
    endDate: ''
  });
  assert.deepEqual(dateRange('', '2026-07-08'), {
    startIso: '',
    endIso: '2026-07-09T00:00:00.000Z',
    startDate: '',
    endDate: '2026-07-09'
  });
  assert.deepEqual(dateRange('2026-07-10', '2026-07-08'), {
    startIso: '2026-07-08T00:00:00.000Z',
    endIso: '2026-07-11T00:00:00.000Z',
    startDate: '2026-07-08',
    endDate: '2026-07-11'
  });
});

test('returns admin date filter boundaries in the store timezone', () => {
  assert.deepEqual(dateRange('2026-07-01', '2026-07-01', 'Asia/Tokyo'), {
    startIso: '2026-06-30T15:00:00.000Z',
    endIso: '2026-07-01T15:00:00.000Z',
    startDate: '2026-07-01',
    endDate: '2026-07-02'
  });
});

test('builds attendance action buttons without keeping reply keyboard', () => {
  assert.deepEqual(attendanceActionReplyMarkup('STORE1', 'zh'), {
    inline_keyboard: [[
      { text: '上班签到', callback_data: 'att:in:STORE1' },
      { text: '下班签退', callback_data: 'att:out:STORE1' }
    ]]
  });
});

test('keeps checkout approval callback data under Telegram limit', () => {
  const requestId = 'OUT-5b24d17a-9ebf-4d1a-8754-c4fbb36c8ad4';
  const buttons = checkoutApprovalKeyboard('DEFAULT', requestId, 1500000).flat();

  assert.deepEqual(buttons.map((button) => button.callback_data), [
    `att:af:DEFAULT:${requestId}`,
    `att:anf:DEFAULT:${requestId}`,
    `att:reject:DEFAULT:${requestId}`
  ]);
  assert.ok(buttons.every((button) => Buffer.byteLength(button.callback_data, 'utf8') <= 64));
});

test('uses split admin attendance approval actions only when a fine exists', () => {
  assert.deepEqual(attendanceAdminActions(1500000), ['approve_fine', 'approve_no_fine', 'reject']);
  assert.deepEqual(attendanceAdminActions(0), ['approve', 'reject']);
});

test('keeps original checkout fine when admin waives it', () => {
  assert.deepEqual(attendanceFineDecision(1500000, false), { fine: 0, originalFine: 1500000 });
  assert.deepEqual(attendanceFineDecision(1500000, true), { fine: 1500000, originalFine: 1500000 });
  assert.deepEqual(attendanceFineDecision(0, false), { fine: 0, originalFine: 0 });
});

test('generates short automatic store ids', () => {
  const id = makeStoreId();
  assert.match(id, /^STORE_[A-F0-9]{6}$/);
  assert.ok(id.length <= 12);
});
