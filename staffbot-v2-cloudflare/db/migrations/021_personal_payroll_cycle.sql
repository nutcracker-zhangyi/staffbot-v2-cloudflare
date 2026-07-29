ALTER TABLE store_members ADD COLUMN payroll_start_date TEXT;
ALTER TABLE store_members ADD COLUMN payroll_automation_started_at TEXT;

CREATE TABLE payroll_payment_profiles (
  store_id TEXT NOT NULL,
  telegram_id TEXT NOT NULL,
  accepts_bank INTEGER NOT NULL DEFAULT 0
    CHECK (accepts_bank IN (0, 1)),
  accepts_usdt INTEGER NOT NULL DEFAULT 0
    CHECK (accepts_usdt IN (0, 1)),
  accepts_cash INTEGER NOT NULL DEFAULT 0
    CHECK (accepts_cash IN (0, 1)),
  bank_details TEXT,
  usdt_details TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (store_id, telegram_id)
);

CREATE TABLE payroll_disbursements (
  payroll_id TEXT PRIMARY KEY
    CHECK (length(trim(payroll_id)) > 0),
  store_id TEXT NOT NULL
    CHECK (length(trim(store_id)) > 0),
  telegram_id TEXT NOT NULL
    CHECK (length(trim(telegram_id)) > 0),
  payroll_start_date TEXT NOT NULL,
  scheduled_date TEXT NOT NULL,
  cycle_day INTEGER NOT NULL
    CHECK (cycle_day IN (16, 30)),
  period_start TEXT NOT NULL,
  cutoff_at TEXT NOT NULL,
  amount_snapshot_micros INTEGER NOT NULL
    CHECK (typeof(amount_snapshot_micros) = 'integer'),
  currency TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN (
      'awaiting_employee_details',
      'awaiting_admin_payment',
      'awaiting_employee_confirmation',
      'disputed',
      'confirmed',
      'skipped_zero',
      'carried_negative'
    )),
  accepts_bank INTEGER NOT NULL DEFAULT 0
    CHECK (accepts_bank IN (0, 1)),
  accepts_usdt INTEGER NOT NULL DEFAULT 0
    CHECK (accepts_usdt IN (0, 1)),
  accepts_cash INTEGER NOT NULL DEFAULT 0
    CHECK (accepts_cash IN (0, 1)),
  bank_details_snapshot TEXT,
  usdt_details_snapshot TEXT,
  bank_micros INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(bank_micros) = 'integer' AND bank_micros >= 0),
  usdt_micros INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(usdt_micros) = 'integer' AND usdt_micros >= 0),
  cash_micros INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(cash_micros) = 'integer' AND cash_micros >= 0),
  current_admin_id TEXT,
  negative_carry_entry_id TEXT,
  salary_record_id TEXT,
  employee_notified_at TEXT,
  employee_reminded_at TEXT,
  employee_notification_error TEXT,
  payment_sent_at TEXT,
  disputed_at TEXT,
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (store_id, telegram_id, scheduled_date)
);

CREATE INDEX idx_payroll_disbursements_due
  ON payroll_disbursements (status, employee_reminded_at);

CREATE INDEX idx_payroll_disbursements_store_status
  ON payroll_disbursements (store_id, status, scheduled_date);

CREATE TABLE payroll_payment_proofs (
  proof_id TEXT PRIMARY KEY,
  payroll_id TEXT NOT NULL,
  method TEXT NOT NULL
    CHECK (method IN ('bank', 'usdt', 'cash')),
  object_key TEXT NOT NULL UNIQUE,
  telegram_file_id TEXT NOT NULL,
  file_name TEXT,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL
    CHECK (typeof(size_bytes) = 'integer' AND size_bytes > 0),
  sort_order INTEGER NOT NULL
    CHECK (typeof(sort_order) = 'integer' AND sort_order > 0),
  uploaded_by TEXT NOT NULL,
  superseded_at TEXT,
  uploaded_at TEXT NOT NULL,
  UNIQUE (payroll_id, method, sort_order)
);

CREATE INDEX idx_payroll_proofs_payroll_method
  ON payroll_payment_proofs (payroll_id, method, sort_order);

CREATE TABLE payroll_email_outbox (
  payroll_id TEXT PRIMARY KEY,
  recipient TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent')),
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(attempt_count) = 'integer' AND attempt_count >= 0),
  last_error TEXT,
  claimed_at TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_payroll_email_delivery
  ON payroll_email_outbox (status, claimed_at);
