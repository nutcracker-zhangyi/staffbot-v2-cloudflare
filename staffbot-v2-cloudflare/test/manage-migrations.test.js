import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const schema = readFileSync(
  new URL('../db/schema.sql', import.meta.url),
  'utf8'
);

test('canonical schema enforces manage CSRF and leased claims', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  const sessionColumns = db.prepare(`
    PRAGMA table_info(admin_sessions)
  `).all().map((column) => column.name);
  assert.ok(sessionColumns.includes('csrf_token'));
  db.prepare(`
    INSERT INTO admin_task_claims (
      task_type, task_id, store_id, claimed_by,
      claimed_at, lease_expires_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'payroll', 'PAYROLL-1', 'STORE-1', 'ADMIN-1',
    '2026-08-01T00:00:00.000Z',
    '2026-08-01T00:15:00.000Z',
    '2026-08-01T00:00:00.000Z'
  );
  assert.throws(() => db.prepare(`
    INSERT INTO admin_task_claims (
      task_type, task_id, store_id, claimed_by,
      claimed_at, lease_expires_at, updated_at
    ) VALUES ('unknown', 'TASK-2', 'STORE-1', 'ADMIN-1', ?, ?, ?)
  `).run(
    '2026-08-01T00:00:00.000Z',
    '2026-08-01T00:15:00.000Z',
    '2026-08-01T00:00:00.000Z'
  ));
});

test('migration preserves existing admin sessions', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE admin_sessions (
      token TEXT PRIMARY KEY,
      telegram_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO admin_sessions VALUES (
      'SESSION-1', 'ADMIN-1',
      '2099-01-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z'
    );
  `);
  const migration023 = readFileSync(
    new URL(
      '../db/migrations/023_admin_manage_sessions_and_claims.sql',
      import.meta.url
    ),
    'utf8'
  );
  db.exec(migration023);
  assert.equal(
    db.prepare(`SELECT telegram_id FROM admin_sessions`).get().telegram_id,
    'ADMIN-1'
  );
  assert.equal(
    db.prepare(`SELECT csrf_token FROM admin_sessions`).get().csrf_token,
    null
  );
});
