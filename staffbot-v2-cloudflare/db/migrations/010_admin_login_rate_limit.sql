ALTER TABLE admin_login_codes ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE admin_login_codes ADD COLUMN locked_until TEXT;
