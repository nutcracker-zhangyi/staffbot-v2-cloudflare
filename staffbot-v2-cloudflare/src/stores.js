import { nowIso } from './audit.js';
import { DEFAULT_STORE_ID } from './constants.js';
import { isGlobalAdmin } from './security.js';

export async function resolveStoreForUser(env, telegramId, preferredStoreId) {
  if (preferredStoreId) {
    const preferred = await getStoreForMember(env, preferredStoreId, telegramId);
    if (preferred) return { store: preferred, needsChoice: false, stores: [preferred] };
  }
  const currentStoreId = await getCurrentStoreId(env, telegramId);
  if (currentStoreId) {
    const current = await getStoreForMember(env, currentStoreId, telegramId);
    if (current) return { store: current, needsChoice: false, stores: [current] };
  }
  const stores = await listMemberStores(env, telegramId);
  if (stores.length === 1) {
    await setCurrentStore(env, telegramId, stores[0].store_id);
    return { store: stores[0], needsChoice: false, stores };
  }
  if (stores.length > 1) return { store: null, needsChoice: true, stores };
  if (isGlobalAdmin(env, telegramId)) {
    const defaultStore = await getStore(env, DEFAULT_STORE_ID);
    return { store: defaultStore, needsChoice: false, stores: defaultStore ? [defaultStore] : [] };
  }
  return { store: null, needsChoice: false, stores: [] };
}

export async function listMemberStores(env, telegramId) {
  const rows = await env.DB.prepare(`
    SELECT s.* FROM stores s
    JOIN store_members m ON m.store_id = s.store_id
    WHERE m.telegram_id = ? AND m.status = 'active' AND s.status = 'active'
    ORDER BY CASE WHEN s.store_id = ? THEN 0 ELSE 1 END, s.name
  `).bind(telegramId, DEFAULT_STORE_ID).all();
  return rows.results || [];
}

export async function getStoreForMember(env, storeId, telegramId) {
  const row = await env.DB.prepare(`
    SELECT s.* FROM stores s
    JOIN store_members m ON m.store_id = s.store_id
    WHERE s.store_id = ? AND m.telegram_id = ? AND m.status = 'active' AND s.status = 'active'
  `).bind(storeId, telegramId).first();
  return row || null;
}

export async function getStore(env, storeId) {
  const row = await env.DB.prepare(`SELECT * FROM stores WHERE store_id = ?`).bind(storeId || DEFAULT_STORE_ID).first();
  return row || null;
}

export async function getMemberDisplayName(env, storeId, telegramId) {
  const row = await env.DB.prepare(`
    SELECT COALESCE(
      NULLIF(m.display_name, ''),
      NULLIF(u.name, ''),
      NULLIF(u.username, ''),
      m.telegram_id
    ) AS display_name
    FROM store_members m
    LEFT JOIN users u ON u.telegram_id = m.telegram_id
    WHERE m.store_id = ? AND m.telegram_id = ?
  `).bind(storeId, telegramId).first();
  return row && row.display_name ? row.display_name : telegramId;
}

export async function getCurrentStoreId(env, telegramId) {
  const row = await env.DB.prepare(`SELECT current_store_id FROM user_preferences WHERE telegram_id = ?`).bind(telegramId).first();
  return row && row.current_store_id ? String(row.current_store_id) : '';
}

export async function setCurrentStore(env, telegramId, storeId) {
  await env.DB.prepare(`
    INSERT INTO user_preferences (telegram_id, language, current_store_id, updated_at)
    VALUES (?, 'zh', ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET
      current_store_id = excluded.current_store_id,
      updated_at = excluded.updated_at
  `).bind(telegramId, storeId, nowIso()).run();
}

export async function listActiveStores(env) {
  const rows = await env.DB.prepare(`
    SELECT * FROM stores WHERE status = 'active' ORDER BY name
  `).all();
  return rows.results || [];
}

export async function isAnyAdmin(env, telegramId) {
  if (isGlobalAdmin(env, telegramId)) return true;
  const row = await env.DB.prepare(`
    SELECT 1 FROM store_members
    WHERE telegram_id = ? AND status = 'active' AND role IN ('admin', 'owner')
    LIMIT 1
  `).bind(telegramId).first();
  return !!row;
}

export async function isStoreAdmin(env, telegramId, storeId) {
  if (isGlobalAdmin(env, telegramId)) return true;
  const row = await env.DB.prepare(`
    SELECT 1 FROM store_members
    WHERE store_id = ? AND telegram_id = ? AND status = 'active' AND role IN ('admin', 'owner')
  `).bind(storeId, telegramId).first();
  return !!row;
}

export async function isStoreOwner(env, telegramId, storeId) {
  const row = await env.DB.prepare(`
    SELECT 1 FROM store_members
    WHERE store_id = ? AND telegram_id = ? AND status = 'active' AND role = 'owner'
  `).bind(storeId, telegramId).first();
  return !!row;
}
