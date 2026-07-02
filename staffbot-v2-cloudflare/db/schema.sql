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
  leave_min_notice_days INTEGER NOT NULL DEFAULT 1,
  leave_max_notice_days INTEGER NOT NULL DEFAULT 5,
  leave_monthly_limit INTEGER NOT NULL DEFAULT 4,
  leave_daily_limit INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO stores (
  store_id, name, status, timezone, currency, checkin_time, checkout_time,
  late_fine, early_leave_fine, leave_min_notice_days, leave_max_notice_days,
  leave_monthly_limit, leave_daily_limit, created_at, updated_at
) VALUES (
  'DEFAULT', 'Default Store', 'active', 'Asia/Tokyo', '$', '18:30', '01:30',
  0.5, 1.5, 1, 5, 4, 1, datetime('now'), datetime('now')
);

CREATE TABLE IF NOT EXISTS users (
  telegram_id TEXT PRIMARY KEY,
  name TEXT,
  username TEXT,
  role TEXT NOT NULL DEFAULT 'employee',
  status TEXT NOT NULL DEFAULT 'active',
  cycle_start TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS store_members (
  store_id TEXT NOT NULL,
  telegram_id TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'employee',
  status TEXT NOT NULL DEFAULT 'active',
  commission_rate REAL NOT NULL DEFAULT 0.6,
  cycle_start TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (store_id, telegram_id)
);

CREATE INDEX IF NOT EXISTS idx_store_members_telegram_id
  ON store_members (telegram_id);

CREATE INDEX IF NOT EXISTS idx_store_members_store_role
  ON store_members (store_id, role, status);

CREATE TABLE IF NOT EXISTS user_states (
  telegram_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_preferences (
  telegram_id TEXT PRIMARY KEY,
  language TEXT NOT NULL DEFAULT 'zh',
  current_store_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_income (
  request_id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL DEFAULT 'DEFAULT',
  telegram_id TEXT NOT NULL,
  income REAL NOT NULL,
  commission_rate REAL NOT NULL DEFAULT 0.6,
  commission_income REAL NOT NULL DEFAULT 0,
  fine REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  submitted_at TEXT NOT NULL,
  decided_at TEXT,
  admin_id TEXT,
  reject_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_income_store_status
  ON pending_income (store_id, status);

CREATE INDEX IF NOT EXISTS idx_pending_income_telegram_id
  ON pending_income (telegram_id);

CREATE TABLE IF NOT EXISTS income_records (
  record_id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL DEFAULT 'DEFAULT',
  telegram_id TEXT NOT NULL,
  income REAL NOT NULL,
  commission_rate REAL NOT NULL DEFAULT 0.6,
  commission_income REAL NOT NULL DEFAULT 0,
  original_fine REAL NOT NULL DEFAULT 0,
  fine REAL NOT NULL DEFAULT 0,
  type TEXT NOT NULL DEFAULT 'income',
  source TEXT NOT NULL DEFAULT 'manual',
  request_id TEXT,
  approved_at TEXT NOT NULL,
  admin_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_income_records_store_user_time
  ON income_records (store_id, telegram_id, approved_at);

CREATE INDEX IF NOT EXISTS idx_income_records_approved_at
  ON income_records (approved_at);

CREATE TABLE IF NOT EXISTS salary_requests (
  request_id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL DEFAULT 'DEFAULT',
  telegram_id TEXT NOT NULL,
  amount_snapshot REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  admin_id TEXT,
  reject_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_salary_requests_store_status
  ON salary_requests (store_id, status);

CREATE INDEX IF NOT EXISTS idx_salary_requests_telegram_id
  ON salary_requests (telegram_id);

CREATE TABLE IF NOT EXISTS salary_records (
  record_id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL DEFAULT 'DEFAULT',
  telegram_id TEXT NOT NULL,
  amount REAL NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  admin_id TEXT NOT NULL,
  request_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_salary_records_store_user
  ON salary_records (store_id, telegram_id);

CREATE TABLE IF NOT EXISTS salary_advance_requests (
  request_id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL DEFAULT 'DEFAULT',
  telegram_id TEXT NOT NULL,
  amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  admin_id TEXT,
  reject_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_salary_advance_store_status
  ON salary_advance_requests (store_id, status);

CREATE INDEX IF NOT EXISTS idx_salary_advance_telegram_id
  ON salary_advance_requests (telegram_id);

CREATE TABLE IF NOT EXISTS attendance_records (
  record_id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL DEFAULT 'DEFAULT',
  telegram_id TEXT NOT NULL,
  business_date TEXT NOT NULL,
  type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  late INTEGER NOT NULL DEFAULT 0,
  early_leave INTEGER NOT NULL DEFAULT 0,
  original_fine REAL NOT NULL DEFAULT 0,
  fine REAL NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_attendance_records_store_user_date
  ON attendance_records (store_id, telegram_id, business_date);

CREATE TABLE IF NOT EXISTS pending_checkout_requests (
  request_id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL DEFAULT 'DEFAULT',
  telegram_id TEXT NOT NULL,
  business_date TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  early_leave INTEGER NOT NULL DEFAULT 0,
  fine REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  submitted_at TEXT NOT NULL,
  decided_at TEXT,
  admin_id TEXT,
  reject_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_checkout_store_status
  ON pending_checkout_requests (store_id, status, submitted_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_checkout_one_pending
  ON pending_checkout_requests (store_id, telegram_id, business_date)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS leave_requests (
  request_id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL DEFAULT 'DEFAULT',
  telegram_id TEXT NOT NULL,
  leave_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  admin_id TEXT,
  reject_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_leave_requests_store_date_status
  ON leave_requests (store_id, leave_date, status);

CREATE INDEX IF NOT EXISTS idx_leave_requests_store_user_date_status
  ON leave_requests (store_id, telegram_id, leave_date, status);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id TEXT NOT NULL DEFAULT 'DEFAULT',
  admin_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_store_time
  ON admin_audit_logs (store_id, created_at);

CREATE TABLE IF NOT EXISTS bot_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id TEXT NOT NULL DEFAULT 'DEFAULT',
  level TEXT NOT NULL,
  event TEXT NOT NULL,
  telegram_id TEXT,
  message_text TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bot_logs_store_time
  ON bot_logs (store_id, created_at);

CREATE INDEX IF NOT EXISTS idx_bot_logs_telegram_id
  ON bot_logs (telegram_id);

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
  created_at TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT
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

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO settings (key, value, updated_at)
VALUES
  ('currency', '$', datetime('now')),
  ('timezone', 'Asia/Tokyo', datetime('now')),
  ('checkin_time', '18:30', datetime('now')),
  ('checkout_time', '01:30', datetime('now')),
  ('late_fine', '0.5', datetime('now')),
  ('early_leave_fine', '1.5', datetime('now'));
