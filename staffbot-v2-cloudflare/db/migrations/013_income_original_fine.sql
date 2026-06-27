ALTER TABLE income_records ADD COLUMN original_fine REAL NOT NULL DEFAULT 0;

UPDATE income_records
SET original_fine = fine
WHERE type = 'fine' AND original_fine = 0;
