const SP = PropertiesService.getScriptProperties();
const BOT_TOKEN = SP.getProperty('BOT_TOKEN');
const WEBHOOK_SECRET = SP.getProperty('WEBHOOK_SECRET');
const SHEET_ID = SP.getProperty('SHEET_ID');
const API_URL = 'https://api.telegram.org/bot' + BOT_TOKEN + '/';

const SH = {
  EMP: 'Employees', PEND: 'Pending_Income', INC: 'Income_Records',
  REJ: 'Rejected_Income', SREQ: 'Salary_Requests', SHIS: 'Salary_History',
  ATT: 'Attendance', AUDIT: 'Admin_Audit_Log', SET: 'Settings', ERR: 'Error_Log'
};

function getSetting(key, def) {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('set_' + key);
  if (hit !== null) return hit;
  const data = sheet(SH.SET).getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === key) {
      const v = String(data[i][1]);
      cache.put('set_' + key, v, 300);
      return v;
    }
  }
  return def;
}
function getAdminIds() {
  return getSetting('ADMIN_IDS', '').split(',').map(s => s.trim()).filter(String);
}
function isAdmin(id) { return getAdminIds().indexOf(String(id)) !== -1; }
function tzName() { return getSetting('TIMEZONE', 'Asia/Ho_Chi_Minh'); }
function cur() { return getSetting('CURRENCY', '$'); }
