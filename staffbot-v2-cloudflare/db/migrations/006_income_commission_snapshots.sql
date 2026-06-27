ALTER TABLE pending_income ADD COLUMN commission_rate REAL NOT NULL DEFAULT 0.6;
ALTER TABLE pending_income ADD COLUMN commission_income REAL NOT NULL DEFAULT 0;
UPDATE pending_income
SET commission_income = ROUND(income * commission_rate, 2)
WHERE commission_income = 0 AND income > 0;

ALTER TABLE income_records ADD COLUMN commission_rate REAL NOT NULL DEFAULT 0.6;
ALTER TABLE income_records ADD COLUMN commission_income REAL NOT NULL DEFAULT 0;
UPDATE income_records
SET commission_income = ROUND(income * commission_rate, 2)
WHERE commission_income = 0 AND income > 0;
