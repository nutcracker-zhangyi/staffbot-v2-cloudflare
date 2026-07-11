function ss() { return SpreadsheetApp.openById(SHEET_ID); }
function sheet(name) {
  const s = ss().getSheetByName(name);
  if (!s) throw new Error('Sheet not found: ' + name + ' — 请先运行 setupSheets()');
  return s;
}
function appendRow(name, row) { sheet(name).appendRow(row); }

function findRowById(name, id) {
  const data = sheet(name).getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) return { row: i + 1, values: data[i] };
  }
  return null;
}

/** 员工自动注册;Language列默认空,首次会触发语言选择 */
function ensureEmployee(from) {
  const uid = String(from.id);
  const found = findRowById(SH.EMP, uid);
  if (found) return found;
  const name = [(from.first_name || ''), (from.last_name || '')].join(' ').trim();
  appendRow(SH.EMP, [uid, name, from.username || '', 'active', nowIso(), nowIso(), '']);
  return findRowById(SH.EMP, uid);
}
function isActiveEmployee(uid) {
  const r = findRowById(SH.EMP, uid);
  return r && r.values[3] === 'active';
}
function hasLanguage(uid) {
  const r = findRowById(SH.EMP, uid);
  return r && r.values[6];
}
