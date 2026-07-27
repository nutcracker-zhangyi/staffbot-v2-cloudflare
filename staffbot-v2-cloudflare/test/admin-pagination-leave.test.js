import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import worker, {
  ABSENCE_HISTORY_COLUMNS,
  ABSENCE_PENDING_COLUMNS,
  adminPage,
  adminStoreWhere,
  adminOrderSql,
  absenceAdminSortColumns,
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
  normalizeEmployeeAbsenceCheck,
  processAbsenceFines,
  resetAdminSortPages,
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

function absenceAdminApiEnv(database, hooks = {}) {
  database.exec(`
    CREATE TABLE admin_sessions (
      token TEXT PRIMARY KEY, telegram_id TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
    );
    INSERT INTO admin_sessions VALUES (
      'absence-session', 'ADMIN1', '2099-01-01T00:00:00.000Z', '2026-07-15T00:00:00.000Z'
    );
  `);
  return {
    ENVIRONMENT: 'production',
    BOT_TOKEN: 'test-token',
    WEBHOOK_SECRET: 'test-secret',
    ADMIN_IDS: 'ADMIN1',
    DB: d1TestDatabase(database, null, hooks)
  };
}

function adminAbsenceRequest(path, body) {
  return new Request(`https://example.com${path}`, {
    method: 'POST',
    headers: {
      cookie: 'staffbot_admin_session=absence-session',
      'content-type': 'application/json'
    },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}

function absenceAdminQueryDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE admin_sessions (
      token TEXT PRIMARY KEY, telegram_id TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE stores (
      store_id TEXT PRIMARY KEY, name TEXT, status TEXT, timezone TEXT, currency TEXT
    );
    CREATE TABLE users (telegram_id TEXT PRIMARY KEY, name TEXT, username TEXT);
    CREATE TABLE store_members (
      store_id TEXT NOT NULL, telegram_id TEXT NOT NULL, display_name TEXT,
      PRIMARY KEY (store_id, telegram_id)
    );
    CREATE TABLE absence_fine_requests (
      request_id TEXT PRIMARY KEY, store_id TEXT NOT NULL, telegram_id TEXT NOT NULL,
      business_date TEXT NOT NULL, original_fine REAL NOT NULL, fine REAL NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL, notified_at TEXT, decided_at TEXT,
      admin_id TEXT, reject_reason TEXT, cancellation_reason TEXT, income_record_id TEXT
    );
    CREATE TABLE income_records (
      record_id TEXT PRIMARY KEY, store_id TEXT NOT NULL, telegram_id TEXT NOT NULL,
      fine REAL NOT NULL, source TEXT NOT NULL, request_id TEXT, approved_at TEXT NOT NULL
    );
    CREATE TABLE absence_fine_notifications (
      request_id TEXT NOT NULL, admin_id TEXT NOT NULL, status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, claimed_at TEXT, sent_at TEXT, last_error TEXT,
      PRIMARY KEY (request_id, admin_id)
    );

    INSERT INTO admin_sessions VALUES (
      'absence-query-session', 'ADMIN1', '2099-01-01T00:00:00.000Z', '2026-07-15T00:00:00.000Z'
    );
    INSERT INTO stores VALUES ('STORE1', 'HCM', 'active', 'Asia/Ho_Chi_Minh', '₫');
    INSERT INTO stores VALUES ('STORE2', 'New York', 'active', 'America/New_York', '$');
    INSERT INTO users VALUES ('U1', 'Alice Telegram', 'alice');
    INSERT INTO users VALUES ('U2', 'Bob Telegram', 'bob');
    INSERT INTO users VALUES ('U3', 'Carol Telegram', 'carol');
    INSERT INTO store_members VALUES ('STORE1', 'U1', 'Alice');
    INSERT INTO store_members VALUES ('STORE1', 'U2', 'Bob');
    INSERT INTO store_members VALUES ('STORE2', 'U3', 'Carol');

    INSERT INTO absence_fine_requests VALUES
      ('APP-VND', 'STORE1', 'U1', '2026-07-10', 1500000, 1500000, 'approved',
       '2026-07-11T00:00:00.000Z', NULL, '2026-07-11T01:00:00.000Z', 'ADMIN1', NULL, NULL, 'IR-VND'),
      ('APP-USD', 'STORE2', 'U3', '2026-07-11', 15, 15, 'approved',
       '2026-07-12T00:00:00.000Z', NULL, '2026-07-12T01:00:00.000Z', 'ADMIN1', NULL, NULL, 'IR-USD'),
      ('REJ-VND', 'STORE1', 'U2', '2026-07-12', 1500000, 1500000, 'rejected',
       '2026-07-13T00:00:00.000Z', NULL, '2026-07-13T01:00:00.000Z', 'ADMIN1', 'Approved exception', NULL, NULL),
      ('CAN-VND', 'STORE1', 'U1', '2026-07-13', 1500000, 1500000, 'cancelled',
       '2026-07-14T00:00:00.000Z', NULL, NULL, NULL, NULL, 'Approved leave', NULL);
    INSERT INTO income_records VALUES
      ('IR-VND', 'STORE1', 'U1', 3000000, 'attendance_absence', 'APP-VND', '2026-07-11T01:00:00.000Z'),
      ('IR-USD', 'STORE2', 'U3', 20, 'attendance_absence', 'APP-USD', '2026-07-12T01:00:00.000Z');
  `);

  const insert = database.prepare(`
    INSERT INTO absence_fine_requests
      (request_id, store_id, telegram_id, business_date, original_fine, fine, status, created_at)
    VALUES (?, 'STORE1', ?, ?, 1500000, 1500000, 'pending', ?)
  `);
  for (let index = 1; index <= 101; index += 1) {
    const requestId = `P-${String(index).padStart(3, '0')}`;
    const employeeId = index % 2 ? 'U1' : 'U2';
    const businessDate = index % 2 ? '2026-07-14' : '2026-07-15';
    insert.run(requestId, employeeId, businessDate, `2026-07-15T${String(index % 24).padStart(2, '0')}:00:00.000Z`);
  }
  database.exec(`
    INSERT INTO absence_fine_notifications VALUES
      ('P-001', 'ADMIN1', 'sent', 1, NULL, '2026-07-15T03:10:00.000Z', NULL),
      ('P-003', 'ADMIN1', 'pending', 2, NULL, NULL, 'temporary failure'),
      ('P-003', 'ADMIN2', 'failed', 3, NULL, NULL, 'permanent failure'),
      ('P-004', 'ADMIN1', 'sent', 1, NULL, '2026-07-15T03:10:00.000Z', NULL),
      ('P-004', 'ADMIN2', 'pending', 2, NULL, NULL, 'temporary failure');
  `);
  return database;
}

async function getAdminAbsence(env, query = '') {
  const response = await worker.fetch(new Request(
    `https://example.com/api/admin/stores/STORE1/absence${query}`,
    { headers: { cookie: 'staffbot_admin_session=absence-query-session' } }
  ), env, { waitUntil() {} });
  return { response, result: await response.json() };
}

function d1TestDatabase(database, afterFirst, hooks = {}) {
  function prepare(sql) {
    let params = [];
    return {
      _sql: sql,
      bind(...values) {
        params = values;
        return this;
      },
      async first() {
        if (hooks.beforeFirst) await hooks.beforeFirst(sql, params);
        const row = database.prepare(sql).get(...params) || null;
        if (afterFirst) await afterFirst(sql, row);
        return row;
      },
      async all() {
        return { results: database.prepare(sql).all(...params) };
      },
      async run() {
        if (hooks.beforeRun) await hooks.beforeRun(sql, params);
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
        const results = [];
        for (const statement of statements) {
          if (hooks.beforeBatchStatement) await hooks.beforeBatchStatement(statement._sql);
          results.push(statement._run());
        }
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    }
  };
}

function memberAbsenceTestDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE admin_sessions (
      token TEXT PRIMARY KEY, telegram_id TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE users (
      telegram_id TEXT PRIMARY KEY, name TEXT, username TEXT, role TEXT, status TEXT,
      cycle_start TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE store_members (
      store_id TEXT NOT NULL, telegram_id TEXT NOT NULL, display_name TEXT, role TEXT, status TEXT,
      commission_rate REAL, cycle_start TEXT, joined_at TEXT, updated_at TEXT,
      absence_check_enabled INTEGER NOT NULL DEFAULT 1, absence_check_enabled_at TEXT,
      PRIMARY KEY (store_id, telegram_id)
    );
    CREATE TABLE absence_fine_requests (
      request_id TEXT PRIMARY KEY, store_id TEXT NOT NULL, telegram_id TEXT NOT NULL,
      status TEXT NOT NULL, cancellation_reason TEXT, decided_at TEXT, admin_id TEXT
    );
    CREATE TABLE absence_fine_notifications (
      request_id TEXT NOT NULL, admin_id TEXT NOT NULL, status TEXT NOT NULL,
      last_error TEXT, PRIMARY KEY (request_id, admin_id)
    );
    CREATE TABLE income_records (
      record_id TEXT PRIMARY KEY, request_id TEXT, amount REAL
    );
    CREATE TABLE admin_audit_logs (
      store_id TEXT, admin_id TEXT, action TEXT, target_id TEXT,
      details_json TEXT, created_at TEXT
    );
    CREATE TABLE bot_logs (
      store_id TEXT, level TEXT, event TEXT, telegram_id TEXT,
      message_text TEXT, payload_json TEXT, created_at TEXT
    );

    INSERT INTO admin_sessions VALUES ('session-1', 'ADMIN', '2099-01-01T00:00:00.000Z', '2026-07-15T00:00:00.000Z');
    INSERT INTO users VALUES ('U1', 'Alice', 'alice', 'employee', 'active', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
    INSERT INTO store_members VALUES ('S1', 'U1', 'Alice', 'employee', 'active', 0.6, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 1, '2026-07-01T00:00:00.000Z');
    INSERT INTO store_members VALUES ('S2', 'U1', 'Alice', 'employee', 'active', 0.6, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 1, '2026-07-01T00:00:00.000Z');

    INSERT INTO absence_fine_requests VALUES ('PENDING-S1-U1', 'S1', 'U1', 'pending', NULL, NULL, NULL);
    INSERT INTO absence_fine_requests VALUES ('APPROVED-S1-U1', 'S1', 'U1', 'approved', NULL, '2026-07-14T00:00:00.000Z', 'ADMIN');
    INSERT INTO absence_fine_requests VALUES ('PENDING-S2-U1', 'S2', 'U1', 'pending', NULL, NULL, NULL);
    INSERT INTO absence_fine_requests VALUES ('PENDING-S1-U2', 'S1', 'U2', 'pending', NULL, NULL, NULL);
    INSERT INTO absence_fine_notifications VALUES ('PENDING-S1-U1', 'A1', 'pending', NULL);
    INSERT INTO absence_fine_notifications VALUES ('PENDING-S1-U1', 'A2', 'sending', NULL);
    INSERT INTO absence_fine_notifications VALUES ('APPROVED-S1-U1', 'A1', 'pending', NULL);
    INSERT INTO absence_fine_notifications VALUES ('PENDING-S2-U1', 'A1', 'pending', NULL);
    INSERT INTO income_records VALUES ('INCOME-1', 'APPROVED-S1-U1', 1234);
  `);
  return database;
}

function attendanceStatsTestDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE stores (store_id TEXT PRIMARY KEY, name TEXT, timezone TEXT, currency TEXT);
    CREATE TABLE users (telegram_id TEXT PRIMARY KEY, name TEXT, username TEXT);
    CREATE TABLE store_members (
      store_id TEXT, telegram_id TEXT, display_name TEXT, status TEXT, joined_at TEXT,
      absence_check_enabled INTEGER NOT NULL DEFAULT 1, absence_check_enabled_at TEXT
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
    INSERT INTO store_members VALUES ('TOKYO', 'U1', 'Alice', 'active', '2026-07-09T16:00:00.000Z', 1, '2026-07-09T16:00:00.000Z');
    INSERT INTO store_members VALUES ('TOKYO', 'U2', '', 'active', '2026-07-14T02:00:00.000Z', 1, '2026-07-14T02:00:00.000Z');
    INSERT INTO store_members VALUES ('TOKYO', 'U3', 'Disabled', 'disabled', '2026-07-01T00:00:00.000Z', 1, '2026-07-01T00:00:00.000Z');
    INSERT INTO store_members VALUES ('TOKYO', 'U4', 'Exempt', 'active', '2026-07-09T00:00:00.000Z', 0, NULL);
    INSERT INTO store_members VALUES ('TOKYO', 'U5', 'Re-enabled', 'active', '2026-07-09T00:00:00.000Z', 1, '2026-07-12T15:00:00.000Z');

    INSERT INTO attendance_records VALUES ('IN-10', 'TOKYO', 'U1', '2026-07-10', 'checkin', 1);
    INSERT INTO attendance_records VALUES ('IN-11', 'TOKYO', 'U1', '2026-07-11', 'checkin', 0);
    INSERT INTO attendance_records VALUES ('OUT-11', 'TOKYO', 'U1', '2026-07-11', 'checkout', 0);
    INSERT INTO attendance_records VALUES ('IN-12A', 'TOKYO', 'U1', '2026-07-12', 'checkin', 0);
    INSERT INTO attendance_records VALUES ('IN-12B', 'TOKYO', 'U1', '2026-07-12', 'checkin', 0);
    INSERT INTO attendance_records VALUES ('IN-15', 'TOKYO', 'U1', '2026-07-15', 'checkin', 1);
    INSERT INTO attendance_records VALUES ('IN-U4-10', 'TOKYO', 'U4', '2026-07-10', 'checkin', 1);
    INSERT INTO attendance_records VALUES ('IN-U5-10', 'TOKYO', 'U5', '2026-07-10', 'checkin', 1);
    INSERT INTO attendance_records VALUES ('IN-U5-13', 'TOKYO', 'U5', '2026-07-13', 'checkin', 0);
    INSERT INTO leave_requests VALUES ('LEAVE-12', 'TOKYO', 'U1', '2026-07-12', 'approved');
    INSERT INTO leave_requests VALUES ('LEAVE-13A', 'TOKYO', 'U1', '2026-07-13', 'approved');
    INSERT INTO leave_requests VALUES ('LEAVE-13B', 'TOKYO', 'U1', '2026-07-13', 'approved');
    INSERT INTO leave_requests VALUES ('LEAVE-14', 'TOKYO', 'U1', '2026-07-14', 'rejected');
    INSERT INTO leave_requests VALUES ('LEAVE-U4-11', 'TOKYO', 'U4', '2026-07-11', 'approved');
    INSERT INTO leave_requests VALUES ('LEAVE-U5-11', 'TOKYO', 'U5', '2026-07-11', 'approved');
    INSERT INTO absence_fine_requests VALUES ('ABS-14', 'TOKYO', 'U1', '2026-07-14');
    INSERT INTO income_records VALUES ('F-LATE', 'TOKYO', 'U1', 500000, 'attendance_late', 'IN-10');
    INSERT INTO income_records VALUES ('F-EARLY', 'TOKYO', 'U1', 700000, 'attendance_early', 'OUT-11');
    INSERT INTO income_records VALUES ('F-ABS', 'TOKYO', 'U1', 1500000, 'attendance_absence', 'ABS-14');
    INSERT INTO income_records VALUES ('F-MANUAL', 'TOKYO', 'U1', 9000000, 'manual', NULL);
    INSERT INTO income_records VALUES ('F-FUTURE', 'TOKYO', 'U1', 100000, 'attendance_late', 'IN-15');
    INSERT INTO income_records VALUES ('F-U4-LATE', 'TOKYO', 'U4', 400000, 'attendance_late', 'IN-U4-10');
    INSERT INTO income_records VALUES ('F-U5-LATE', 'TOKYO', 'U5', 300000, 'attendance_late', 'IN-U5-10');
  `);
  return database;
}

function notificationTestDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE absence_fine_requests (
      request_id TEXT PRIMARY KEY, store_id TEXT NOT NULL,
      telegram_id TEXT NOT NULL, status TEXT NOT NULL
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
      store_id TEXT, telegram_id TEXT, status TEXT, role TEXT,
      absence_check_enabled INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO absence_fine_requests VALUES ('ABS-1', 'STORE1', 'U1', 'pending');
    INSERT INTO store_members VALUES ('STORE1', 'A1', 'active', 'admin', 1);
    INSERT INTO store_members VALUES ('STORE1', 'A2', 'active', 'admin', 1);
    INSERT INTO store_members VALUES ('STORE1', 'U1', 'active', 'employee', 1);
  `);
  return database;
}

function absenceCronTestDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE stores (
      store_id TEXT PRIMARY KEY, name TEXT, status TEXT, timezone TEXT, currency TEXT,
      absence_fine REAL, absence_fine_enabled_at TEXT, absence_last_checked_date TEXT,
      updated_at TEXT
    );
    CREATE TABLE users (telegram_id TEXT PRIMARY KEY, name TEXT, username TEXT);
    CREATE TABLE store_members (
      store_id TEXT, telegram_id TEXT, display_name TEXT, role TEXT, status TEXT,
      joined_at TEXT, absence_check_enabled INTEGER NOT NULL DEFAULT 1,
      absence_check_enabled_at TEXT,
      PRIMARY KEY (store_id, telegram_id)
    );
    CREATE TABLE attendance_records (
      record_id TEXT PRIMARY KEY, store_id TEXT, telegram_id TEXT,
      business_date TEXT, type TEXT
    );
    CREATE TABLE leave_requests (
      request_id TEXT PRIMARY KEY, store_id TEXT, telegram_id TEXT,
      leave_date TEXT, status TEXT
    );
    CREATE TABLE absence_fine_requests (
      request_id TEXT PRIMARY KEY, store_id TEXT, telegram_id TEXT,
      business_date TEXT, original_fine REAL, fine REAL, status TEXT, created_at TEXT
    );
    CREATE UNIQUE INDEX one_absence_request
      ON absence_fine_requests (store_id, telegram_id, business_date);
    CREATE TABLE absence_fine_notifications (
      request_id TEXT, admin_id TEXT, status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, claimed_at TEXT, sent_at TEXT, last_error TEXT,
      PRIMARY KEY (request_id, admin_id)
    );
    CREATE TABLE bot_logs (
      store_id TEXT, level TEXT, event TEXT, telegram_id TEXT,
      message_text TEXT, payload_json TEXT, created_at TEXT
    );
    INSERT INTO stores VALUES (
      'STORE1', 'Store', 'active', 'Asia/Tokyo', '$', 1.5,
      '2026-07-01T00:00:00.000Z', '2026-07-13', NULL
    );
    INSERT INTO store_members VALUES (
      'STORE1', 'U1', 'Alice', 'employee', 'active',
      '2026-07-01T00:00:00.000Z', 1, '2026-07-01T00:00:00.000Z'
    );
    INSERT INTO store_members VALUES (
      'STORE1', 'A1', 'Admin', 'admin', 'active',
      '2026-07-01T00:00:00.000Z', 1, '2026-07-01T00:00:00.000Z'
    );
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

test('admin page exposes standalone absence approvals in all four languages', () => {
  assert.match(source, /data-tab="absence"/);
  assert.match(source, /id="tab-absence"/);
  assert.match(source, /renderAbsence/);
  assert.match(source, /absence_pending_page/);
  assert.match(source, /absence_history_page/);
  assert.match(source, /data-absence-status/);
  assert.match(source, /const queryKey = tab === 'absence' \? key\.replace\('absence_', ''\) : key/);

  const visibleAbsenceKeys = new Set([
    ...ABSENCE_PENDING_COLUMNS,
    ...ABSENCE_HISTORY_COLUMNS,
    'absence_approvals', 'pending_absence', 'absence_history',
    'pending_absence_total', 'approved_absence_total', 'rejected_absence_total',
    'cancelled_absence_total', 'approved_absence_fine_total',
    'notification_sent', 'notification_not_queued', 'notification_retrying',
    'notification_recipients', 'notification_attempts', 'notification_sent_total',
    'btn_approve_absence_fine', 'btn_reject', 'confirm_approve_absence_fine',
    'reject_reason', 'rejection_reason_required', 'absence_already_processed',
    'absence_action_failed', 'filter', 'date_from', 'date_to', 'employee',
    'all_employees', 'stores_filter', 'search', 'status', 'all_statuses',
    'status_pending', 'status_approved', 'status_rejected', 'status_cancelled',
    'prev_page', 'next_page', 'page_status'
  ]);
  visibleAbsenceKeys.delete('action');
  for (const key of visibleAbsenceKeys) {
    assert.equal(
      (source.match(new RegExp(`\\b${key}:'[^']+'`, 'g')) || []).length,
      4,
      `${key} should be translated in all four admin languages`
    );
    for (const match of source.matchAll(new RegExp(`\\b${key}:'([^']+)'`, 'g'))) {
      assert.notEqual(match[1], key, `${key} must render a label instead of its translation key`);
    }
  }
});

