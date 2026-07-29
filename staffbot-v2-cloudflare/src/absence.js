import { makeId } from './audit.js';
import { mutationCount } from './approvals.js';
import { addIsoDays, absenceScanDates, localDate, zonedMidnightIso } from './dates.js';
import { attendanceFineAmount, formatMoney } from './money.js';
import { adminIds } from './security.js';
import { isStoreAdmin } from './stores.js';
import { sendMessage } from './telegram-client.js';

export { absenceScanDates, completedAttendanceDate } from './dates.js';
export {
  approveAbsenceFineRequest,
  cancelAbsenceForApprovedLeave,
  rejectAbsenceFineRequest
} from './approvals.js';

export const ABSENCE_PENDING_COLUMNS = Object.freeze([
  'store_id', 'display_name', 'business_date', 'fine', 'created_at',
  'notification_status', 'notification_delivery', 'action'
]);
export const ABSENCE_HISTORY_COLUMNS = Object.freeze([
  'store_id', 'display_name', 'business_date', 'status', 'original_fine',
  'actual_fine', 'admin_id', 'decided_at', 'decision_reason', 'income_record_id'
]);

export function absenceApprovalKeyboard(requestId) {
  return [[
    { text: '批准罚款', callback_data: `abs:a:${requestId}` },
    { text: '驳回', callback_data: `abs:r:${requestId}` }
  ]];
}

