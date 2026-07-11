function startIncome(uid, chatId) {
  setState(uid, 'AWAIT_INCOME');
  send(chatId, t(uid, 'enter_income'));
}

function onIncomeAmount(uid, chatId, text) {
  const amt = parseAmount(text, false);
  if (amt === null) return send(chatId, t(uid, 'invalid_amount'));
  setState(uid, 'AWAIT_FINE', { income: amt });
  send(chatId, t(uid, 'enter_fine'));
}

function onFineAmount(uid, chatId, text, d) {
  const fine = parseAmount(text, true);
  if (fine === null) return send(chatId, t(uid, 'invalid_amount_zero'));
  clearState(uid);

  if (hasRecentDuplicatePending(uid, d.income, fine)) {
    return send(chatId, t(uid, 'duplicate_submission'), mainMenuKb(uid));
  }

  const reqId = genId('INC');
  appendRow(SH.PEND, [reqId, uid, d.income, fine, nowIso(), 'PENDING', '', '']);

  send(chatId, t(uid, 'income_submitted', { income: fmtMoney(d.income), fine: fmtMoney(fine) }), mainMenuKb(uid));

  const emp = findRowById(SH.EMP, uid);
  const now = new Date();
  // 管理员通知用英文(管理员视角统一),也可改为按各管理员语言
  getAdminIds().forEach(function (adminId) {
    send(adminId, t(adminId, 'admin_new_income', {
      name: emp.values[1], id: uid, income: fmtMoney(d.income), fine: fmtMoney(fine),
      date: fmtDate(now), time: fmtTime(now)
    }), { inline_keyboard: [[
      { text: t(adminId, 'btn_approve'), callback_data: 'inc_app:' + reqId },
      { text: t(adminId, 'btn_reject'),  callback_data: 'inc_rej:' + reqId }
    ]] });
  });
}

function hasRecentDuplicatePending(uid, income, fine) {
  const data = sheet(SH.PEND).getDataRange().getValues();
  const cutoff = Date.now() - 2 * 60 * 1000;
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][1]) === uid && data[i][5] === 'PENDING' &&
        Number(data[i][2]) === income && Number(data[i][3]) === fine &&
        new Date(data[i][4]).getTime() > cutoff) return true;
  }
  return false;
}

function approveIncome(cb, reqId) {
  const adminId = String(cb.from.id);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let empId, income, fine;
  try {
    const r = findRowById(SH.PEND, reqId);
    if (!r || r.values[5] !== 'PENDING') return ack(cb, t(adminId, 'already_processed'), true);
    empId = String(r.values[1]); income = r.values[2]; fine = r.values[3];
    sheet(SH.PEND).getRange(r.row, 6, 1, 3).setValues([['APPROVED', adminId, nowIso()]]);
    appendRow(SH.INC, [genId('REC'), empId, income, fine, 'MANUAL', r.values[4], nowIso(), adminId]);
  } finally { lock.releaseLock(); }
  audit(adminId, 'APPROVE_INCOME', reqId, empId, 'Income=' + income + ' Fine=' + fine);
  finalizeAdminMsg(cb, '✅ ' + adminId + ' @ ' + nowIso());
  send(empId, t(empId, 'income_approved', { income: fmtMoney(income), fine: fmtMoney(fine) }));
  ack(cb, t(adminId, 'btn_approve'));
}

function startRejectIncome(cb, reqId) {
  const adminId = String(cb.from.id);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const r = findRowById(SH.PEND, reqId);
    if (!r || r.values[5] !== 'PENDING') return ack(cb, t(adminId, 'already_processed'), true);
    sheet(SH.PEND).getRange(r.row, 6, 1, 2).setValues([['REJECTING', adminId]]);
  } finally { lock.releaseLock(); }
  setState(adminId, 'AWAIT_REJECT_INC', { reqId: reqId });
  finalizeAdminMsg(cb, '⏳ ' + adminId);
  send(adminId, t(adminId, 'ask_reject_reason') + '\n[' + reqId + ']');
  ack(cb);
}

function onIncomeRejectReason(adminId, chatId, reason, reqId) {
  if (!reason) return send(chatId, t(adminId, 'reason_empty'));
  clearState(adminId);
  const r = findRowById(SH.PEND, reqId);
  if (!r || r.values[5] !== 'REJECTING' || String(r.values[6]) !== adminId) {
    return send(chatId, t(adminId, 'no_longer_awaiting'), mainMenuKb(adminId));
  }
  const empId = String(r.values[1]);
  sheet(SH.PEND).getRange(r.row, 6, 1, 3).setValues([['REJECTED', adminId, nowIso()]]);
  appendRow(SH.REJ, [reqId, empId, r.values[2], r.values[3], r.values[4], nowIso(), adminId, reason]);
  audit(adminId, 'REJECT_INCOME', reqId, empId, 'Reason: ' + reason);
  send(empId, t(empId, 'income_rejected', { reason: reason }));
  send(chatId, t(adminId, 'rejection_recorded'), mainMenuKb(adminId));
}