test('absence page renders full-range summary, localized notifications, and independent tables', () => {
  assert.match(source, /function absenceSummaryPanel\(data\)/);
  assert.match(source, /data\.summary\.fine_totals/);
  assert.match(source, /formatCurrencyAmount\(item\.currency, item\.amount\)/);
  assert.match(source, /table\(pending, \$\{JSON\.stringify\(ABSENCE_PENDING_COLUMNS\)\}/);
  assert.match(source, /table\(history, \$\{JSON\.stringify\(ABSENCE_HISTORY_COLUMNS\)\}/);
  assert.match(source, /pager\('absence', 'absence_pending_page'/);
  assert.match(source, /pager\('absence', 'absence_history_page'/);
  assert.match(source, /notificationStatusLabel/);
  assert.match(source, /notificationDeliveryLabel/);
  assert.match(source, /L\('notification_sent_total'\)[\s\S]*replace\('\{sent\}', String\(row\.notification_sent_total \|\| 0\)\)[\s\S]*replace\('\{total\}', String\(row\.notification_total \|\| 0\)\)/);
});

test('absence action buttons preserve row stores and guard approval and rejection requests', () => {
  assert.match(source, /data-absence-action="approve"[^>]+data-store="' \+ esc\(row\.store_id\)/);
  assert.match(source, /data-absence-action="reject"[^>]+data-store="' \+ esc\(row\.store_id\)/);

  const start = source.indexOf('function bindAbsenceActions()');
  const end = source.indexOf('\n    async function renderLeave', start + 1);
  const handler = source.slice(start, end);
  assert.ok(start >= 0, 'absence action handler should exist');
  assert.match(handler, /if \(!confirm\(L\('confirm_approve_absence_fine'\)\)\) return;[\s\S]*'\/absence\/' \+ encodeURIComponent\(btn\.dataset\.id\) \+ '\/' \+ btn\.dataset\.absenceAction/);
  assert.match(handler, /const reasonInput = prompt\(L\('reject_reason'\)\);[\s\S]*if \(reasonInput === null\) return;/);
  assert.match(handler, /const reason = reasonInput\.trim\(\);[\s\S]*if \(!reason\) \{[\s\S]*alert\(L\('rejection_reason_required'\)\);[\s\S]*return;/);
  assert.match(handler, /body = \{ reason \};[\s\S]*body: JSON\.stringify\(body\)/);
  assert.match(handler, /await renderAbsence\(\)/);
  assert.doesNotMatch(handler, /await loadTab\(\)/);
});

function executableAbsenceAction(options = {}) {
  const start = source.indexOf('function bindAbsenceActions()');
  const end = source.indexOf('\n    async function renderLeave', start + 1);
  const handler = source.slice(start, end);
  const button = {
    dataset: { absenceAction: 'approve', store: 'STORE1', id: 'ABS-1' },
    disabled: false,
    setAttribute() {},
    removeAttribute() {}
  };
  const alerts = [];
  let renders = 0;
  const bind = new Function(
    'document', 'withBusy', 'confirm', 'prompt', 'alert', 'L', 'api', 'renderAbsence',
    `${handler}; return bindAbsenceActions;`
  )(
    { querySelectorAll: () => [button] },
    async (_button, task) => task(),
    () => true,
    () => null,
    (message) => alerts.push(message),
    (key) => key,
    options.api || (async () => ({})),
    async () => { renders += 1; }
  );
  bind();
  return { button, alerts, renders: () => renders };
}

test('absence action catches already-decided API failures without reloading', async () => {
  const action = executableAbsenceAction({ api: async () => { throw new Error('already_decided'); } });
  await action.button.onclick();
  assert.deepEqual(action.alerts, ['absence_already_processed']);
  assert.equal(action.renders(), 0);
});

test('absence action catches generic API failures without reloading', async () => {
  const action = executableAbsenceAction({ api: async () => { throw new Error('request_failed'); } });
  await action.button.onclick();
  assert.deepEqual(action.alerts, ['absence_action_failed']);
  assert.equal(action.renders(), 0);
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
    },
    {
      store_id: 'TOKYO', store_name: 'Tokyo Club', currency: '¥', telegram_id: 'U4', display_name: 'Exempt',
      work_days: 1, late_days: 1, absence_days: 0, leave_days: 1, fine_total: 400000
    },
    {
      store_id: 'TOKYO', store_name: 'Tokyo Club', currency: '¥', telegram_id: 'U5', display_name: 'Re-enabled',
      work_days: 2, late_days: 1, absence_days: 1, leave_days: 1, fine_total: 300000
    }
  ]);
});

test('keeps other statistics for an exempt employee but reports zero absence days', async () => {
  const rows = await attendanceEmployeeStats({ DB: d1TestDatabase(attendanceStatsTestDatabase()) }, {
    storeIds: ['TOKYO'], employeeId: 'U4', monthDateStart: '2026-07-09', monthDateEnd: '2026-07-21'
  }, new Date('2026-07-15T03:00:00.000Z'));

  assert.deepEqual(rows[0], {
    store_id: 'TOKYO', store_name: 'Tokyo Club', currency: '¥', telegram_id: 'U4', display_name: 'Exempt',
    work_days: 1, late_days: 1, absence_days: 0, leave_days: 1, fine_total: 400000
  });
});

test('starts absence statistics for a re-enabled employee on the store-local enable date', async () => {
  const rows = await attendanceEmployeeStats({ DB: d1TestDatabase(attendanceStatsTestDatabase()) }, {
    storeIds: ['TOKYO'], employeeId: 'U5', monthDateStart: '2026-07-09', monthDateEnd: '2026-07-21'
  }, new Date('2026-07-15T03:00:00.000Z'));

  assert.deepEqual(rows[0], {
    store_id: 'TOKYO', store_name: 'Tokyo Club', currency: '¥', telegram_id: 'U5', display_name: 'Re-enabled',
    work_days: 2, late_days: 1, absence_days: 1, leave_days: 1, fine_total: 300000
  });
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
  assert.equal(adminOrderSql(new URL('https://x.test/?records_sort=amount&records_dir=asc'), 'records_page', allowed, 'ORDER BY approved_at DESC', 'request_id DESC'), 'ORDER BY amount ASC, request_id DESC');
});

test('maps every visible sortable absence column to server ordering', () => {
  const allowed = absenceAdminSortColumns();
  const groups = {
    pending: ABSENCE_PENDING_COLUMNS,
    history: ABSENCE_HISTORY_COLUMNS
  };
  for (const [group, columns] of Object.entries(groups)) {
    for (const column of columns.filter((item) => item !== 'action')) {
      const url = new URL(`https://x.test/?${group}_sort=${column}&${group}_dir=asc`);
      assert.notEqual(
        adminOrderSql(url, `${group}_page`, allowed, 'ORDER BY default_sort'),
        'ORDER BY default_sort',
        `${group}.${column} must not render as a no-op sort`
      );
    }
  }
});

test('absence pagination uses request id as the stable default and custom-sort tiebreaker', () => {
  assert.match(source, /ORDER BY r\.business_date DESC, r\.created_at DESC, r\.request_id DESC/);
  assert.match(source, /ORDER BY COALESCE\(r\.decided_at, r\.created_at\) DESC, r\.request_id DESC/);
  assert.match(source, /baseParams, `ORDER BY r\.business_date DESC, r\.created_at DESC, r\.request_id DESC`, absenceSort, `r\.request_id DESC`/);
  assert.match(source, /baseParams, `ORDER BY COALESCE\(r\.decided_at, r\.created_at\) DESC, r\.request_id DESC`, absenceSort, `r\.request_id DESC`/);
});

test('resets only the sorted absence pager while preserving existing tab behavior', () => {
  assert.match(source, /resetAdminSortPages\(pages, currentTab, group\)/);
  const pages = {
    absence: { absence_pending_page: 7, absence_history_page: 5 },
    income: { pending_page: 4, records_page: 3, rejected_page: 2 }
  };

  resetAdminSortPages(pages, 'absence', 'pending');
  assert.deepEqual(pages.absence, { absence_pending_page: 1, absence_history_page: 5 });

  pages.absence.absence_pending_page = 7;
  resetAdminSortPages(pages, 'absence', 'history');
  assert.deepEqual(pages.absence, { absence_pending_page: 7, absence_history_page: 1 });

  resetAdminSortPages(pages, 'income', 'records');
  assert.deepEqual(pages.income, { pending_page: 1, records_page: 1, rejected_page: 1 });
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

test('member form exposes daily absence checking', () => {
  assert.match(source, /memberAbsenceCheck/);
  assert.equal((source.match(/absence_check_enabled:'[^']+'/g) || []).length, 4);
  assert.equal((source.match(/m\.commission_rate,\s*m\.absence_check_enabled,/g) || []).length, 2);
  assert.match(source, /\['store_id','telegram_id','display_name','username','role','status','commission_rate','absence_check_enabled','cycle_start','joined_at','action'\]/);
  assert.match(source, /absence_check_enabled:\s*member\.absence_check_enabled === 0 \? L\('disable'\) : L\('enable'\)/);
  assert.match(source, /absence_check_enabled:\s*\$\('memberAbsenceCheck'\)\.value === 'true'/);
  assert.match(source, /absence_check_enabled:\s*member\.absence_check_enabled !== 0/);
  assert.doesNotMatch(source, /absence_check_enabled:\s*member\.absence_check_enabled\s*[,}]/);
  assert.match(source, /\$\('memberAbsenceCheck'\)\.value\s*=\s*member\.absence_check_enabled === 0 \? 'false' : 'true'/);
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

test('normalizes employee absence check updates without resetting an enabled timestamp', () => {
  const now = new Date('2026-07-15T03:30:00.000Z');
  const enabled = {
    absence_check_enabled: 1,
    absence_check_enabled_at: '2026-07-01T00:00:00.000Z'
  };

  assert.deepEqual(normalizeEmployeeAbsenceCheck({}, enabled, now), enabled);
  assert.deepEqual(normalizeEmployeeAbsenceCheck({}, {
    absence_check_enabled: 0,
    absence_check_enabled_at: null
  }, now), {
    absence_check_enabled: 0,
    absence_check_enabled_at: null
  });
  assert.deepEqual(normalizeEmployeeAbsenceCheck({ absence_check_enabled: false }, enabled, now), {
    absence_check_enabled: 0,
    absence_check_enabled_at: null
  });
  assert.deepEqual(normalizeEmployeeAbsenceCheck(
    { absence_check_enabled: true },
    { absence_check_enabled: 0, absence_check_enabled_at: null },
    now
  ), {
    absence_check_enabled: 1,
    absence_check_enabled_at: now.toISOString()
  });
});

test('rejects invalid explicit absence check values without changing member work', async () => {
  const database = memberAbsenceTestDatabase();
  const env = {
    ENVIRONMENT: 'production',
    BOT_TOKEN: 'test-token', WEBHOOK_SECRET: 'test-secret', ADMIN_IDS: 'ADMIN',
    DB: d1TestDatabase(database)
  };
  const response = await worker.fetch(new Request('https://example.com/api/admin/stores/S1/members', {
    method: 'POST',
    headers: {
      cookie: 'staffbot_admin_session=session-1',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      telegram_id: 'U1', name: 'Alice', role: 'employee', status: 'active',
      commission_rate: 0.6, absence_check_enabled: 'false'
    })
  }), env, { waitUntil() {} });

  assert.equal(response.status, 400);
  assert.equal(database.prepare(`
    SELECT absence_check_enabled FROM store_members
    WHERE store_id = 'S1' AND telegram_id = 'U1'
  `).get().absence_check_enabled, 1);
  assert.equal(database.prepare(`
    SELECT status FROM absence_fine_requests WHERE request_id = 'PENDING-S1-U1'
  `).get().status, 'pending');
  assert.equal(database.prepare(`SELECT COUNT(*) AS total FROM admin_audit_logs`).get().total, 0);
});

test('disabling absence checks cancels only matching pending work', async () => {
  const database = memberAbsenceTestDatabase();
  const env = {
    ENVIRONMENT: 'production',
    BOT_TOKEN: 'test-token',
    WEBHOOK_SECRET: 'test-secret',
    ADMIN_IDS: 'ADMIN',
    DB: d1TestDatabase(database)
  };
  const response = await worker.fetch(new Request('https://example.com/api/admin/stores/S1/members', {
    method: 'POST',
    headers: {
      cookie: 'staffbot_admin_session=session-1',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      telegram_id: 'U1', name: 'Alice', username: 'alice', role: 'employee',
      status: 'active', commission_rate: 0.6, absence_check_enabled: false
    })
  }), env, { waitUntil() {} });

  assert.equal(response.status, 200);
  assert.deepEqual(database.prepare(`
    SELECT store_id, absence_check_enabled, absence_check_enabled_at
    FROM store_members WHERE telegram_id = 'U1' ORDER BY store_id
  `).all().map((row) => ({ ...row })), [
    { store_id: 'S1', absence_check_enabled: 0, absence_check_enabled_at: null },
    { store_id: 'S2', absence_check_enabled: 1, absence_check_enabled_at: '2026-07-01T00:00:00.000Z' }
  ]);
  assert.deepEqual(database.prepare(`
    SELECT request_id, status, cancellation_reason
    FROM absence_fine_requests ORDER BY request_id
  `).all().map((row) => ({ ...row })), [
    { request_id: 'APPROVED-S1-U1', status: 'approved', cancellation_reason: null },
    { request_id: 'PENDING-S1-U1', status: 'cancelled', cancellation_reason: 'absence_check_disabled' },
    { request_id: 'PENDING-S1-U2', status: 'pending', cancellation_reason: null },
    { request_id: 'PENDING-S2-U1', status: 'pending', cancellation_reason: null }
  ]);
  assert.deepEqual(database.prepare(`
    SELECT request_id, admin_id, status, last_error
    FROM absence_fine_notifications ORDER BY request_id, admin_id
  `).all().map((row) => ({ ...row })), [
    { request_id: 'APPROVED-S1-U1', admin_id: 'A1', status: 'pending', last_error: null },
    { request_id: 'PENDING-S1-U1', admin_id: 'A1', status: 'cancelled', last_error: 'absence_check_disabled' },
    { request_id: 'PENDING-S1-U1', admin_id: 'A2', status: 'cancelled', last_error: 'absence_check_disabled' },
    { request_id: 'PENDING-S2-U1', admin_id: 'A1', status: 'pending', last_error: null }
  ]);
  assert.deepEqual({ ...database.prepare(`SELECT * FROM income_records`).get() }, {
    record_id: 'INCOME-1', request_id: 'APPROVED-S1-U1', amount: 1234
  });
  const auditRow = database.prepare(`
    SELECT action, target_id, details_json FROM admin_audit_logs ORDER BY rowid DESC LIMIT 1
  `).get();
  assert.equal(auditRow.action, 'update_member');
  assert.equal(auditRow.target_id, 'U1');
  assert.deepEqual(JSON.parse(auditRow.details_json).absence_check, { before: 1, after: 0 });
});

test('rolls back the employee switch and cancellations when its audit insert fails', async () => {
  const database = memberAbsenceTestDatabase();
  const env = {
    ENVIRONMENT: 'production',
    BOT_TOKEN: 'test-token', WEBHOOK_SECRET: 'test-secret', ADMIN_IDS: 'ADMIN',
    DB: d1TestDatabase(database, null, {
      beforeBatchStatement(sql) {
        if (/INSERT INTO admin_audit_logs/.test(sql)) throw new Error('audit failed');
      }
    })
  };
  await assert.rejects(worker.fetch(new Request('https://example.com/api/admin/stores/S1/members', {
    method: 'POST',
    headers: {
      cookie: 'staffbot_admin_session=session-1',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      telegram_id: 'U1', name: 'Alice', role: 'employee', status: 'active',
      commission_rate: 0.6, absence_check_enabled: false
    })
  }), env, { waitUntil() {} }), /audit failed/);
  assert.equal(database.prepare(`
    SELECT absence_check_enabled FROM store_members
    WHERE store_id = 'S1' AND telegram_id = 'U1'
  `).get().absence_check_enabled, 1);
  assert.equal(database.prepare(`
    SELECT status FROM absence_fine_requests WHERE request_id = 'PENDING-S1-U1'
  `).get().status, 'pending');
  assert.deepEqual({ ...database.prepare(`
    SELECT status, last_error FROM absence_fine_notifications
    WHERE request_id = 'PENDING-S1-U1' AND admin_id = 'A1'
  `).get() }, { status: 'pending', last_error: null });
  assert.equal(database.prepare(`SELECT COUNT(*) AS total FROM admin_audit_logs`).get().total, 0);
});

test('new member defaults to enabled employee absence check when switch is omitted', async () => {
  const database = memberAbsenceTestDatabase();
  const env = {
    ENVIRONMENT: 'production',
    BOT_TOKEN: 'test-token',
    WEBHOOK_SECRET: 'test-secret',
    ADMIN_IDS: 'ADMIN',
    DB: d1TestDatabase(database)
  };
  const response = await worker.fetch(new Request('https://example.com/api/admin/stores/S1/members', {
    method: 'POST',
    headers: {
      cookie: 'staffbot_admin_session=session-1',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      telegram_id: 'U3', name: 'New Member', username: 'new-member',
      role: 'employee', status: 'active', commission_rate: 0.6
    })
  }), env, { waitUntil() {} });

  assert.equal(response.status, 200);
  const member = database.prepare(`
    SELECT absence_check_enabled, absence_check_enabled_at
    FROM store_members WHERE store_id = 'S1' AND telegram_id = 'U3'
  `).get();
  assert.equal(member.absence_check_enabled, 1);
  assert.ok(member.absence_check_enabled_at);
  assert.equal(new Date(member.absence_check_enabled_at).toISOString(), member.absence_check_enabled_at);
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

test('store-scoped absence decisions reject mismatches and preserve rejection reasons', async () => {
  const database = absenceTestDatabase();
  database.exec(`
    INSERT INTO absence_fine_requests
      (request_id, store_id, telegram_id, business_date, original_fine, fine, status, created_at)
    VALUES
      ('ABS-2', 'STORE1', 'U2', '2026-07-14', 20, 20, 'pending', '2026-07-15T03:00:00.000Z'),
      ('ABS-3', 'STORE1', 'U3', '2026-07-14', 30, 30, 'pending', '2026-07-15T03:00:00.000Z');
  `);
  const env = { DB: d1TestDatabase(database) };

  const approved = await approveAbsenceFineRequest(env, 'ABS-1', 'ADMIN1', 'STORE1');
  assert.equal(approved.ok, true);
  assert.equal(database.prepare(
    `SELECT COUNT(*) AS total FROM income_records WHERE source = 'attendance_absence'`
  ).get().total, 1);

  const wrongStore = await approveAbsenceFineRequest(env, 'ABS-2', 'ADMIN1', 'STORE2');
  assert.equal(wrongStore.ok, false);

  const rejected = await rejectAbsenceFineRequest(
    env, 'ABS-3', 'ADMIN1', 'Employee had approved exception', 'STORE1'
  );
  assert.equal(rejected.ok, true);
  assert.equal(database.prepare(
    `SELECT reject_reason FROM absence_fine_requests WHERE request_id = 'ABS-3'`
  ).get().reject_reason, 'Employee had approved exception');
});

test('admin absence action routes return 200, 404, and 409 for decision outcomes', async () => {
  const database = absenceTestDatabase();
  const env = absenceAdminApiEnv(database);
  const ctx = { waitUntil() {} };

  const approved = await worker.fetch(adminAbsenceRequest(
    '/api/admin/stores/STORE1/absence/ABS-1/approve', {}
  ), env, ctx);
  assert.equal(approved.status, 200);

  const mismatch = await worker.fetch(adminAbsenceRequest(
    '/api/admin/stores/STORE2/absence/ABS-1/approve', {}
  ), env, ctx);
  assert.equal(mismatch.status, 404);

  const alreadyDecided = await worker.fetch(adminAbsenceRequest(
    '/api/admin/stores/STORE1/absence/ABS-1/approve', {}
  ), env, ctx);
  assert.equal(alreadyDecided.status, 409);

  const concurrentDatabase = absenceTestDatabase();
  let stoleDecision = false;
  const concurrentEnv = absenceAdminApiEnv(concurrentDatabase, {
    beforeBatchStatement(sql) {
      if (stoleDecision || !/INSERT INTO income_records/.test(sql)) return;
      stoleDecision = true;
      concurrentDatabase.prepare(`
        UPDATE absence_fine_requests SET status = 'rejected' WHERE request_id = 'ABS-1'
      `).run();
    }
  });
  const concurrent = await worker.fetch(adminAbsenceRequest(
    '/api/admin/stores/STORE1/absence/ABS-1/approve', {}
  ), concurrentEnv, ctx);
  assert.equal(concurrent.status, 409);
  assert.deepEqual(await concurrent.json(), { ok: false, error: 'already_decided' });
  assert.equal(concurrentDatabase.prepare(`SELECT COUNT(*) AS total FROM income_records`).get().total, 0);

  const rejectRaceDatabase = absenceTestDatabase();
  let stoleRejectDecision = false;
  const rejectRaceEnv = absenceAdminApiEnv(rejectRaceDatabase, {
    beforeRun(sql) {
      if (stoleRejectDecision || !/UPDATE absence_fine_requests[\s\S]*status = 'rejected'/.test(sql)) return;
      stoleRejectDecision = true;
      rejectRaceDatabase.prepare(`
        UPDATE absence_fine_requests SET status = 'approved' WHERE request_id = 'ABS-1'
      `).run();
    }
  });
  const rejectRace = await worker.fetch(adminAbsenceRequest(
    '/api/admin/stores/STORE1/absence/ABS-1/reject', { reason: 'Not excused' }
  ), rejectRaceEnv, ctx);
  assert.equal(rejectRace.status, 409);
  assert.deepEqual(await rejectRace.json(), { ok: false, error: 'already_decided' });
  assert.equal(rejectRaceDatabase.prepare(`SELECT status FROM absence_fine_requests`).get().status, 'approved');

  assert.match(source, /throw new Error\(data\.error \|\| 'request_failed'\)/);
  assert.match(source, /error\.message === 'already_decided' \? 'absence_already_processed'/);
});

test('requires absence rejection reason before changing a pending request', async () => {
  for (const body of [null, [], '"reason"', 123, {}, { reason: '   ' }, '{not valid json']) {
    const database = absenceTestDatabase();
    const env = absenceAdminApiEnv(database);
    const response = await worker.fetch(adminAbsenceRequest(
      '/api/admin/stores/STORE1/absence/ABS-1/reject', body
    ), env, { waitUntil() {} });

    assert.equal(response.status, 400);
    assert.equal(database.prepare(`SELECT status FROM absence_fine_requests`).get().status, 'pending');
  }

  const database = absenceTestDatabase();
  const env = absenceAdminApiEnv(database);
  const response = await worker.fetch(adminAbsenceRequest(
    '/api/admin/stores/STORE1/absence/ABS-1/reject',
    { reason: '  Employee had approved exception  ' }
  ), env, { waitUntil() {} });

  assert.equal(response.status, 200);
  assert.deepEqual({ ...database.prepare(`
    SELECT status, reject_reason FROM absence_fine_requests WHERE request_id = 'ABS-1'
  `).get() }, {
    status: 'rejected',
    reject_reason: 'Employee had approved exception'
  });
});

test('admin absence query separates pending and history while preserving summary across pagination', async () => {
  const database = absenceAdminQueryDatabase();
  const env = {
    ENVIRONMENT: 'production',
    BOT_TOKEN: 'test-token', WEBHOOK_SECRET: 'test-secret', ADMIN_IDS: 'ADMIN1',
    DB: d1TestDatabase(database)
  };
  const query = '?stores=STORE1%2CSTORE2&date_from=2026-07-01&date_to=2026-07-31';
  const first = await getAdminAbsence(env, query);
  const second = await getAdminAbsence(env, `${query}&pending_page=2`);

  assert.equal(first.response.status, 200);
  assert.equal(first.result.pending.length, 100);
  assert.deepEqual(first.result.history.map((row) => row.status).sort(), [
    'approved', 'approved', 'cancelled', 'rejected'
  ]);
  assert.equal(second.result.pending.length, 1);
  assert.deepEqual(second.result.summary, first.result.summary);
  assert.deepEqual(first.result.summary.status_counts, {
    pending: 101, approved: 2, rejected: 1, cancelled: 1
  });

  const filtered = await getAdminAbsence(
    env,
    '?stores=STORE1%2CSTORE2&employee=U1&date_from=2026-07-10&date_to=2026-07-10&status=approved'
  );
  assert.equal(filtered.result.pending.length, 0);
  assert.deepEqual(filtered.result.history.map((row) => row.request_id), ['APP-VND']);
  assert.deepEqual(filtered.result.summary.status_counts, { approved: 1 });
});

test('admin absence runtime applies delivery and history-only sort expressions', async () => {
  const database = absenceAdminQueryDatabase();
  const env = {
    ENVIRONMENT: 'production',
    BOT_TOKEN: 'test-token', WEBHOOK_SECRET: 'test-secret', ADMIN_IDS: 'ADMIN1',
    DB: d1TestDatabase(database)
  };

  const delivery = await getAdminAbsence(env, '?pending_sort=notification_delivery&pending_dir=desc');
  assert.deepEqual(delivery.result.pending.slice(0, 2).map((row) => row.request_id), ['P-001', 'P-003']);

  const reason = await getAdminAbsence(env, '?history_sort=decision_reason&history_dir=asc');
  assert.deepEqual(reason.result.history.slice(-2).map((row) => row.request_id), ['REJ-VND', 'CAN-VND']);

  const incomeRecord = await getAdminAbsence(
    env,
    '?stores=STORE1%2CSTORE2&history_sort=income_record_id&history_dir=desc'
  );
  assert.deepEqual(incomeRecord.result.history.slice(0, 2).map((row) => row.request_id), ['APP-VND', 'APP-USD']);
});

test('absence notification summary distinguishes sent, not_queued, and retrying', async () => {
  const database = absenceAdminQueryDatabase();
  const env = {
    ENVIRONMENT: 'production',
    BOT_TOKEN: 'test-token', WEBHOOK_SECRET: 'test-secret', ADMIN_IDS: 'ADMIN1',
    DB: d1TestDatabase(database)
  };
  const { result } = await getAdminAbsence(env, '?pending_sort=request_id&pending_dir=asc');
  const states = Object.fromEntries(
    result.pending.slice(0, 4).map((row) => [row.request_id, row.notification_status])
  );

  assert.deepEqual(states, {
    'P-001': 'sent',
    'P-002': 'not_queued',
    'P-003': 'retrying',
    'P-004': 'retrying'
  });
  assert.deepEqual(
    Object.fromEntries(result.pending.slice(0, 4).map((row) => [row.request_id, [row.notification_sent_total, row.notification_total]])),
    { 'P-001': [1, 1], 'P-002': [0, 0], 'P-003': [0, 2], 'P-004': [1, 2] }
  );
  assert.deepEqual(result.summary.notification_counts, {
    sent: 1, not_queued: 98, retrying: 2
  });
});

test('admin absence rows expose their own store timezone for date rendering', async () => {
  const database = absenceAdminQueryDatabase();
  const env = {
    ENVIRONMENT: 'production',
    BOT_TOKEN: 'test-token', WEBHOOK_SECRET: 'test-secret', ADMIN_IDS: 'ADMIN1',
    DB: d1TestDatabase(database)
  };
  const { result } = await getAdminAbsence(env, '?stores=STORE1%2CSTORE2');
  assert.equal(result.history.find((row) => row.request_id === 'APP-VND').timezone, 'Asia/Ho_Chi_Minh');
  assert.equal(result.history.find((row) => row.request_id === 'APP-USD').timezone, 'America/New_York');
  assert.match(source, /formatDisplayValue\(key, row\[key\], row\)/);
  assert.match(source, /row\.timezone \|\| currentStore\(\)\.timezone/);
});

test('absence totals by currency use actual approved fine records', async () => {
  const database = absenceAdminQueryDatabase();
  const env = {
    ENVIRONMENT: 'production',
    BOT_TOKEN: 'test-token', WEBHOOK_SECRET: 'test-secret', ADMIN_IDS: 'ADMIN1',
    DB: d1TestDatabase(database)
  };
  const { result } = await getAdminAbsence(env, '?stores=STORE1%2CSTORE2');

  assert.deepEqual(result.summary.fine_totals, [
    { currency: '$', amount: 20 },
    { currency: '₫', amount: 3000000 }
  ]);
  assert.deepEqual(
    result.history.filter((row) => row.status === 'approved').map((row) => row.actual_fine).sort((a, b) => a - b),
    [20, 3000000]
  );
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
  const env = { ENVIRONMENT: 'production', BOT_TOKEN: 'test', DB: d1TestDatabase(database) };
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
  const env = { ENVIRONMENT: 'production', BOT_TOKEN: 'test', DB: d1TestDatabase(database) };
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
  const env = { ENVIRONMENT: 'production', BOT_TOKEN: 'test', DB: d1TestDatabase(database) };
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

test('does not send when the employee is disabled after claim and before final fetch', async () => {
  const database = notificationTestDatabase();
  database.prepare(`INSERT INTO absence_fine_notifications (request_id, admin_id) VALUES ('ABS-1', 'A1')`).run();
  let adminReads = 0;
  const env = {
    ENVIRONMENT: 'production',
    BOT_TOKEN: 'test', ADMIN_IDS: '',
    DB: d1TestDatabase(database, async (sql) => {
      if (!/role IN \('admin', 'owner'\)/.test(sql)) return;
      adminReads += 1;
      if (adminReads === 2) {
        database.prepare(`
          UPDATE store_members SET absence_check_enabled = 0
          WHERE store_id = 'STORE1' AND telegram_id = 'U1'
        `).run();
      }
    })
  };
  const originalFetch = globalThis.fetch;
  let sends = 0;
  globalThis.fetch = async () => {
    sends += 1;
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    assert.equal(await deliverAbsenceNotification(
      env, { name: 'Store', currency: '$' }, notificationRow('A1')
    ), false);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(sends, 0);
  assert.deepEqual({ ...database.prepare(`
    SELECT status, last_error FROM absence_fine_notifications
  `).get() }, { status: 'cancelled', last_error: 'absence_check_disabled' });
});

test('cancels a queued absence notification when admin access was revoked', async () => {
  const database = notificationTestDatabase();
  database.prepare(`INSERT INTO absence_fine_notifications (request_id, admin_id) VALUES ('ABS-1', 'A1')`).run();
  database.prepare(`UPDATE store_members SET status = 'disabled' WHERE telegram_id = 'A1'`).run();
  const env = { ENVIRONMENT: 'production', BOT_TOKEN: 'test', ADMIN_IDS: '', DB: d1TestDatabase(database) };
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
  const env = { ENVIRONMENT: 'production', BOT_TOKEN: 'test', ADMIN_IDS: '', DB: d1TestDatabase(database) };
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
  const env = { ENVIRONMENT: 'production', BOT_TOKEN: 'test', ADMIN_IDS: '', DB: d1TestDatabase(database) };
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
  const env = { ENVIRONMENT: 'production', BOT_TOKEN: 'test', ADMIN_IDS: '', DB: d1TestDatabase(database) };
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

test('rechecks employee eligibility when inserting an absence after candidate discovery', async () => {
  const database = absenceCronTestDatabase();
  let disabled = false;
  const env = {
    ENVIRONMENT: 'production',
    BOT_TOKEN: 'test', ADMIN_IDS: '',
    DB: d1TestDatabase(database, null, {
      beforeRun(sql) {
        if (disabled || !/INSERT OR IGNORE INTO absence_fine_requests/.test(sql)) return;
        disabled = true;
        database.prepare(`
          UPDATE store_members SET absence_check_enabled = 0, absence_check_enabled_at = NULL
          WHERE store_id = 'STORE1' AND telegram_id = 'U1'
        `).run();
      }
    })
  };

  await processAbsenceFines(env, new Date('2026-07-15T03:10:00.000Z'));

  assert.equal(disabled, true);
  assert.equal(database.prepare(`SELECT COUNT(*) AS total FROM absence_fine_requests`).get().total, 0);
});

test('rechecks request and employee state when inserting a notification from a stale snapshot', async () => {
  const database = absenceCronTestDatabase();
  database.exec(`
    UPDATE stores SET absence_last_checked_date = '2026-07-14' WHERE store_id = 'STORE1';
    INSERT INTO absence_fine_requests VALUES (
      'ABS-1', 'STORE1', 'U1', '2026-07-14', 1.5, 1.5, 'pending', '2026-07-15T03:00:00.000Z'
    );
  `);
  let disabled = false;
  const env = {
    ENVIRONMENT: 'production',
    BOT_TOKEN: 'test', ADMIN_IDS: '',
    DB: d1TestDatabase(database, null, {
      beforeRun(sql) {
        if (disabled || !/INSERT OR IGNORE INTO absence_fine_notifications/.test(sql)) return;
        disabled = true;
        database.prepare(`
          UPDATE store_members SET absence_check_enabled = 0, absence_check_enabled_at = NULL
          WHERE store_id = 'STORE1' AND telegram_id = 'U1'
        `).run();
      }
    })
  };

  await processAbsenceFines(env, new Date('2026-07-15T03:10:00.000Z'));

  assert.equal(disabled, true);
  assert.equal(database.prepare(`SELECT COUNT(*) AS total FROM absence_fine_notifications`).get().total, 0);
});

test('discovers each absence once while excluding an exempt employee and a not-yet re-enabled employee', async () => {
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
    ENVIRONMENT: 'production',
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
            if (/FROM absence_fine_notifications n/.test(sql)) return { eligible: 1 };
            throw new Error(`Unexpected first SQL: ${sql}`);
          },
          async all() {
            if (/FROM stores/.test(sql)) return { results: [store] };
            if (/FROM store_members m/.test(sql)) {
              const members = [
                { telegram_id: '10', joined_at: '2026-07-01T00:00:00.000Z', display_name: 'Alice', absence_check_enabled: 1, absence_check_enabled_at: '2026-07-01T00:00:00.000Z' },
                { telegram_id: '11', joined_at: '2026-07-15T00:00:00.000Z', display_name: 'Bob', absence_check_enabled: 1, absence_check_enabled_at: '2026-07-15T00:00:00.000Z' },
                { telegram_id: '12', joined_at: '2026-07-01T00:00:00.000Z', display_name: 'Exempt', absence_check_enabled: 0, absence_check_enabled_at: null },
                { telegram_id: '13', joined_at: '2026-07-01T00:00:00.000Z', display_name: 'Re-enabled', absence_check_enabled: 1, absence_check_enabled_at: '2026-07-14T15:00:00.000Z' }
              ];
              return { results: /m\.absence_check_enabled = 1/.test(sql)
                ? members.filter((member) => member.absence_check_enabled === 1)
                : members };
            }
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
