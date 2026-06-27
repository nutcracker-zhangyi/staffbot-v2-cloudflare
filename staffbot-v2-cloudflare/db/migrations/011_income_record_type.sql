ALTER TABLE income_records ADD COLUMN type TEXT NOT NULL DEFAULT 'income';

UPDATE income_records
SET type = CASE
  WHEN income = 0 AND commission_income = 0 AND fine != 0 THEN 'fine'
  ELSE 'income'
END
WHERE type IS NULL OR type = 'income';

INSERT INTO income_records (
  record_id, store_id, telegram_id, income, commission_rate, commission_income,
  fine, type, source, request_id, approved_at, admin_id
)
SELECT
  'REC-MIG-' || lower(hex(randomblob(16))),
  store_id,
  telegram_id,
  0,
  commission_rate,
  0,
  fine,
  'fine',
  source || '_fine',
  request_id,
  approved_at,
  admin_id
FROM income_records
WHERE type = 'income'
  AND fine != 0
  AND (income != 0 OR commission_income != 0);

UPDATE income_records
SET fine = 0
WHERE type = 'income'
  AND fine != 0
  AND (income != 0 OR commission_income != 0);
