CREATE TABLE payroll_payment_qr_codes (
  qr_id TEXT PRIMARY KEY
    CHECK (length(trim(qr_id)) > 0),
  store_id TEXT NOT NULL
    CHECK (length(trim(store_id)) > 0),
  telegram_id TEXT NOT NULL
    CHECK (length(trim(telegram_id)) > 0),
  object_key TEXT NOT NULL UNIQUE
    CHECK (length(trim(object_key)) > 0),
  telegram_file_id TEXT NOT NULL
    CHECK (length(trim(telegram_file_id)) > 0),
  mime_type TEXT NOT NULL
    CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes INTEGER NOT NULL
    CHECK (typeof(size_bytes) = 'integer' AND size_bytes > 0),
  uploaded_at TEXT NOT NULL,
  superseded_at TEXT
);

CREATE INDEX idx_payroll_payment_qr_employee_time
  ON payroll_payment_qr_codes (
    store_id,
    telegram_id,
    uploaded_at
  );

CREATE UNIQUE INDEX idx_payroll_payment_qr_active
  ON payroll_payment_qr_codes (store_id, telegram_id)
  WHERE superseded_at IS NULL;

ALTER TABLE payroll_payment_profiles
  ADD COLUMN usdt_qr_id TEXT;

ALTER TABLE payroll_disbursements
  ADD COLUMN usdt_qr_id_snapshot TEXT;
