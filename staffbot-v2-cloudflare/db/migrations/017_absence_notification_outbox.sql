ALTER TABLE absence_fine_requests ADD COLUMN cancellation_reason TEXT;

CREATE TABLE IF NOT EXISTS absence_fine_notifications (
  request_id TEXT NOT NULL,
  admin_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at TEXT,
  sent_at TEXT,
  last_error TEXT,
  PRIMARY KEY (request_id, admin_id)
);

CREATE INDEX IF NOT EXISTS idx_absence_notifications_delivery
  ON absence_fine_notifications (status, claimed_at);