export async function processAbsenceFines(env, now = new Date()) {
  const stores = await env.DB.prepare(`
    SELECT * FROM stores
    WHERE status = 'active' AND absence_fine_enabled_at IS NOT NULL
  `).all();

  for (const store of stores.results || []) {
    const timezone = store.timezone || 'Asia/Tokyo';
    for (const businessDate of absenceScanDates(store, now)) {
      const candidates = await env.DB.prepare(`
        SELECT m.telegram_id,
               m.joined_at,
               m.absence_check_enabled_at,
               m.payroll_start_date,
               COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), m.telegram_id) AS display_name
        FROM store_members m
        LEFT JOIN users u ON u.telegram_id = m.telegram_id
        WHERE m.store_id = ?
          AND m.status = 'active'
          AND m.role = 'employee'
          AND m.absence_check_enabled = 1
          AND NOT EXISTS (
            SELECT 1 FROM attendance_records a
            WHERE a.store_id = m.store_id
              AND a.telegram_id = m.telegram_id
              AND a.business_date = ?
              AND a.type = 'checkin'
          )
          AND NOT EXISTS (
            SELECT 1 FROM leave_requests l
            WHERE l.store_id = m.store_id
              AND l.telegram_id = m.telegram_id
              AND l.leave_date = ?
              AND l.status = 'approved'
          )
      `).bind(store.store_id, businessDate, businessDate).all();

      for (const member of candidates.results || []) {
        if (!member.payroll_start_date
          || businessDate < member.payroll_start_date) continue;
        if (localDate(new Date(member.joined_at), timezone) > businessDate) continue;
        if (member.absence_check_enabled_at
          && localDate(new Date(member.absence_check_enabled_at), timezone) > businessDate) continue;
        const fine = attendanceFineAmount(store, store.absence_fine);
        const nextBusinessDate = zonedMidnightIso(addIsoDays(businessDate, 1), timezone);
        await env.DB.prepare(`
          INSERT OR IGNORE INTO absence_fine_requests
            (request_id, store_id, telegram_id, business_date, original_fine, fine, status, created_at)
          SELECT ?, ?, ?, ?, ?, ?, 'pending', ?
          FROM store_members m
          WHERE m.store_id = ? AND m.telegram_id = ?
            AND m.status = 'active' AND m.role = 'employee'
            AND m.absence_check_enabled = 1
            AND m.joined_at < ?
            AND m.absence_check_enabled_at IS NOT NULL
            AND m.absence_check_enabled_at < ?
            AND m.payroll_start_date IS NOT NULL
            AND m.payroll_start_date <= ?
            AND NOT EXISTS (
              SELECT 1 FROM attendance_records a
              WHERE a.store_id = m.store_id
                AND a.telegram_id = m.telegram_id
                AND a.business_date = ? AND a.type = 'checkin'
            )
            AND NOT EXISTS (
              SELECT 1 FROM leave_requests l
              WHERE l.store_id = m.store_id
                AND l.telegram_id = m.telegram_id
                AND l.leave_date = ? AND l.status = 'approved'
            )
        `).bind(
          makeId('ABS'), store.store_id, member.telegram_id, businessDate, fine, fine, now.toISOString(),
          store.store_id, member.telegram_id, nextBusinessDate, nextBusinessDate,
          businessDate, businessDate, businessDate
        ).run();
      }

      await env.DB.prepare(`
        UPDATE stores SET absence_last_checked_date = ?, updated_at = ? WHERE store_id = ?
      `).bind(businessDate, now.toISOString(), store.store_id).run();
      store.absence_last_checked_date = businessDate;
    }

    const requests = await env.DB.prepare(`
      SELECT r.*,
             COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), r.telegram_id) AS display_name
      FROM absence_fine_requests r
      LEFT JOIN store_members m ON m.store_id = r.store_id AND m.telegram_id = r.telegram_id
      LEFT JOIN users u ON u.telegram_id = r.telegram_id
      WHERE r.store_id = ? AND r.status = 'pending'
      ORDER BY r.business_date, r.created_at
    `).bind(store.store_id).all();

    const adminRows = await env.DB.prepare(`
      SELECT telegram_id FROM store_members
      WHERE store_id = ? AND status = 'active' AND role IN ('admin', 'owner')
    `).bind(store.store_id).all();
    const admins = new Set([...(adminRows.results || []).map((row) => String(row.telegram_id)), ...adminIds(env)]);
    for (const request of requests.results || []) {
      for (const adminId of admins) {
        await env.DB.prepare(`
          INSERT OR IGNORE INTO absence_fine_notifications (request_id, admin_id)
          SELECT ?, ?
          WHERE EXISTS (
            SELECT 1
            FROM absence_fine_requests r
            JOIN store_members m
              ON m.store_id = r.store_id AND m.telegram_id = r.telegram_id
            WHERE r.request_id = ? AND r.status = 'pending'
              AND m.status = 'active' AND m.role = 'employee'
              AND m.absence_check_enabled = 1
          )
        `).bind(request.request_id, adminId, request.request_id).run();
      }
    }

    const staleClaim = new Date(now.getTime() - 15 * 60 * 1000).toISOString();
    const notifications = await env.DB.prepare(`
      SELECT n.*, r.store_id, r.telegram_id, r.business_date, r.fine,
             COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), r.telegram_id) AS display_name
      FROM absence_fine_notifications n
      JOIN absence_fine_requests r ON r.request_id = n.request_id
      LEFT JOIN store_members m ON m.store_id = r.store_id AND m.telegram_id = r.telegram_id
      LEFT JOIN users u ON u.telegram_id = r.telegram_id
      WHERE r.store_id = ? AND r.status = 'pending'
        AND (n.status = 'pending' OR (n.status = 'sending' AND n.claimed_at < ?))
      ORDER BY r.business_date, r.created_at, n.admin_id
    `).bind(store.store_id, staleClaim).all();
    for (const notification of notifications.results || []) {
      await deliverAbsenceNotification(env, store, notification, now);
    }
  }
}

