function startAttendance(uid, chatId) {
  send(chatId, t(uid, 'share_location_prompt'), {
    keyboard: [
      [{ text: t(uid, 'btn_share_location'), request_location: true }],
      [{ text: t(uid, 'btn_cancel') }]
    ], resize_keyboard: true, one_time_keyboard: true
  });
}

function onLocation(uid, chatId, loc) {
  CacheService.getScriptCache().put('loc_' + uid, JSON.stringify({ lat: loc.latitude, lng: loc.longitude }), 600);
  send(chatId, t(uid, 'location_received'), mainMenuKb(uid));
  send(chatId, t(uid, 'choose_action'), { inline_keyboard: [[
    { text: t(uid, 'btn_checkin'),  callback_data: 'att_in' },
    { text: t(uid, 'btn_checkout'), callback_data: 'att_out' }
  ]] });
}
function getCachedLocation(uid) {
  const v = CacheService.getScriptCache().get('loc_' + uid);
  return v ? JSON.parse(v) : null;
}
function businessDate(d) {
  const h = Number(Utilities.formatDate(d, tzName(), 'H'));
  const base = (h < 12) ? new Date(d.getTime() - 24 * 3600 * 1000) : d;
  return Utilities.formatDate(base, tzName(), 'yyyy-MM-dd');
}
function shiftMinutes(hhmm) {
  const p = hhmm.split(':');
  let h = Number(p[0]); const m = Number(p[1]);
  if (h < 12) h += 24;
  return h * 60 + m;
}
function hasAttendance(uid, bd, type) {
  const data = sheet(SH.ATT).getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][1]) === uid && String(data[i][2]) === bd && data[i][3] === type) return true;
  }
  return false;
}

function doCheckIn(cb) {
  const uid = String(cb.from.id);
  const loc = getCachedLocation(uid);
  if (!loc) return ack(cb, t(uid, 'location_expired'), true);

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let msgText;
  try {
    const now = new Date();
    const bd = businessDate(now);
    if (hasAttendance(uid, bd, 'CHECKIN')) return ack(cb, t(uid, 'already_checked_in', { date: bd }), true);

    const tm = fmtTime(now);
    const late = shiftMinutes(tm) > shiftMinutes(getSetting('CHECKIN_TIME', '18:30'));
    const fine = late ? Number(getSetting('LATE_FINE', '0.5')) : 0;

    appendRow(SH.ATT, [genId('ATT'), uid, bd, 'CHECKIN', nowIso(), loc.lat, loc.lng, late, false, fine]);
    if (fine > 0) appendRow(SH.INC, [genId('REC'), uid, 0, fine, 'ATTENDANCE_LATE', nowIso(), nowIso(), 'SYSTEM']);

    msgText = t(uid, 'checkin_recorded', { date: bd, time: tm }) +
      (late ? t(uid, 'checkin_late', { fine: fmtMoney(fine) }) : t(uid, 'checkin_ontime'));
  } finally { lock.releaseLock(); }
  finalizeAdminMsg(cb, msgText);
  ack(cb, t(uid, 'checked_in_label'));
}

function doCheckOut(cb) {
  const uid = String(cb.from.id);
  const loc = getCachedLocation(uid);
  if (!loc) return ack(cb, t(uid, 'location_expired'), true);

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let msgText;
  try {
    const now = new Date();
    const bd = businessDate(now);
    if (!hasAttendance(uid, bd, 'CHECKIN')) return ack(cb, t(uid, 'no_checkin_found', { date: bd }), true);
    if (hasAttendance(uid, bd, 'CHECKOUT')) return ack(cb, t(uid, 'already_checked_out', { date: bd }), true);

    const tm = fmtTime(now);
    const early = shiftMinutes(tm) < shiftMinutes(getSetting('CHECKOUT_TIME', '01:30'));
    const fine = early ? Number(getSetting('EARLY_LEAVE_FINE', '1.5')) : 0;

    appendRow(SH.ATT, [genId('ATT'), uid, bd, 'CHECKOUT', nowIso(), loc.lat, loc.lng, false, early, fine]);
    if (fine > 0) appendRow(SH.INC, [genId('REC'), uid, 0, fine, 'ATTENDANCE_EARLY', nowIso(), nowIso(), 'SYSTEM']);

    msgText = t(uid, 'checkout_recorded', { date: bd, time: tm }) +
      (early ? t(uid, 'checkout_early', { fine: fmtMoney(fine) }) : t(uid, 'checkout_ontime'));
  } finally { lock.releaseLock(); }
  finalizeAdminMsg(cb, msgText);
  ack(cb, t(uid, 'checked_out_label'));
}
