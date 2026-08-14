import { makeId, nowIso } from './audit.js';
import {
  json,
  readJson,
  sessionCookieValue,
  setSessionCookie
} from './http.js';
import { nextLoginFailureState } from './security.js';
import { isAnyAdmin } from './stores.js';
import { sendMessage } from './telegram-client.js';

export async function startAdminLogin(request, env) {
  const body = await readJson(request);
  const telegramId = String(body.telegram_id || '').trim();
  if (!telegramId || !(await isAnyAdmin(env, telegramId))) {
    return json({ ok: false, error: 'forbidden' }, 403);
  }
  const existing = await env.DB.prepare(`SELECT locked_until FROM admin_login_codes WHERE telegram_id = ?`).bind(telegramId).first();
  if (existing && existing.locked_until && existing.locked_until > nowIso()) {
    return json({ ok: false, error: 'too_many_attempts' }, 429);
  }
  const code = makeNumericCode();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
  await env.DB.prepare(`
    INSERT INTO admin_login_codes (telegram_id, code, expires_at, created_at, failed_attempts, locked_until)
    VALUES (?, ?, ?, ?, 0, NULL)
    ON CONFLICT(telegram_id) DO UPDATE SET
      code = excluded.code,
      expires_at = excluded.expires_at,
      created_at = excluded.created_at,
      failed_attempts = 0,
      locked_until = NULL
  `).bind(telegramId, code, expiresAt, now.toISOString()).run();
  await sendMessage(env, telegramId, `StaffBot 后台登录验证码：${code}\n10 分钟内有效。`);
  return json({ ok: true });
}

export async function verifyAdminLogin(request, env) {
  const body = await readJson(request);
  const telegramId = String(body.telegram_id || '').trim();
  const code = String(body.code || '').trim();
  const found = await env.DB.prepare(`SELECT * FROM admin_login_codes WHERE telegram_id = ?`).bind(telegramId).first();
  if (found && found.locked_until && found.locked_until > nowIso()) {
    return json({ ok: false, error: 'too_many_attempts' }, 429);
  }
  if (!found || found.code !== code || found.expires_at <= nowIso() || !(await isAnyAdmin(env, telegramId))) {
    if (found) {
      const next = nextLoginFailureState(found.failed_attempts, new Date());
      await env.DB.prepare(`
        UPDATE admin_login_codes SET failed_attempts = ?, locked_until = ? WHERE telegram_id = ?
      `).bind(next.failedAttempts, next.lockedUntil, telegramId).run();
    }
    return json({ ok: false, error: 'invalid_code' }, 403);
  }
  await env.DB.prepare(`DELETE FROM admin_login_codes WHERE telegram_id = ?`).bind(telegramId).run();
  const token = makeId('SESS');
  const csrfToken = makeId('CSRF');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(`
    INSERT INTO admin_sessions (
      token, telegram_id, expires_at, created_at, csrf_token
    ) VALUES (?, ?, ?, ?, ?)
  `).bind(
    token,
    telegramId,
    expiresAt,
    now.toISOString(),
    csrfToken
  ).run();
  return json({ ok: true }, 200, setSessionCookie(token, expiresAt));
}

export async function requireAdminSession(request, env) {
  const token = sessionCookieValue(request.headers.get('cookie') || '');
  if (!token) return null;
  const checkedAt = nowIso();
  let row = await env.DB.prepare(`
    SELECT * FROM admin_sessions
    WHERE token = ? AND expires_at > ?
  `).bind(token, checkedAt).first();
  if (!row || !(await isAnyAdmin(env, row.telegram_id))) return null;

  if (row.csrf_token === null || row.csrf_token === '') {
    const csrfToken = makeId('CSRF');
    await env.DB.prepare(`
      UPDATE admin_sessions
      SET csrf_token = ?
      WHERE token = ? AND expires_at > ? AND csrf_token IS NULL
    `).bind(csrfToken, token, checkedAt).run();
    row = await env.DB.prepare(`
      SELECT * FROM admin_sessions
      WHERE token = ? AND expires_at > ?
    `).bind(token, checkedAt).first();
    if (!row) return null;
  }

  return { ...row, token };
}

export function requireManageMutation(request, session) {
  if (!session || !session.csrf_token) return false;
  return request.headers.get('x-csrf-token') === session.csrf_token;
}

export async function logoutAdminSession(env, token) {
  await env.DB.prepare(`
    DELETE FROM admin_sessions WHERE token = ?
  `).bind(token).run();
}

function makeNumericCode() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const value = ((bytes[0] << 24) >>> 0) + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3];
  return String(value % 1000000).padStart(6, '0');
}
