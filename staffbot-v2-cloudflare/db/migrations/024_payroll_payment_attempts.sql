CREATE TABLE IF NOT EXISTS payroll_payment_attempts (
  attempt_id TEXT PRIMARY KEY,
  payroll_id TEXT NOT NULL,
  version INTEGER NOT NULL
    CHECK (typeof(version) = 'integer' AND version > 0),
  status TEXT NOT NULL
    CHECK (status IN (
      'draft',
      'submitted',
      'employee_confirmed',
      'employee_disputed',
      'abandoned'
    )),
  bank_micros INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(bank_micros) = 'integer' AND bank_micros >= 0),
  usdt_micros INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(usdt_micros) = 'integer' AND usdt_micros >= 0),
  cash_micros INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(cash_micros) = 'integer' AND cash_micros >= 0),
  submitted_by TEXT,
  submitted_at TEXT,
  employee_response TEXT
    CHECK (
      employee_response IS NULL
      OR employee_response IN ('confirmed', 'disputed')
    ),
  idempotency_key_hash TEXT,
  employee_responded_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (payroll_id, version)
);

CREATE INDEX IF NOT EXISTS idx_payroll_payment_attempts_payroll_version
  ON payroll_payment_attempts (payroll_id, version);

CREATE INDEX IF NOT EXISTS idx_payroll_payment_attempts_status_updated
  ON payroll_payment_attempts (status, updated_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_payment_attempts_idempotency
  ON payroll_payment_attempts (payroll_id, idempotency_key_hash)
  WHERE idempotency_key_hash IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS trg_payroll_payment_attempt_amounts_immutable
BEFORE UPDATE OF payroll_id, version, bank_micros, usdt_micros, cash_micros
ON payroll_payment_attempts
WHEN OLD.status <> 'draft' AND (
  NEW.payroll_id IS NOT OLD.payroll_id
  OR NEW.version IS NOT OLD.version
  OR NEW.bank_micros IS NOT OLD.bank_micros
  OR NEW.usdt_micros IS NOT OLD.usdt_micros
  OR NEW.cash_micros IS NOT OLD.cash_micros
)
BEGIN
  SELECT RAISE(ABORT, 'payment attempt amounts are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_payroll_payment_attempt_delete_immutable
BEFORE DELETE ON payroll_payment_attempts
WHEN OLD.status <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'submitted payment attempts are immutable');
END;

DROP TABLE IF EXISTS payroll_disbursements_v024;

CREATE TABLE payroll_disbursements_v024 (
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
  current_payment_attempt_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (store_id, telegram_id, scheduled_date)
);

INSERT INTO payroll_disbursements_v024 (
  payroll_id, store_id, telegram_id, payroll_start_date,
  scheduled_date, cycle_day, period_start, cutoff_at,
  amount_snapshot_micros, currency, status,
  accepts_bank, accepts_usdt, accepts_cash,
  bank_details_snapshot, usdt_details_snapshot, usdt_qr_id_snapshot,
  bank_micros, usdt_micros, cash_micros,
  current_admin_id, negative_carry_entry_id, salary_record_id,
  employee_notified_at, employee_reminded_at,
  employee_notification_error, payment_sent_at, disputed_at, confirmed_at,
  current_payment_attempt_id, created_at, updated_at
)
SELECT
  payroll_id, store_id, telegram_id, payroll_start_date,
  scheduled_date, cycle_day, period_start, cutoff_at,
  amount_snapshot_micros, currency, status,
  accepts_bank, accepts_usdt, accepts_cash,
  bank_details_snapshot, usdt_details_snapshot, usdt_qr_id_snapshot,
  bank_micros, usdt_micros, cash_micros,
  current_admin_id, negative_carry_entry_id, salary_record_id,
  employee_notified_at, employee_reminded_at,
  employee_notification_error, payment_sent_at, disputed_at, confirmed_at,
  NULL, created_at, updated_at
FROM payroll_disbursements;

DROP TABLE payroll_disbursements;
ALTER TABLE payroll_disbursements_v024 RENAME TO payroll_disbursements;

CREATE INDEX IF NOT EXISTS idx_payroll_disbursements_due
  ON payroll_disbursements (status, employee_reminded_at);

CREATE INDEX IF NOT EXISTS idx_payroll_disbursements_store_status
  ON payroll_disbursements (store_id, status, scheduled_date);

INSERT OR IGNORE INTO payroll_payment_attempts (
  attempt_id, payroll_id, version, status,
  bank_micros, usdt_micros, cash_micros,
  submitted_by, submitted_at,
  employee_response, employee_responded_at,
  created_at, updated_at
)
SELECT
  'ATTEMPT:LEGACY:' || payroll_id,
  payroll_id,
  1,
  CASE status
    WHEN 'confirmed' THEN 'employee_confirmed'
    WHEN 'disputed' THEN 'employee_disputed'
    ELSE 'submitted'
  END,
  bank_micros,
  usdt_micros,
  cash_micros,
  current_admin_id,
  payment_sent_at,
  CASE status
    WHEN 'confirmed' THEN 'confirmed'
    WHEN 'disputed' THEN 'disputed'
    ELSE NULL
  END,
  CASE status
    WHEN 'confirmed' THEN confirmed_at
    WHEN 'disputed' THEN disputed_at
    ELSE NULL
  END,
  COALESCE(payment_sent_at, updated_at, created_at),
  updated_at
FROM payroll_disbursements AS payroll
WHERE
  bank_micros <> 0
  OR usdt_micros <> 0
  OR cash_micros <> 0
  OR status IN (
    'awaiting_employee_confirmation',
    'disputed',
    'confirmed'
  )
  OR EXISTS (
    SELECT 1
    FROM payroll_payment_proofs AS proof
    WHERE proof.payroll_id = payroll.payroll_id
  );

UPDATE payroll_disbursements
SET current_payment_attempt_id = (
  SELECT attempt.attempt_id
  FROM payroll_payment_attempts AS attempt
  WHERE attempt.payroll_id = payroll_disbursements.payroll_id
  ORDER BY attempt.version DESC
  LIMIT 1
)
WHERE EXISTS (
  SELECT 1
  FROM payroll_payment_attempts AS attempt
  WHERE attempt.payroll_id = payroll_disbursements.payroll_id
);

DROP TABLE IF EXISTS payroll_payment_proofs_v024;

CREATE TABLE payroll_payment_proofs_v024 (
  proof_id TEXT PRIMARY KEY,
  payroll_id TEXT NOT NULL,
  attempt_id TEXT,
  method TEXT NOT NULL
    CHECK (method IN ('bank', 'usdt', 'cash')),
  object_key TEXT NOT NULL UNIQUE,
  telegram_file_id TEXT,
  telegram_delivered_at TEXT,
  file_name TEXT,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL
    CHECK (typeof(size_bytes) = 'integer' AND size_bytes > 0),
  sort_order INTEGER NOT NULL
    CHECK (typeof(sort_order) = 'integer' AND sort_order > 0),
  uploaded_by TEXT NOT NULL,
  superseded_at TEXT,
  uploaded_at TEXT NOT NULL
);

INSERT INTO payroll_payment_proofs_v024 (
  proof_id, payroll_id, attempt_id, method, object_key,
  telegram_file_id, telegram_delivered_at, file_name, mime_type,
  size_bytes, sort_order, uploaded_by, superseded_at, uploaded_at
)
SELECT
  proof.proof_id,
  proof.payroll_id,
  attempt.attempt_id,
  proof.method,
  proof.object_key,
  proof.telegram_file_id,
  payroll.payment_sent_at,
  proof.file_name,
  proof.mime_type,
  proof.size_bytes,
  proof.sort_order,
  proof.uploaded_by,
  proof.superseded_at,
  proof.uploaded_at
FROM payroll_payment_proofs AS proof
LEFT JOIN payroll_disbursements AS payroll
  ON payroll.payroll_id = proof.payroll_id
LEFT JOIN payroll_payment_attempts AS attempt
  ON attempt.attempt_id = 'ATTEMPT:LEGACY:' || proof.payroll_id;

DROP TABLE payroll_payment_proofs;
ALTER TABLE payroll_payment_proofs_v024 RENAME TO payroll_payment_proofs;

CREATE INDEX IF NOT EXISTS idx_payroll_proofs_payroll_method
  ON payroll_payment_proofs (payroll_id, method, sort_order);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_proofs_attempt_order
  ON payroll_payment_proofs (attempt_id, method, sort_order)
  WHERE attempt_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_proofs_legacy_order
  ON payroll_payment_proofs (payroll_id, method, sort_order)
  WHERE attempt_id IS NULL;
