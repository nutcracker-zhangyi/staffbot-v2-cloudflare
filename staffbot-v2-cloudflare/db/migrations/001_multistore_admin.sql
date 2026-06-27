CREATE TABLE IF NOT EXISTS stores (
  store_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  currency TEXT NOT NULL DEFAULT '$',
  checkin_time TEXT NOT NULL DEFAULT '18:30',
  checkout_time TEXT NOT NULL DEFAULT '01:30',
  late_fine REAL NOT NULL DEFAULT 0.5,
  early_leave_fine REAL NOT NULL DEFAULT 1.5,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO stores (
  store_id, name, status, timezone, currency, checkin_time, checkout_time,
  late_fine, early_leave_fine, created_at, updated_at
) VALUES (
  'DEFAULT', 'Default Store', 'active', 'Asia/Tokyo', '$', '18:30', '01:30',
  0.5, 1.5, datetime('now'), datetime('now')
);

CREATE TABLE IF NOT EXISTS store_members (
  store_id TEXT NOT NULL,
  telegram_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'employee',
  status TEXT NOT NULL DEFAULT 'active',
  cycle_start TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (store_id, telegram_id)
);

INSERT OR IGNORE INTO store_members (
  store_id, telegram_id, role, status, cycle_start, joined_at, updated_at
)
SELECT 'DEFAULT', telegram_id, role, status, cycle_start, created_at, updated_at
FROM users;

ALTER TABLE pending_income ADD COLUMN store_id TEXT NOT NULL DEFAULT 'DEFAULT';
ALTER TABLE income_records ADD COLUMN store_id TEXT NOT NULL DEFAULT 'DEFAULT';
ALTER TABLE salary_requests ADD COLUMN store_id TEXT NOT NULL DEFAULT 'DEFAULT';
ALTER TABLE salary_records ADD COLUMN store_id TEXT NOT NULL DEFAULT 'DEFAULT';
ALTER TABLE attendance_records ADD COLUMN store_id TEXT NOT NULL DEFAULT 'DEFAULT';
ALTER TABLE admin_audit_logs ADD COLUMN store_id TEXT NOT NULL DEFAULT 'DEFAULT';
ALTER TABLE bot_logs ADD COLUMN store_id TEXT NOT NULL DEFAULT 'DEFAULT';

CREATE INDEX IF NOT EXISTS idx_store_members_telegram_id
  ON store_members (telegram_id);
CREATE INDEX IF NOT EXISTS idx_store_members_store_role
  ON store_members (store_id, role, status);
CREATE INDEX IF NOT EXISTS idx_pending_income_store_status
  ON pending_income (store_id, status);
CREATE INDEX IF NOT EXISTS idx_income_records_store_user_time
  ON income_records (store_id, telegram_id, approved_at);
CREATE INDEX IF NOT EXISTS idx_salary_requests_store_status
  ON salary_requests (store_id, status);
CREATE INDEX IF NOT EXISTS idx_salary_records_store_user
  ON salary_records (store_id, telegram_id);
CREATE INDEX IF NOT EXISTS idx_attendance_records_store_user_date
  ON attendance_records (store_id, telegram_id, business_date);
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_store_time
  ON admin_audit_logs (store_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bot_logs_store_time
  ON bot_logs (store_id, created_at);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token TEXT PRIMARY KEY,
  telegram_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at
  ON admin_sessions (expires_at);

CREATE TABLE IF NOT EXISTS admin_login_codes (
  telegram_id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS store_invites (
  invite_code TEXT PRIMARY KEY,
  store_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'employee',
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT
);
