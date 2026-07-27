import { DEFAULT_STORE_ID } from './constants.js';

export function makeId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function makeStoreId() {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return `STORE_${Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function safeJson(text) {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
}

export async function audit(env, storeId, adminId, action, targetId, details) {
  await auditStatement(env, storeId, adminId, action, targetId, details).run();
}

export function auditStatement(env, storeId, adminId, action, targetId, details, createdAt = nowIso()) {
  return env.DB.prepare(`
    INSERT INTO admin_audit_logs (store_id, admin_id, action, target_id, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(storeId || DEFAULT_STORE_ID, adminId, action, targetId || '', JSON.stringify(details || {}), createdAt);
}

export async function logEvent(env, level, event, payload) {
  const safePayload = sanitizeLogPayload(payload);
  const telegramId = safePayload && safePayload.telegram_id ? String(safePayload.telegram_id) : null;
  const messageText = safePayload && safePayload.text ? String(safePayload.text) : null;
  const storeId = safePayload && safePayload.store_id ? String(safePayload.store_id) : DEFAULT_STORE_ID;
  await env.DB.prepare(`
    INSERT INTO bot_logs (store_id, level, event, telegram_id, message_text, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(storeId, level, event, telegramId, messageText, JSON.stringify(safePayload || {}), nowIso()).run();
}

export async function logError(env, event, error, payload) {
  await logEvent(env, 'error', event, {
    store_id: payload && payload.store_id ? payload.store_id : DEFAULT_STORE_ID,
    error: error && error.message ? error.message : String(error),
    payload
  });
}

export function sanitizeLogPayload(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const redacted = new Set(['text', 'message_text', 'payload', 'payload_json', 'latitude', 'longitude', 'lat', 'lng', 'location']);
  const safe = {};
  for (const [key, value] of Object.entries(payload)) {
    if (redacted.has(key)) safe[key] = '[redacted]';
    else if (key === 'telegram_id' || key === 'chat_id') safe[key] = String(value);
    else if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) safe[key] = value;
    else safe[key] = '[redacted]';
  }
  return safe;
}
