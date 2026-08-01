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
  leave_same_day_cutoff_hour INTEGER NOT NULL DEFAULT 5,
  absence_fine REAL NOT NULL DEFAULT 1.5,
  absence_fine_enabled_at TEXT,
  absence_last_checked_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO stores (
  store_id, name, status, timezone, currency, checkin_time, checkout_time,
  late_fine, early_leave_fine, leave_min_notice_days, leave_max_notice_days,
  leave_monthly_limit, leave_daily_limit, leave_same_day_cutoff_hour,
  absence_fine, absence_fine_enabled_at, absence_last_checked_date, created_at, updated_at
) VALUES (
  'DEFAULT', 'Default Store', 'active', 'Asia/Tokyo', '$', '18:30', '01:30',
  0.5, 1.5, 1, 5, 4, 1, 5, 1.5, NULL, NULL, datetime('now'), datetime('now')
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
  absence_check_enabled INTEGER NOT NULL DEFAULT 1,
  absence_check_enabled_at TEXT,
  payroll_start_date TEXT,
  payroll_automation_started_at TEXT,
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

CREATE TABLE IF NOT EXISTS payroll_entries (
  entry_id TEXT PRIMARY KEY
    CHECK (length(trim(entry_id)) > 0),
  store_id TEXT NOT NULL
    CHECK (length(trim(store_id)) > 0),
  telegram_id TEXT NOT NULL
    CHECK (length(trim(telegram_id)) > 0),
  type TEXT NOT NULL
    CHECK (type IN (
      'income',
      'fine',
      'advance',
      'bonus',
      'adjustment',
      'reversal',
      'negative_carry'
    )),
  amount_micros INTEGER NOT NULL
    CHECK (typeof(amount_micros) = 'integer')
    CHECK (amount_micros != 0)
    CHECK (
      (type IN ('income', 'bonus') AND amount_micros > 0)
      OR (type IN ('fine', 'advance', 'negative_carry') AND amount_micros < 0)
      OR (type IN ('adjustment', 'reversal') AND amount_micros != 0)
    ),
  currency TEXT NOT NULL
    CHECK (length(trim(currency)) > 0),
  effective_at TEXT NOT NULL
    CHECK (length(trim(effective_at)) > 0),
  source TEXT NOT NULL
    CHECK (length(trim(source)) > 0),
  source_id TEXT
    CHECK (source_id IS NULL OR length(trim(source_id)) > 0),
  created_by TEXT NOT NULL
    CHECK (length(trim(created_by)) > 0),
  created_at TEXT NOT NULL
    CHECK (length(trim(created_at)) > 0),
  reverses_entry_id TEXT
    CHECK (
      (type = 'reversal' AND reverses_entry_id IS NOT NULL)
      OR (type != 'reversal' AND reverses_entry_id IS NULL)
    ),
  metadata_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(metadata_json))
);

CREATE INDEX IF NOT EXISTS idx_payroll_entries_employee_time
  ON payroll_entries (store_id, telegram_id, effective_at);

CREATE INDEX IF NOT EXISTS idx_payroll_entries_store_time_type
  ON payroll_entries (store_id, effective_at, type);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_entries_source
  ON payroll_entries (source, source_id)
  WHERE source_id IS NOT NULL AND type != 'reversal';

CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_entries_one_reversal
  ON payroll_entries (reverses_entry_id)
  WHERE reverses_entry_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS payroll_payment_profiles (
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
  usdt_qr_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (store_id, telegram_id)
);

CREATE TABLE IF NOT EXISTS payroll_payment_qr_codes (
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

CREATE INDEX IF NOT EXISTS idx_payroll_payment_qr_employee_time
  ON payroll_payment_qr_codes (
    store_id,
    telegram_id,
    uploaded_at
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_payment_qr_active
  ON payroll_payment_qr_codes (store_id, telegram_id)
  WHERE superseded_at IS NULL;

CREATE TABLE IF NOT EXISTS payroll_disbursements (
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
  usdt_qr_id_snapshot TEXT,
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

CREATE INDEX IF NOT EXISTS idx_payroll_disbursements_due
  ON payroll_disbursements (status, employee_reminded_at);

CREATE INDEX IF NOT EXISTS idx_payroll_disbursements_store_status
  ON payroll_disbursements (store_id, status, scheduled_date);

CREATE TABLE IF NOT EXISTS payroll_payment_proofs (
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

CREATE INDEX IF NOT EXISTS idx_payroll_proofs_payroll_method
  ON payroll_payment_proofs (payroll_id, method, sort_order);

CREATE TABLE IF NOT EXISTS payroll_email_outbox (
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

CREATE INDEX IF NOT EXISTS idx_payroll_email_delivery
  ON payroll_email_outbox (status, claimed_at);

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
  cancellation_reason TEXT,
  income_record_id TEXT,
  UNIQUE (store_id, telegram_id, business_date)
);

CREATE TABLE IF NOT EXISTS absence_fine_notifications (
  request_id TEXT NOT NULL,
  admin_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at TEXT,
  sent_at TEXT,
  last_error TEXT,
  PRIMARY KEY (request_id, admin_id)
);

CREATE INDEX IF NOT EXISTS idx_absence_notifications_delivery
  ON absence_fine_notifications (status, claimed_at);

CREATE INDEX IF NOT EXISTS idx_absence_fine_store_status_date
  ON absence_fine_requests (store_id, status, business_date);

CREATE UNIQUE INDEX IF NOT EXISTS idx_income_records_one_absence_fine
  ON income_records (source, request_id)
  WHERE source = 'attendance_absence';

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
  created_at TEXT NOT NULL,
  csrf_token TEXT
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at
  ON admin_sessions (expires_at);

CREATE TABLE IF NOT EXISTS admin_task_claims (
  task_type TEXT NOT NULL
    CHECK (task_type IN (
      'income',
      'leave',
      'absence',
      'advance',
      'payroll'
    )),
  task_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  claimed_by TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_type, task_id)
);

CREATE INDEX IF NOT EXISTS idx_admin_task_claims_store_expiry
  ON admin_task_claims (store_id, lease_expires_at);

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
