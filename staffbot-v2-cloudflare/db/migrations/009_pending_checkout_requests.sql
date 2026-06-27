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
