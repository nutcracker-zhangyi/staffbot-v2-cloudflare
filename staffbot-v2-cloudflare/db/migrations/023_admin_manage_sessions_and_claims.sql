ALTER TABLE admin_sessions ADD COLUMN csrf_token TEXT;

CREATE TABLE admin_task_claims (
  task_type TEXT NOT NULL
    CHECK (task_type IN (
      'income',
      'leave',
      'absence',
      'advance',
      'payroll'
    )),
  task_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  claimed_by TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_type, task_id)
);

CREATE INDEX idx_admin_task_claims_store_expiry
  ON admin_task_claims (store_id, lease_expires_at);
