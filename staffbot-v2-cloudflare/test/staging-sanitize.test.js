import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const sanitizerSql = await readFile(
  new URL('../scripts/staging-sanitize.sql', import.meta.url),
  'utf8'
);

function seededDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE admin_sessions (id TEXT);
    CREATE TABLE admin_login_codes (id TEXT);
    CREATE TABLE user_states (id TEXT);
    CREATE TABLE absence_fine_notifications (id TEXT);
    CREATE TABLE bot_logs (id TEXT);
    CREATE TABLE stores (id TEXT);
    CREATE TABLE income_records (id TEXT, amount REAL);
    CREATE TABLE salary_records (id TEXT, amount REAL);
    CREATE TABLE leave_requests (id TEXT);
    CREATE TABLE admin_audit_logs (id TEXT);
    CREATE TABLE absence_fine_requests (
      request_id TEXT,
      status TEXT,
      notified_at TEXT
    );

    INSERT INTO admin_sessions VALUES ('session-1');
    INSERT INTO admin_login_codes VALUES ('code-1');
    INSERT INTO user_states VALUES ('state-1');
    INSERT INTO absence_fine_notifications VALUES ('notification-1');
    INSERT INTO bot_logs VALUES ('log-1');
    INSERT INTO stores VALUES ('store-1');
    INSERT INTO income_records VALUES ('income-1', 125);
    INSERT INTO salary_records VALUES ('salary-1', 100);
    INSERT INTO leave_requests VALUES ('leave-1');
    INSERT INTO admin_audit_logs VALUES ('audit-1');
    INSERT INTO absence_fine_requests
      VALUES ('pending-1', 'pending', '2026-07-28T03:00:00.000Z');
    INSERT INTO absence_fine_requests
      VALUES ('approved-1', 'approved', '2026-07-28T04:00:00.000Z');
  `);
  return database;
}

test('clears transient staging state after importing production data', () => {
  const database = seededDatabase();
  database.exec(sanitizerSql);

  for (const table of [
    'admin_sessions',
    'admin_login_codes',
    'user_states',
    'absence_fine_notifications',
    'bot_logs'
  ]) {
    assert.equal(
      database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total,
      0,
      table
    );
  }
});

test('preserves business and financial history while resetting pending notification state', () => {
  const database = seededDatabase();
  database.exec(sanitizerSql);

  for (const table of [
    'stores',
    'income_records',
    'salary_records',
    'leave_requests',
    'admin_audit_logs',
    'absence_fine_requests'
  ]) {
    assert.ok(
      database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total > 0,
      table
    );
  }

  assert.deepEqual(
    database.prepare(`
      SELECT request_id, notified_at
      FROM absence_fine_requests
      ORDER BY request_id
    `).all().map((row) => ({ ...row })),
    [
      {
        request_id: 'approved-1',
        notified_at: '2026-07-28T04:00:00.000Z'
      },
      {
        request_id: 'pending-1',
        notified_at: null
      }
    ]
  );
});
