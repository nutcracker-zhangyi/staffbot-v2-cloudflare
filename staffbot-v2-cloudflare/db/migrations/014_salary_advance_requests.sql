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
