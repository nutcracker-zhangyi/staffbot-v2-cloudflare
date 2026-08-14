DROP TABLE IF EXISTS payroll_backfill_guard;

CREATE TABLE payroll_backfill_guard (
  valid INTEGER NOT NULL CHECK (valid = 1)
);

INSERT INTO payroll_backfill_guard (valid)
SELECT CASE
  WHEN (
    SELECT COUNT(*)
    FROM income_records
    WHERE type IS NULL OR type NOT IN ('income', 'fine', 'advance')
  ) != 0 THEN 0
  WHEN (
    SELECT COUNT(*)
    FROM income_records
    WHERE record_id IS NULL
       OR store_id IS NULL
       OR telegram_id IS NULL
       OR approved_at IS NULL
       OR admin_id IS NULL
       OR source IS NULL
  ) != 0 THEN 0
  WHEN (
    SELECT COUNT(*)
    FROM income_records
    WHERE ABS(
      ROUND(commission_income * 1000000)
      - commission_income * 1000000
    ) > 0.000001
       OR ABS(
         ROUND(fine * 1000000)
         - fine * 1000000
       ) > 0.000001
  ) != 0 THEN 0
  WHEN (
    SELECT COUNT(*)
    FROM income_records
    WHERE ABS(ROUND(commission_income * 1000000)) > 9007199254740991
       OR ABS(ROUND(fine * 1000000)) > 9007199254740991
  ) != 0 THEN 0
  WHEN (
    SELECT COUNT(*)
    FROM income_records i
    LEFT JOIN stores s ON s.store_id = i.store_id
    WHERE s.store_id IS NULL
  ) != 0 THEN 0
  WHEN (
    SELECT COUNT(*)
    FROM income_records i
    LEFT JOIN store_members m
      ON m.store_id = i.store_id
     AND m.telegram_id = i.telegram_id
    WHERE m.telegram_id IS NULL
  ) != 0 THEN 0
  ELSE 1
END;

DROP TABLE payroll_backfill_guard;

INSERT INTO payroll_entries (
  entry_id,
  store_id,
  telegram_id,
  type,
  amount_micros,
  currency,
  effective_at,
  source,
  source_id,
  created_by,
  created_at,
  reverses_entry_id,
  metadata_json
)
SELECT
  'PAY-MIG-' || i.record_id,
  i.store_id,
  i.telegram_id,
  i.type,
  CASE i.type
    WHEN 'income' THEN ROUND(i.commission_income * 1000000)
    WHEN 'fine' THEN -ROUND(i.fine * 1000000)
    WHEN 'advance' THEN -ROUND(i.fine * 1000000)
  END,
  s.currency,
  i.approved_at,
  i.source,
  i.record_id,
  i.admin_id,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  NULL,
  json_object(
    'legacy_record_id', i.record_id,
    'legacy_request_id', i.request_id,
    'legacy_income', i.income,
    'legacy_commission_rate', i.commission_rate,
    'legacy_commission_income', i.commission_income,
    'legacy_original_fine', i.original_fine,
    'legacy_fine', i.fine
  )
FROM income_records i
JOIN stores s ON s.store_id = i.store_id
WHERE i.type IN ('income', 'fine', 'advance')
  AND CASE i.type
    WHEN 'income' THEN ROUND(i.commission_income * 1000000)
    WHEN 'fine' THEN ROUND(i.fine * 1000000)
    WHEN 'advance' THEN ROUND(i.fine * 1000000)
  END != 0
ON CONFLICT(entry_id) DO NOTHING;
