ALTER TABLE stores ADD COLUMN absence_fine REAL NOT NULL DEFAULT 1.5;
ALTER TABLE stores ADD COLUMN absence_fine_enabled_at TEXT;
ALTER TABLE stores ADD COLUMN absence_last_checked_date TEXT;

CREATE TABLE IF NOT EXISTS absence_fine_requests (
  request_id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL,
  telegram_id TEXT NOT NULL,
  business_date TEXT NOT NULL,
  original_fine REAL NOT NULL,
  fine REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  notified_at TEXT,
  decided_at TEXT,
  admin_id TEXT,
  reject_reason TEXT,
  income_record_id TEXT,
  UNIQUE (store_id, telegram_id, business_date)
);

CREATE INDEX IF NOT EXISTS idx_absence_fine_store_status_date
  ON absence_fine_requests (store_id, status, business_date);

CREATE UNIQUE INDEX IF NOT EXISTS idx_income_records_one_absence_fine
  ON income_records (source, request_id)
  WHERE source = 'attendance_absence';
