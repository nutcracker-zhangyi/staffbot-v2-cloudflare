ALTER TABLE store_members ADD COLUMN display_name TEXT;

UPDATE store_members
SET display_name = COALESCE(display_name, (
  SELECT name FROM users WHERE users.telegram_id = store_members.telegram_id
))
WHERE display_name IS NULL;
