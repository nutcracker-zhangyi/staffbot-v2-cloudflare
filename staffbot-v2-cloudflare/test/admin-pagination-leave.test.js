import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  adminPage,
  adminStoreWhere,
  adminOrderSql,
  attendanceEmployeeStats,
  attendanceActionReplyMarkup,
  attendanceAdminActions,
  attendanceFineDecision,
  absenceApprovalKeyboard,
  absenceScanDates,
  approveAbsenceFineRequest,
  cancelAbsenceForApprovedLeave,
  completedAttendanceDate,
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
  normalizeAbsenceFineSetting,
  processAbsenceFines,
  rejectAbsenceFineRequest,
  sumAttendanceEmployeeStats,
  validateLeaveDate,
  visibleAdminStores
} from '../src/index.js';

const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const wrangler = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');

function absenceTestDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE absence_fine_requests (
      request_id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      telegram_id TEXT NOT NULL,
      business_date TEXT NOT NULL,
      original_fine REAL NOT NULL,
      fine REAL NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      decided_at TEXT,
      admin_id TEXT,
      reject_reason TEXT,
      income_record_id TEXT
    );
    CREATE TABLE income_records (
      record_id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      telegram_id TEXT NOT NULL,
      income REAL NOT NULL,
      commission_rate REAL NOT NULL,
      commission_income REAL NOT NULL,
      original_fine REAL NOT NULL,
      fine REAL NOT NULL,
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      request_id TEXT,
      approved_at TEXT NOT NULL,
      admin_id TEXT NOT NULL
    );
    CREATE UNIQUE INDEX one_absence_fine
      ON income_records (source, request_id) WHERE source = 'attendance_absence';
    CREATE TABLE admin_audit_logs (
      store_id TEXT, admin_id TEXT, action TEXT, target_id TEXT,
      details_json TEXT, created_at TEXT
    );
  `);
  database.prepare(`
    INSERT INTO absence_fine_requests
      (request_id, store_id, telegram_id, business_date, original_fine, fine, status, created_at)
    VALUES ('ABS-1', 'STORE1', 'U1', '2026-07-14', 1500000, 1500000, 'pending', '2026-07-15T03:00:00.000Z')
  `).run();
  return database;
}

function d1TestDatabase(database, beforeFirst) {
  function prepare(sql) {
    let params = [];
    return {
      bind(...values) {
        params = values;
        return this;
      },
      async first() {
        const row = database.prepare(sql).get(...params) || null;
        if (beforeFirst) await beforeFirst(sql, row);
        return row;
      },
      async all() {
        return { results: database.prepare(sql).all(...params) };
      },
      async run() {
        return this._run();
      },
      _run() {
        const result = database.prepare(sql).run(...params);
        return { success: true, meta: { changes: Number(result.changes) } };
      }
    };
  }
  return {
    prepare,
    async batch(statements) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((statement) => statement._run());
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    }
  };
}

function attendanceStatsTestDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE stores (store_id TEXT PRIMARY KEY, name TEXT, timezone TEXT);
    CREATE TABLE users (telegram_id TEXT PRIMARY KEY, name TEXT, username TEXT);
    CREATE TABLE store_members (
      store_id TEXT, telegram_id TEXT, display_name TEXT, status TEXT, joined_at TEXT
    );
    CREATE TABLE attendance_records (
      record_id TEXT PRIMARY KEY, store_id TEXT, telegram_id TEXT,
      business_date TEXT, type TEXT, late INTEGER
    );
    CREATE TABLE leave_requests (
      request_id TEXT PRIMARY KEY, store_id TEXT, telegram_id TEXT,
      leave_date TEXT, status TEXT
    );
    CREATE TABLE income_records (
      record_id TEXT PRIMARY KEY, store_id TEXT, telegram_id TEXT,
      fine REAL, source TEXT, request_id TEXT
    );
    CREATE TABLE absence_fine_requests (
      request_id TEXT PRIMARY KEY, store_id TEXT, telegram_id TEXT, business_date TEXT
    );

    INSERT INTO stores VALUES ('TOKYO', 'Tokyo Club', 'Asia/Tokyo');
    INSERT INTO users VALUES ('U1', 'Telegram Alice', 'alice');
    INSERT INTO users VALUES ('U2', 'Bob', 'bob');
    INSERT INTO store_members VALUES ('TOKYO', 'U1', 'Alice', 'active', '2026-07-09T16:00:00.000Z');
    INSERT INTO store_members VALUES ('TOKYO', 'U2', '', 'active', '2026-07-14T02:00:00.000Z');
    INSERT INTO store_members VALUES ('TOKYO', 'U3', 'Disabled', 'disabled', '2026-07-01T00:00:00.000Z');

    INSERT INTO attendance_records VALUES ('IN-10', 'TOKYO', 'U1', '2026-07-10', 'checkin', 1);
    INSERT INTO attendance_records VALUES ('IN-11', 'TOKYO', 'U1', '2026-07-11', 'checkin', 0);
    INSERT INTO attendance_records VALUES ('OUT-11', 'TOKYO', 'U1', '2026-07-11', 'checkout', 0);
    INSERT INTO attendance_records VALUES ('IN-12A', 'TOKYO', 'U1', '2026-07-12', 'checkin', 0);
    INSERT INTO attendance_records VALUES ('IN-12B', 'TOKYO', 'U1', '2026-07-12', 'checkin', 0);
    INSERT INTO attendance_records VALUES ('IN-15', 'TOKYO', 'U1', '2026-07-15', 'checkin', 1);
    INSERT INTO leave_requests VALUES ('LEAVE-12', 'TOKYO', 'U1', '2026-07-12', 'approved');
    INSERT INTO leave_requests VALUES ('LEAVE-13A', 'TOKYO', 'U1', '2026-07-13', 'approved');
    INSERT INTO leave_requests VALUES ('LEAVE-13B', 'TOKYO', 'U1', '2026-07-13', 'approved');
    INSERT INTO leave_requests VALUES ('LEAVE-14', 'TOKYO', 'U1', '2026-07-14', 'rejected');
    INSERT INTO absence_fine_requests VALUES ('ABS-14', 'TOKYO', 'U1', '2026-07-14');
    INSERT INTO income_records VALUES ('F-LATE', 'TOKYO', 'U1', 500000, 'attendance_late', 'IN-10');
    INSERT INTO income_records VALUES ('F-EARLY', 'TOKYO', 'U1', 700000, 'attendance_early', 'OUT-11');
    INSERT INTO income_records VALUES ('F-ABS', 'TOKYO', 'U1', 1500000, 'attendance_absence', 'ABS-14');
    INSERT INTO income_records VALUES ('F-MANUAL', 'TOKYO', 'U1', 9000000, 'manual', NULL);
    INSERT INTO income_records VALUES ('F-FUTURE', 'TOKYO', 'U1', 100000, 'attendance_late', 'IN-15');
  `);
  return database;
}

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

