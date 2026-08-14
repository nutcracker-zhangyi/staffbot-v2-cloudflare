DELETE FROM admin_sessions;
DELETE FROM admin_login_codes;
DELETE FROM user_states;
DELETE FROM absence_fine_notifications;
DELETE FROM bot_logs;

UPDATE absence_fine_requests
SET notified_at = NULL
WHERE status = 'pending';
