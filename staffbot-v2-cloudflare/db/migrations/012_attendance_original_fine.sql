ALTER TABLE attendance_records ADD COLUMN original_fine REAL NOT NULL DEFAULT 0;

UPDATE attendance_records
SET original_fine = fine
WHERE original_fine = 0 AND fine != 0;