test('sums person-day attendance rows without using pagination', () => {
  assert.deepEqual(sumAttendanceEmployeeStats([
    { work_days: 2, late_days: 1, absence_days: 0, leave_days: 1, fine_total: 500000 },
    { work_days: 1, late_days: 0, absence_days: 2, leave_days: 0, fine_total: 1500000 }
  ]), {
    work_days: 3,
    late_days: 1,
    absence_days: 2,
    leave_days: 1,
    fine_total: 2000000
  });
});

test('attendance API returns summary and employee statistics', () => {
  assert.match(source, /employee_stats/);
  assert.match(source, /summary: sumAttendanceEmployeeStats/);
});

test('returns one full-range attendance statistics row per active employee', async () => {
  const database = attendanceStatsTestDatabase();
  const rows = await attendanceEmployeeStats({ DB: d1TestDatabase(database) }, {
    storeIds: ['TOKYO'],
    employeeId: '',
    monthDateStart: '2026-07-09',
    monthDateEnd: '2026-07-21'
  }, new Date('2026-07-15T03:00:00.000Z'));

  assert.deepEqual(rows, [
    {
      store_id: 'TOKYO', store_name: 'Tokyo Club', telegram_id: 'U1', display_name: 'Alice',
      work_days: 3, late_days: 1, absence_days: 1, leave_days: 2, fine_total: 2700000
    },
    {
      store_id: 'TOKYO', store_name: 'Tokyo Club', telegram_id: 'U2', display_name: 'Bob',
      work_days: 0, late_days: 0, absence_days: 1, leave_days: 0, fine_total: 0
    }
  ]);
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

test('enables absence fines from the current store-local date only', () => {
  const now = new Date('2026-07-14T03:30:00.000Z');
  assert.deepEqual(normalizeAbsenceFineSetting(
    { absence_fine_enabled: true, absence_fine: '1.5' },
    { timezone: 'Asia/Tokyo', absence_fine_enabled_at: null },
    now
  ), {
    absence_fine: 1.5,
    absence_fine_enabled_at: '2026-07-14T03:30:00.000Z',
    absence_last_checked_date: '2026-07-13'
  });
});

test('keeps enable time while enabled and resets it after re-enabling', () => {
  const current = {
    timezone: 'Asia/Tokyo',
    absence_fine: 1.5,
    absence_fine_enabled_at: '2026-07-01T00:00:00.000Z',
    absence_last_checked_date: '2026-07-12'
  };
  assert.equal(normalizeAbsenceFineSetting(
    { absence_fine_enabled: true, absence_fine: '2' }, current,
    new Date('2026-07-14T03:30:00.000Z')
  ).absence_fine_enabled_at, current.absence_fine_enabled_at);
  assert.deepEqual(normalizeAbsenceFineSetting(
    { absence_fine_enabled: false, absence_fine: '2' }, current,
    new Date('2026-07-14T03:30:00.000Z')
  ), {
    absence_fine: 2,
    absence_fine_enabled_at: null,
    absence_last_checked_date: null
  });
});

test('admin store form exposes absence fine controls', () => {
  assert.match(source, /storeAbsenceFineEnabledInput/);
  assert.match(source, /storeAbsenceFineInput/);
  assert.match(source, /absence_fine_enabled/);
});

test('closes the previous business day at store-local noon', () => {
  assert.equal(completedAttendanceDate(new Date('2026-07-15T02:59:00.000Z'), 'Asia/Tokyo'), '2026-07-13');
  assert.equal(completedAttendanceDate(new Date('2026-07-15T03:00:00.000Z'), 'Asia/Tokyo'), '2026-07-14');
  assert.equal(completedAttendanceDate(new Date('2026-07-15T05:00:00.000Z'), 'Asia/Ho_Chi_Minh'), '2026-07-14');
});

test('returns every unprocessed enabled date through the completed date', () => {
  const store = {
    timezone: 'Asia/Tokyo',
    absence_fine_enabled_at: '2026-07-12T03:00:00.000Z',
    absence_last_checked_date: '2026-07-12'
  };
  assert.deepEqual(absenceScanDates(store, new Date('2026-07-15T03:10:00.000Z')), [
    '2026-07-13',
    '2026-07-14'
  ]);
  assert.deepEqual(absenceScanDates({ ...store, absence_fine_enabled_at: null }, new Date('2026-07-15T03:10:00.000Z')), []);
});

test('keeps absence approval callbacks below Telegram limit', () => {
  const requestId = 'ABS-01f21cc1-dcff-4f1a-9bf8-2008d650d46e';
  const buttons = absenceApprovalKeyboard(requestId).flat();
  assert.deepEqual(buttons.map((button) => button.callback_data), [
    `abs:a:${requestId}`,
    `abs:r:${requestId}`
  ]);
  assert.ok(buttons.every((button) => Buffer.byteLength(button.callback_data, 'utf8') <= 64));
});

test('routes compact absence approval callbacks through store authorization', () => {
  assert.match(source, /parts\[0\] === 'abs'/);
  assert.match(source, /approveAbsenceFineRequest/);
  assert.match(source, /rejectAbsenceFineRequest/);
  assert.match(source, /cancelAbsenceForApprovedLeave/);
});

test('absence fines use the existing editable fine record path', () => {
  assert.match(source, /found\.type !== 'fine'/);
  assert.match(source, /source: 'attendance_absence'/);
});

test('approves an absence fine exactly once across replayed requests', async () => {
  const database = absenceTestDatabase();
  const env = { DB: d1TestDatabase(database) };

  const first = await approveAbsenceFineRequest(env, 'ABS-1', 'ADMIN1');
  const replay = await approveAbsenceFineRequest(env, 'ABS-1', 'ADMIN2');

  assert.equal(first.ok, true);
  assert.equal(replay.ok, false);
  assert.equal(database.prepare(`SELECT COUNT(*) AS total FROM income_records`).get().total, 1);
  assert.equal(database.prepare(`SELECT status FROM absence_fine_requests WHERE request_id = 'ABS-1'`).get().status, 'approved');
  assert.equal(database.prepare(`SELECT COUNT(*) AS total FROM admin_audit_logs WHERE action = 'approve_absence_fine'`).get().total, 1);
});

test('reports only the winning concurrent absence decision as successful', async () => {
  const database = absenceTestDatabase();
  let reads = 0;
  let releaseReads;
  const readsReleased = new Promise((resolve) => { releaseReads = resolve; });
  const env = {
    DB: d1TestDatabase(database, async (sql) => {
      if (!/absence_fine_requests WHERE request_id = \? AND status = 'pending'/.test(sql)) return;
      reads += 1;
      if (reads === 2) releaseReads();
      await readsReleased;
    })
  };

  const [approval, rejection] = await Promise.all([
    approveAbsenceFineRequest(env, 'ABS-1', 'ADMIN1'),
    rejectAbsenceFineRequest(env, 'ABS-1', 'ADMIN2')
  ]);

  assert.deepEqual([approval.ok, rejection.ok].sort(), [false, true]);
  assert.equal(database.prepare(`SELECT COUNT(*) AS total FROM income_records`).get().total, approval.ok ? 1 : 0);
  assert.equal(database.prepare(`SELECT COUNT(*) AS total FROM admin_audit_logs`).get().total, 1);
});

test('waives a fine when absence approval commits after the leave cancellation read', async () => {
  const database = absenceTestDatabase();
  let releaseCancellation;
  let cancellationRead;
  const cancellationWasRead = new Promise((resolve) => { cancellationRead = resolve; });
  const cancelEnv = {
    DB: d1TestDatabase(database, async (sql) => {
      if (!/status IN \('pending', 'approved', 'rejected'\)/.test(sql)) return;
      cancellationRead();
      await new Promise((resolve) => { releaseCancellation = resolve; });
    })
  };
  const approvalEnv = { DB: d1TestDatabase(database) };

  const cancellation = cancelAbsenceForApprovedLeave(cancelEnv, 'STORE1', 'U1', '2026-07-14', 'LEAVE-ADMIN');
  await cancellationWasRead;
  const approval = await approveAbsenceFineRequest(approvalEnv, 'ABS-1', 'FINE-ADMIN');
  releaseCancellation();
  const cancelled = await cancellation;

  assert.equal(approval.ok, true);
  assert.equal(cancelled.ok, true);
  assert.equal(database.prepare(`SELECT status FROM absence_fine_requests WHERE request_id = 'ABS-1'`).get().status, 'cancelled');
  const fineRecord = database.prepare(`SELECT fine, original_fine FROM income_records`).get();
  assert.equal(fineRecord.fine, 0);
  assert.equal(fineRecord.original_fine, 1500000);
});

test('does not approve an absence after approved leave cancellation wins the race', async () => {
  const database = absenceTestDatabase();
  let releaseApproval;
  let approvalRead;
  const approvalWasRead = new Promise((resolve) => { approvalRead = resolve; });
  const approvalEnv = {
    DB: d1TestDatabase(database, async (sql) => {
      if (!/absence_fine_requests WHERE request_id = \? AND status = 'pending'/.test(sql)) return;
      approvalRead();
      await new Promise((resolve) => { releaseApproval = resolve; });
    })
  };
  const cancelEnv = { DB: d1TestDatabase(database) };

  const approval = approveAbsenceFineRequest(approvalEnv, 'ABS-1', 'FINE-ADMIN');
  await approvalWasRead;
  const cancelled = await cancelAbsenceForApprovedLeave(cancelEnv, 'STORE1', 'U1', '2026-07-14', 'LEAVE-ADMIN');
  releaseApproval();
  const approved = await approval;

  assert.equal(cancelled.ok, true);
  assert.equal(approved.ok, false);
  assert.equal(database.prepare(`SELECT COUNT(*) AS total FROM income_records`).get().total, 0);
  assert.equal(database.prepare(`SELECT status FROM absence_fine_requests WHERE request_id = 'ABS-1'`).get().status, 'cancelled');
  assert.equal(database.prepare(`SELECT COUNT(*) AS total FROM admin_audit_logs WHERE action = 'approve_absence_fine'`).get().total, 0);
});

test('discovers and notifies each completed-day absence once', async () => {
  const store = {
    store_id: 'TOKYO',
    name: 'Tokyo Club',
    timezone: 'Asia/Tokyo',
    currency: '$',
    absence_fine: 1.5,
    absence_fine_enabled_at: '2026-07-14T03:00:00.000Z',
    absence_last_checked_date: '2026-07-13'
  };
  const requests = [];
  const notifications = [];
  const env = {
    BOT_TOKEN: 'test-token',
    ADMIN_IDS: '',
    DB: {
      prepare(sql) {
        let params = [];
        return {
          bind(...values) {
            params = values;
            return this;
          },
          async all() {
            if (/FROM stores/.test(sql)) return { results: [store] };
            if (/FROM store_members m/.test(sql)) return { results: [
              { telegram_id: '10', joined_at: '2026-07-01T00:00:00.000Z', display_name: 'Alice' },
              { telegram_id: '11', joined_at: '2026-07-15T00:00:00.000Z', display_name: 'Bob' }
            ] };
            if (/FROM absence_fine_requests/.test(sql)) {
              return { results: requests.filter((row) => row.store_id === params[0] && !row.notified_at) };
            }
            if (/role IN \('admin', 'owner'\)/.test(sql)) return { results: [{ telegram_id: '99' }] };
            throw new Error(`Unexpected all SQL: ${sql}`);
          },
          async run() {
            if (/INSERT OR IGNORE INTO absence_fine_requests/.test(sql)) {
              const [request_id, store_id, telegram_id, business_date, original_fine, fine, created_at] = params;
              if (!requests.some((row) => row.store_id === store_id && row.telegram_id === telegram_id && row.business_date === business_date)) {
                requests.push({ request_id, store_id, telegram_id, business_date, original_fine, fine, created_at, display_name: 'Alice' });
              }
              return { success: true };
            }
            if (/UPDATE stores SET absence_last_checked_date/.test(sql)) {
              store.absence_last_checked_date = params[0];
              return { success: true };
            }
            if (/UPDATE absence_fine_requests SET notified_at/.test(sql)) {
              requests.find((row) => row.request_id === params[1]).notified_at = params[0];
              return { success: true };
            }
            throw new Error(`Unexpected run SQL: ${sql}`);
          }
        };
      }
    }
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    notifications.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const now = new Date('2026-07-15T03:10:00.000Z');
    await processAbsenceFines(env, now);
    await processAbsenceFines(env, now);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 1);
  assert.equal(requests[0].telegram_id, '10');
  assert.equal(requests[0].business_date, '2026-07-14');
  assert.equal(requests[0].fine, 1.5);
  assert.equal(store.absence_last_checked_date, '2026-07-14');
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].text, /Tokyo Club/);
  assert.match(notifications[0].text, /Alice/);
  assert.match(notifications[0].text, /2026-07-14/);
  assert.match(notifications[0].text, /\$1\.50/);
  assert.deepEqual(notifications[0].reply_markup.inline_keyboard, absenceApprovalKeyboard(requests[0].request_id));
  assert.ok(requests[0].notified_at);
});

test('registers the absence scan as an hourly Worker Cron', () => {
  assert.match(source, /async scheduled\(controller, env, ctx\)/);
  assert.match(source, /ctx\.waitUntil\(processAbsenceFines\(env, new Date\(controller\.scheduledTime\)\)\)/);
  assert.match(wrangler, /\[triggers\]\s+crons = \["10 \* \* \* \*"\]/);
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
