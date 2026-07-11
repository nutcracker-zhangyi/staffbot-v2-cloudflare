function nowIso() {
  return Utilities.formatDate(new Date(), tzName(), "yyyy-MM-dd'T'HH:mm:ss");
}
function fmtDate(d) { return Utilities.formatDate(d, tzName(), 'yyyy-MM-dd'); }
function fmtTime(d) { return Utilities.formatDate(d, tzName(), 'HH:mm'); }
function fmtMoney(n) { return cur() + Number(n).toFixed(2); }

function genId(prefix) {
  return prefix + '-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
}

function parseAmount(text, allowZero) {
  const n = Number(String(text).replace(',', '.').trim());
  if (isNaN(n) || !isFinite(n)) return null;
  if (n < 0 || n > 1000000) return null;
  if (!allowZero && n === 0) return null;
  return Math.round(n * 100) / 100;
}

function setState(uid, state, data) {
  CacheService.getScriptCache().put('st_' + uid, JSON.stringify({ s: state, d: data || {} }), 3600);
}
function getState(uid) {
  const v = CacheService.getScriptCache().get('st_' + uid);
  return v ? JSON.parse(v) : null;
}
function clearState(uid) { CacheService.getScriptCache().remove('st_' + uid); }

function isDuplicateUpdate(updateId) {
  const c = CacheService.getScriptCache();
  const key = 'upd_' + updateId;
  if (c.get(key)) return true;
  c.put(key, '1', 3600);
  return false;
}

function audit(adminId, action, targetReqId, targetEmpId, details) {
  appendRow(SH.AUDIT, [genId('LOG'), nowIso(), String(adminId), action,
    targetReqId || '', String(targetEmpId || ''), details || '']);
}
function logError(err) {
  try { appendRow(SH.ERR, [nowIso(), String(err && err.stack ? err.stack : err)]); } catch (e) {}
}
