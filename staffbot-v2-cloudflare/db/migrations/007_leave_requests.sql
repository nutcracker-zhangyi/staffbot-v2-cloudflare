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
