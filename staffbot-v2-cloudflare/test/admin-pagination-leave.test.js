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
  approveLeaveRequest,
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
  deliverAbsenceNotification,
  rejectAbsenceFineRequest,
  sumAttendanceEmployeeStats,
  validateLeaveDate,
  visibleAdminStores
} from '../src/index.js';

const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const wrangler = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const absenceOutboxMigration = readFileSync(new URL('../db/migrations/017_absence_notification_outbox.sql', import.meta.url), 'utf8');

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
      cancellation_reason TEXT,
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
    CREATE TABLE stores (store_id TEXT PRIMARY KEY, name TEXT, timezone TEXT, currency TEXT);
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

    INSERT INTO stores VALUES ('TOKYO', 'Tokyo Club', 'Asia/Tokyo', '¥');
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

function notificationTestDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE absence_fine_requests (
      request_id TEXT PRIMARY KEY, store_id TEXT NOT NULL, status TEXT NOT NULL
    );
    CREATE TABLE absence_fine_notifications (
      request_id TEXT NOT NULL,
      admin_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      claimed_at TEXT,
      sent_at TEXT,
      last_error TEXT,
      PRIMARY KEY (request_id, admin_id)
    );
    CREATE TABLE bot_logs (
      store_id TEXT, level TEXT, event TEXT, telegram_id TEXT,
      message_text TEXT, payload_json TEXT, created_at TEXT
    );
    CREATE TABLE store_members (
      store_id TEXT, telegram_id TEXT, status TEXT, role TEXT
    );
    INSERT INTO absence_fine_requests VALUES ('ABS-1', 'STORE1', 'pending');
    INSERT INTO store_members VALUES ('STORE1', 'A1', 'active', 'admin');
    INSERT INTO store_members VALUES ('STORE1', 'A2', 'active', 'admin');
  `);
  return database;
}

function notificationRow(adminId) {
  return {
    request_id: 'ABS-1', admin_id: adminId, store_id: 'STORE1',
    telegram_id: 'U1', display_name: 'Alice', business_date: '2026-07-14', fine: 1.5
  };
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
    { currency: '¥', work_days: 2, late_days: 1, absence_days: 0, leave_days: 1, fine_total: 500000 },
    { currency: '¥', work_days: 1, late_days: 0, absence_days: 2, leave_days: 0, fine_total: 1500000 }
  ]), {
    work_days: 3,
    late_days: 1,
    absence_days: 2,
    leave_days: 1,
    fine_total: 2000000,
    currency: '¥',
    fine_totals: [{ currency: '¥', amount: 2000000 }]
  });
});

test('groups aggregate attendance fines by currency instead of adding incompatible money', () => {
  assert.deepEqual(sumAttendanceEmployeeStats([
    { currency: '$', work_days: 1, fine_total: 10 },
    { currency: '₫', work_days: 1, fine_total: 1500000 }
  ]), {
    work_days: 2,
    late_days: 0,
    absence_days: 0,
    leave_days: 0,
    fine_total: null,
    currency: null,
    fine_totals: [
      { currency: '$', amount: 10 },
      { currency: '₫', amount: 1500000 }
    ]
  });
});

test('attendance API returns summary and employee statistics', () => {
  assert.match(source, /employee_stats/);
  assert.match(source, /summary: sumAttendanceEmployeeStats/);
});

test('attendance page renders five metrics and a multi-employee drill-down table', () => {
  for (const key of ['work_days', 'late_days', 'absence_days', 'leave_days', 'attendance_fine_total']) {
    assert.match(source, new RegExp(`${key}:`));
  }
  assert.match(source, /attendanceEmployeeSummaryTable/);
  assert.match(source, /data-attendance-detail/);
  assert.match(source, /data-status-tone/);
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
      store_id: 'TOKYO', store_name: 'Tokyo Club', currency: '¥', telegram_id: 'U1', display_name: 'Alice',
      work_days: 3, late_days: 1, absence_days: 1, leave_days: 2, fine_total: 2700000
    },
    {
      store_id: 'TOKYO', store_name: 'Tokyo Club', currency: '¥', telegram_id: 'U2', display_name: 'Bob',
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

test('preserves absence fine enabled state when PATCH omits the switch', () => {
  const current = {
    timezone: 'Asia/Tokyo',
    absence_fine: 1.5,
    absence_fine_enabled_at: '2026-07-01T00:00:00.000Z',
    absence_last_checked_date: '2026-07-12'
  };
  assert.deepEqual(normalizeAbsenceFineSetting({ absence_fine: '2' }, current), {
    absence_fine: 2,
    absence_fine_enabled_at: current.absence_fine_enabled_at,
    absence_last_checked_date: current.absence_last_checked_date
  });
});

test('uses the normalized next timezone for a newly enabled absence boundary', () => {
  const now = new Date('2026-07-14T16:30:00.000Z');
  assert.deepEqual(normalizeAbsenceFineSetting(
    { absence_fine_enabled: true, timezone: 'Asia/Tokyo' },
    { timezone: 'America/Los_Angeles', absence_fine_enabled_at: null },
    now
  ), {
    absence_fine: 1.5,
    absence_fine_enabled_at: now.toISOString(),
    absence_last_checked_date: '2026-07-14'
  });
});

test('admin store form exposes absence fine controls', () => {
  assert.match(source, /storeAbsenceFineEnabledInput/);
  assert.match(source, /storeAbsenceFineInput/);
  assert.match(source, /absence_fine_enabled/);
});

test('migrates absence cancellation audit and per-admin notification outbox', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(`CREATE TABLE absence_fine_requests (request_id TEXT PRIMARY KEY);`);
  database.exec(absenceOutboxMigration);
  assert.ok(database.prepare(`SELECT 1 FROM pragma_table_info('absence_fine_requests') WHERE name = 'cancellation_reason'`).get());
  assert.deepEqual(
    database.prepare(`SELECT name FROM pragma_table_info('absence_fine_notifications') ORDER BY cid`).all().map((row) => row.name),
    ['request_id', 'admin_id', 'status', 'attempts', 'claimed_at', 'sent_at', 'last_error']
  );
  assert.throws(
    () => database.prepare(`INSERT INTO absence_fine_notifications (request_id, admin_id) VALUES ('ABS-1', 'A1'), ('ABS-1', 'A1')`).run(),
    /UNIQUE constraint failed/
  );
});

test('migrates existing members into daily absence checking', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(`CREATE TABLE store_members (store_id TEXT, telegram_id TEXT, joined_at TEXT);`);
  database.exec(`INSERT INTO store_members VALUES ('S1', 'U1', '2026-07-01T00:00:00.000Z');`);
  database.exec(readFileSync('db/migrations/018_employee_absence_check.sql', 'utf8'));
  assert.deepEqual({ ...database.prepare(
    `SELECT absence_check_enabled, absence_check_enabled_at FROM store_members`
  ).get() }, {
    absence_check_enabled: 1,
    absence_check_enabled_at: '2026-07-01T00:00:00.000Z'
  });
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

test('preserves rejected absence decision audit when approved leave cancels it', async () => {
  const database = absenceTestDatabase();
  database.prepare(`
    UPDATE absence_fine_requests
    SET status = 'rejected', decided_at = '2026-07-15T04:00:00.000Z',
        admin_id = 'FINE-ADMIN', reject_reason = 'Employee was absent'
    WHERE request_id = 'ABS-1'
  `).run();
  const result = await cancelAbsenceForApprovedLeave(
    { DB: d1TestDatabase(database) }, 'STORE1', 'U1', '2026-07-14', 'LEAVE-ADMIN'
  );

  assert.equal(result.ok, true);
  assert.deepEqual({ ...database.prepare(`
    SELECT status, decided_at, admin_id, reject_reason, cancellation_reason
    FROM absence_fine_requests WHERE request_id = 'ABS-1'
  `).get() }, {
    status: 'cancelled',
    decided_at: '2026-07-15T04:00:00.000Z',
    admin_id: 'FINE-ADMIN',
    reject_reason: 'Employee was absent',
    cancellation_reason: 'Approved leave'
  });
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

test('retries leave approval atomically after an injected batch failure', async () => {
  const database = absenceTestDatabase();
  database.exec(`
    CREATE TABLE stores (store_id TEXT PRIMARY KEY, leave_daily_limit INTEGER);
    INSERT INTO stores VALUES ('STORE1', 1);
    CREATE TABLE leave_requests (
      request_id TEXT PRIMARY KEY, store_id TEXT, telegram_id TEXT,
      leave_date TEXT, status TEXT, decided_at TEXT, admin_id TEXT
    );
    INSERT INTO leave_requests VALUES ('LEAVE-1', 'STORE1', 'U1', '2026-07-14', 'pending', NULL, NULL);
  `);
  const base = d1TestDatabase(database);
  let failOnce = true;
  const env = {
    DB: {
      ...base,
      async batch(statements) {
        if (failOnce) {
          failOnce = false;
          throw new Error('injected batch failure');
        }
        return base.batch(statements);
      }
    }
  };

  await assert.rejects(
    approveLeaveRequest(env, 'STORE1', 'LEAVE-1', 'LEAVE-ADMIN'),
    /injected batch failure/
  );
  assert.equal(database.prepare(`SELECT status FROM leave_requests`).get().status, 'pending');
  assert.equal(database.prepare(`SELECT status FROM absence_fine_requests`).get().status, 'pending');

  const retry = await approveLeaveRequest(env, 'STORE1', 'LEAVE-1', 'LEAVE-ADMIN');
  assert.equal(retry.ok, true);
  assert.equal(database.prepare(`SELECT status FROM leave_requests`).get().status, 'approved');
  assert.equal(database.prepare(`SELECT status FROM absence_fine_requests`).get().status, 'cancelled');
});

test('reconciles an already-approved leave with its uncancelled absence', async () => {
  const database = absenceTestDatabase();
  database.exec(`
    CREATE TABLE stores (store_id TEXT PRIMARY KEY, leave_daily_limit INTEGER);
    INSERT INTO stores VALUES ('STORE1', 1);
    CREATE TABLE leave_requests (
      request_id TEXT PRIMARY KEY, store_id TEXT, telegram_id TEXT,
      leave_date TEXT, status TEXT, decided_at TEXT, admin_id TEXT
    );
    INSERT INTO leave_requests VALUES (
      'LEAVE-1', 'STORE1', 'U1', '2026-07-14', 'approved',
      '2026-07-15T03:00:00.000Z', 'LEAVE-ADMIN'
    );
  `);
  const result = await approveLeaveRequest(
    { DB: d1TestDatabase(database) }, 'STORE1', 'LEAVE-1', 'LEAVE-ADMIN'
  );
  assert.equal(result.ok, true);
  assert.equal(database.prepare(`SELECT status FROM absence_fine_requests`).get().status, 'cancelled');
});

test('keeps failed Telegram absence notifications pending and retries them', async () => {
  const database = notificationTestDatabase();
  database.prepare(`INSERT INTO absence_fine_notifications (request_id, admin_id) VALUES ('ABS-1', 'A1')`).run();
  const env = { BOT_TOKEN: 'test', DB: d1TestDatabase(database) };
  const originalFetch = globalThis.fetch;
  const results = [{ ok: false, description: 'blocked' }, { ok: true, result: { message_id: 1 } }];
  globalThis.fetch = async () => new Response(JSON.stringify(results.shift()), {
    headers: { 'content-type': 'application/json' }
  });
  try {
    assert.equal(await deliverAbsenceNotification(env, { name: 'Store', currency: '$' }, notificationRow('A1'), new Date('2026-07-15T03:10:00Z')), false);
    assert.equal(database.prepare(`SELECT status FROM absence_fine_notifications`).get().status, 'pending');
    assert.equal(await deliverAbsenceNotification(env, { name: 'Store', currency: '$' }, notificationRow('A1'), new Date('2026-07-15T04:10:00Z')), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual({ ...database.prepare(`SELECT status, attempts FROM absence_fine_notifications`).get() }, {
    status: 'sent', attempts: 2
  });
});

test('tracks partial multi-admin notification success independently', async () => {
  const database = notificationTestDatabase();
  database.exec(`
    INSERT INTO absence_fine_notifications (request_id, admin_id) VALUES ('ABS-1', 'A1');
    INSERT INTO absence_fine_notifications (request_id, admin_id) VALUES ('ABS-1', 'A2');
  `);
  const env = { BOT_TOKEN: 'test', DB: d1TestDatabase(database) };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const adminId = JSON.parse(options.body).chat_id;
    return new Response(JSON.stringify(adminId === 'A1' ? { ok: true } : { ok: false, description: 'blocked' }), {
      headers: { 'content-type': 'application/json' }
    });
  };
  try {
    await Promise.all([
      deliverAbsenceNotification(env, { name: 'Store', currency: '$' }, notificationRow('A1')),
      deliverAbsenceNotification(env, { name: 'Store', currency: '$' }, notificationRow('A2'))
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(database.prepare(`SELECT admin_id, status FROM absence_fine_notifications ORDER BY admin_id`).all().map((row) => ({ ...row })), [
    { admin_id: 'A1', status: 'sent' },
    { admin_id: 'A2', status: 'pending' }
  ]);
});

test('atomically claims an absence notification across overlapping Cron runs', async () => {
  const database = notificationTestDatabase();
  database.prepare(`INSERT INTO absence_fine_notifications (request_id, admin_id) VALUES ('ABS-1', 'A1')`).run();
  const env = { BOT_TOKEN: 'test', DB: d1TestDatabase(database) };
  const originalFetch = globalThis.fetch;
  let sends = 0;
  globalThis.fetch = async () => {
    sends += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const outcomes = await Promise.all([
      deliverAbsenceNotification(env, { name: 'Store', currency: '$' }, notificationRow('A1')),
      deliverAbsenceNotification(env, { name: 'Store', currency: '$' }, notificationRow('A1'))
    ]);
    assert.deepEqual(outcomes.sort(), [false, true]);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(sends, 1);
});

test('cancels a queued absence notification when admin access was revoked', async () => {
  const database = notificationTestDatabase();
  database.prepare(`INSERT INTO absence_fine_notifications (request_id, admin_id) VALUES ('ABS-1', 'A1')`).run();
  database.prepare(`UPDATE store_members SET status = 'disabled' WHERE telegram_id = 'A1'`).run();
  const env = { BOT_TOKEN: 'test', ADMIN_IDS: '', DB: d1TestDatabase(database) };
  const originalFetch = globalThis.fetch;
  let sends = 0;
  globalThis.fetch = async () => { sends += 1; return new Response(JSON.stringify({ ok: true })); };
  try {
    assert.equal(await deliverAbsenceNotification(env, { name: 'Store', currency: '$' }, notificationRow('A1')), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(sends, 0);
  assert.deepEqual({ ...database.prepare(`SELECT status, last_error FROM absence_fine_notifications`).get() }, {
    status: 'cancelled', last_error: 'admin_access_revoked'
  });
});

test('cancels a queued notification when its absence request was already decided', async () => {
  const database = notificationTestDatabase();
  database.prepare(`INSERT INTO absence_fine_notifications (request_id, admin_id) VALUES ('ABS-1', 'A1')`).run();
  database.prepare(`UPDATE absence_fine_requests SET status = 'approved' WHERE request_id = 'ABS-1'`).run();
  const env = { BOT_TOKEN: 'test', ADMIN_IDS: '', DB: d1TestDatabase(database) };
  const originalFetch = globalThis.fetch;
  let sends = 0;
  globalThis.fetch = async () => { sends += 1; return new Response(JSON.stringify({ ok: true })); };
  try {
    assert.equal(await deliverAbsenceNotification(env, { name: 'Store', currency: '$' }, notificationRow('A1')), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(sends, 0);
  assert.deepEqual({ ...database.prepare(`SELECT status, last_error FROM absence_fine_notifications`).get() }, {
    status: 'cancelled', last_error: 'absence_request_not_pending'
  });
});

test('does not steal a fresh sending notification lease', async () => {
  const database = notificationTestDatabase();
  database.prepare(`
    INSERT INTO absence_fine_notifications (request_id, admin_id, status, claimed_at)
    VALUES ('ABS-1', 'A1', 'sending', '2026-07-15T03:05:00.000Z')
  `).run();
  const env = { BOT_TOKEN: 'test', ADMIN_IDS: '', DB: d1TestDatabase(database) };
  const originalFetch = globalThis.fetch;
  let sends = 0;
  globalThis.fetch = async () => { sends += 1; return new Response(JSON.stringify({ ok: true })); };
  try {
    assert.equal(await deliverAbsenceNotification(
      env, { name: 'Store', currency: '$' }, notificationRow('A1'), new Date('2026-07-15T03:10:00.000Z')
    ), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(sends, 0);
  assert.deepEqual({ ...database.prepare(`SELECT status, claimed_at, attempts FROM absence_fine_notifications`).get() }, {
    status: 'sending', claimed_at: '2026-07-15T03:05:00.000Z', attempts: 0
  });
});

test('recovers a sending notification lease older than fifteen minutes', async () => {
  const database = notificationTestDatabase();
  database.prepare(`
    INSERT INTO absence_fine_notifications (request_id, admin_id, status, claimed_at)
    VALUES ('ABS-1', 'A1', 'sending', '2026-07-15T02:54:59.000Z')
  `).run();
  const env = { BOT_TOKEN: 'test', ADMIN_IDS: '', DB: d1TestDatabase(database) };
  const originalFetch = globalThis.fetch;
  let sends = 0;
  globalThis.fetch = async () => { sends += 1; return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } }); };
  try {
    assert.equal(await deliverAbsenceNotification(
      env, { name: 'Store', currency: '$' }, notificationRow('A1'), new Date('2026-07-15T03:10:00.000Z')
    ), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(sends, 1);
  assert.deepEqual({ ...database.prepare(`SELECT status, attempts FROM absence_fine_notifications`).get() }, {
    status: 'sent', attempts: 1
  });
});

test('discovers and notifies each completed-day absence once', async () => {
  const store = {
    store_id: 'TOKYO',
    name: 'Tokyo Club',
    timezone: 'Asia/Tokyo',
    currency: '₫',
    absence_fine: 1.5,
    absence_fine_enabled_at: '2026-07-14T03:00:00.000Z',
    absence_last_checked_date: '2026-07-13'
  };
  const requests = [];
  const notifications = [];
  const outbox = [];
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
          async first() {
            if (/role IN \('admin', 'owner'\)/.test(sql)) {
              return params[1] === '99' ? { telegram_id: '99' } : null;
            }
            throw new Error(`Unexpected first SQL: ${sql}`);
          },
          async all() {
            if (/FROM stores/.test(sql)) return { results: [store] };
            if (/FROM store_members m/.test(sql)) return { results: [
              { telegram_id: '10', joined_at: '2026-07-01T00:00:00.000Z', display_name: 'Alice' },
              { telegram_id: '11', joined_at: '2026-07-15T00:00:00.000Z', display_name: 'Bob' }
            ] };
            if (/FROM absence_fine_requests/.test(sql)) {
              return { results: requests.filter((row) => row.store_id === params[0]) };
            }
            if (/FROM absence_fine_notifications n/.test(sql)) return {
              results: outbox.filter((row) => row.status === 'pending').map((row) => ({
                ...row,
                ...requests.find((request) => request.request_id === row.request_id)
              }))
            };
            if (/role IN \('admin', 'owner'\)/.test(sql)) return { results: [{ telegram_id: '99' }] };
            throw new Error(`Unexpected all SQL: ${sql}`);
          },
          async run() {
            if (/INSERT OR IGNORE INTO absence_fine_requests/.test(sql)) {
              const [request_id, store_id, telegram_id, business_date, original_fine, fine, created_at] = params;
              if (!requests.some((row) => row.store_id === store_id && row.telegram_id === telegram_id && row.business_date === business_date)) {
                requests.push({ request_id, store_id, telegram_id, business_date, original_fine, fine, created_at, display_name: 'Alice', status: 'pending' });
              }
              return { success: true, meta: { changes: 1 } };
            }
            if (/UPDATE stores SET absence_last_checked_date/.test(sql)) {
              store.absence_last_checked_date = params[0];
              return { success: true, meta: { changes: 1 } };
            }
            if (/INSERT OR IGNORE INTO absence_fine_notifications/.test(sql)) {
              const [request_id, admin_id] = params;
              if (!outbox.some((row) => row.request_id === request_id && row.admin_id === admin_id)) {
                outbox.push({ request_id, admin_id, status: 'pending', attempts: 0 });
              }
              return { success: true, meta: { changes: 1 } };
            }
            if (/SET status = 'sending'/.test(sql)) {
              const row = outbox.find((item) => item.request_id === params[1] && item.admin_id === params[2] && item.status === 'pending');
              if (!row) return { success: true, meta: { changes: 0 } };
              row.status = 'sending'; row.attempts += 1; row.claimed_at = params[0];
              return { success: true, meta: { changes: 1 } };
            }
            if (/SET status = 'sent'/.test(sql)) {
              const row = outbox.find((item) => item.request_id === params[1] && item.admin_id === params[2]);
              row.status = 'sent'; row.sent_at = params[0];
              return { success: true, meta: { changes: 1 } };
            }
            if (/SET status = 'pending'/.test(sql)) {
              const row = outbox.find((item) => item.request_id === params[1] && item.admin_id === params[2]);
              row.status = 'pending';
              return { success: true, meta: { changes: 1 } };
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
  assert.equal(requests[0].fine, 1500000);
  assert.equal(store.absence_last_checked_date, '2026-07-14');
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].text, /Tokyo Club/);
  assert.match(notifications[0].text, /Alice/);
  assert.match(notifications[0].text, /2026-07-14/);
  assert.match(notifications[0].text, /₫1,500,000/);
  assert.deepEqual(notifications[0].reply_markup.inline_keyboard, absenceApprovalKeyboard(requests[0].request_id));
  assert.deepEqual(outbox.map((row) => row.status), ['sent']);
  assert.match(source, /m\.role = 'employee'/);
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
