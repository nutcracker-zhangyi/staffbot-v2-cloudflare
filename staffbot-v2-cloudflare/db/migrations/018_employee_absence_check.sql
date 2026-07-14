ALTER TABLE store_members ADD COLUMN absence_check_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE store_members ADD COLUMN absence_check_enabled_at TEXT;
UPDATE store_members
SET absence_check_enabled_at = joined_at
WHERE absence_check_enabled = 1 AND absence_check_enabled_at IS NULL;