export async function deliverAbsenceNotification(env, store, notification, now = new Date()) {
  if (!(await isStoreAdmin(env, notification.admin_id, notification.store_id))) {
    await cancelAbsenceNotification(env, notification, 'admin_access_revoked');
    return false;
  }
  const claimedAt = now.toISOString();
  const staleClaim = new Date(now.getTime() - 15 * 60 * 1000).toISOString();
  const claim = await env.DB.prepare(`
    UPDATE absence_fine_notifications
    SET status = 'sending', attempts = attempts + 1, claimed_at = ?, last_error = NULL
    WHERE request_id = ? AND admin_id = ?
      AND (status = 'pending' OR (status = 'sending' AND claimed_at < ?))
      AND EXISTS (
        SELECT 1 FROM absence_fine_requests r
        WHERE r.request_id = absence_fine_notifications.request_id
          AND r.store_id = ? AND r.status = 'pending'
      )
  `).bind(claimedAt, notification.request_id, notification.admin_id, staleClaim, notification.store_id).run();
  if (mutationCount(claim) !== 1) {
    await env.DB.prepare(`
      UPDATE absence_fine_notifications
      SET status = 'cancelled', claimed_at = NULL, last_error = 'absence_request_not_pending'
      WHERE request_id = ? AND admin_id = ? AND status != 'sent'
        AND NOT EXISTS (
          SELECT 1 FROM absence_fine_requests r
          WHERE r.request_id = absence_fine_notifications.request_id
            AND r.store_id = ? AND r.status = 'pending'
        )
    `).bind(notification.request_id, notification.admin_id, notification.store_id).run();
    return false;
  }
  if (!(await isStoreAdmin(env, notification.admin_id, notification.store_id))) {
    await cancelAbsenceNotification(env, notification, 'admin_access_revoked');
    return false;
  }

  const sendable = await env.DB.prepare(`
    SELECT 1
    FROM absence_fine_notifications n
    JOIN absence_fine_requests r ON r.request_id = n.request_id
    JOIN store_members m ON m.store_id = r.store_id AND m.telegram_id = r.telegram_id
    WHERE n.request_id = ? AND n.admin_id = ?
      AND n.status = 'sending' AND n.claimed_at = ?
      AND r.store_id = ? AND r.status = 'pending'
      AND m.status = 'active' AND m.role = 'employee'
      AND m.absence_check_enabled = 1
  `).bind(
    notification.request_id, notification.admin_id, claimedAt, notification.store_id
  ).first();
  if (!sendable) {
    await env.DB.prepare(`
      UPDATE absence_fine_notifications
      SET status = 'cancelled', claimed_at = NULL,
          last_error = CASE WHEN EXISTS (
            SELECT 1 FROM absence_fine_requests r
            WHERE r.request_id = absence_fine_notifications.request_id
              AND r.store_id = ? AND r.status = 'pending'
          ) THEN 'absence_check_disabled' ELSE 'absence_request_not_pending' END
      WHERE request_id = ? AND admin_id = ?
        AND status = 'sending' AND claimed_at = ?
    `).bind(
      notification.store_id, notification.request_id, notification.admin_id, claimedAt
    ).run();
    return false;
  }

  // State can still change while Telegram is in flight, so this external boundary remains at-least-once.
  let result;
  try {
    result = await sendMessage(env, notification.admin_id, [
      '缺勤罚款待审核',
      `店铺：${store.name}`,
      `员工：${notification.display_name} (${notification.telegram_id})`,
      `日期：${notification.business_date}`,
      `建议罚款：${formatMoney(store, notification.fine)}`
    ].join('\n'), { inline_keyboard: absenceApprovalKeyboard(notification.request_id) });
  } catch (error) {
    result = { ok: false, description: String(error && error.message ? error.message : error) };
  }

  if (result && result.ok === true) {
    await env.DB.prepare(`
      UPDATE absence_fine_notifications
      SET status = 'sent', sent_at = ?, last_error = NULL
      WHERE request_id = ? AND admin_id = ? AND status = 'sending' AND claimed_at = ?
    `).bind(claimedAt, notification.request_id, notification.admin_id, claimedAt).run();
    return true;
  }
  await env.DB.prepare(`
    UPDATE absence_fine_notifications
    SET status = 'pending', claimed_at = NULL, last_error = ?
    WHERE request_id = ? AND admin_id = ? AND status = 'sending' AND claimed_at = ?
  `).bind(JSON.stringify(result || { ok: false }), notification.request_id, notification.admin_id, claimedAt).run();
  return false;
}

async function cancelAbsenceNotification(env, notification, reason) {
  await env.DB.prepare(`
    UPDATE absence_fine_notifications
    SET status = 'cancelled', claimed_at = NULL, last_error = ?
    WHERE request_id = ? AND admin_id = ? AND status != 'sent'
  `).bind(reason, notification.request_id, notification.admin_id).run();
}
