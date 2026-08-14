CREATE TABLE payroll_entries (
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

CREATE INDEX idx_payroll_entries_employee_time
  ON payroll_entries (store_id, telegram_id, effective_at);

CREATE INDEX idx_payroll_entries_store_time_type
  ON payroll_entries (store_id, effective_at, type);

CREATE UNIQUE INDEX idx_payroll_entries_source
  ON payroll_entries (source, source_id)
  WHERE source_id IS NOT NULL AND type != 'reversal';

CREATE UNIQUE INDEX idx_payroll_entries_one_reversal
  ON payroll_entries (reverses_entry_id)
  WHERE reverses_entry_id IS NOT NULL;
