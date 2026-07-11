function startSalary(uid, chatId) {
  if (hasPendingSalary(uid)) return send(chatId, t(uid, 'salary_pending_exists'), mainMenuKb(uid));
  const total = calcTotal(uid);
  if (total <= 0) return send(chatId, t(uid, 'nothing_to_request', { total: fmtMoney(total) }), mainMenuKb(uid));

  send(chatId, t(uid, 'confirm_salary', { total: fmtMoney(total) }), { inline_keyboard: [[
    { text: t(uid, 'btn_confirm'), callback_data: 'sal_cfm' },
    { text: t(uid, 'btn_cancel'),  callback_data: 'sal_cxl' }
  ]] });
}

function hasPendingSalary(uid) {
  const data = sheet(SH.SREQ).getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][1]) === uid && (data[i][4] === 'PENDING' || data[i][4] === 'REJECTING')) return true;
  }
  return false;
}

function confirmSalary(cb) {
  const uid = String(cb.from.id);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let reqId, total;
  try {
    if (hasPendingSalary(uid)) return ack(cb, t(uid, 'salary_pending_exists'), true);
    total = calcTotal(uid);
    reqId = genId('SREQ');
    appendRow(SH.SREQ, [reqId, uid, total, nowIso(), 'PENDING', '', '', '']);
  } finally { lock.releaseLock(); }
  finalizeAdminMsg(cb, t(uid, 'salary_submitted'));
  const emp = findRowById(SH.EMP, uid);
  getAdminIds().forEach(function (adminId) {
    send(adminId, t(adminId, 'admin_new_salary', {
      name: emp.values[1], id: uid, total: fmtMoney(total), date: nowIso()
    }), { inline_keyboard: [[
      { text: t(adminId, 'btn_approve'), callback_data: 'sal_app:' + reqId },
      { text: t(adminId, 'btn_reject'),  callback_data: 'sal_rej:' + reqId }
    ]] });
  });
  ack(cb, t(uid, 'salary_submitted'));
}

function approveSalary(cb, reqId) {
  const adminId = String(cb.from.id);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let empId, finalAmount, periodStart, periodEnd;
  try {
    const r = findRowById(SH.SREQ, reqId);
    if (!r || r.values[4] !== 'PENDING') return ack(cb, t(adminId, 'already_processed'), true);
    empId = String(r.values[1]);
    const emp = findRowById(SH.EMP, empId);
    periodStart = String(emp.values[4]);
    periodEnd = nowIso();
    finalAmount = calcTotal(empId);

    sheet(SH.SREQ).getRange(r.row, 5, 1, 3).setValues([['APPROVED', adminId, periodEnd]]);
    appendRow(SH.SHIS, [genId('SAL'), empId, finalAmount, periodStart, periodEnd, periodEnd, adminId]);
    sheet(SH.EMP).getRange(emp.row, 5).setValue(periodEnd);
  } finally { lock.releaseLock(); }
  audit(adminId, 'APPROVE_SALARY', reqId, empId, 'Amount=' + finalAmount + ' Period=' + periodStart + '~' + periodEnd);
  finalizeAdminMsg(cb, '✅ ' + adminId + ' — ' + fmtMoney(finalAmount));
  send(empId, t(empId, 'salary_approved', {
    amount: fmtMoney(finalAmount), start: periodStart.substring(0, 10), end: periodEnd.substring(0, 10)
  }));
  ack(cb, t(adminId, 'btn_approve'));
}

function startRejectSalary(cb, reqId) {
  const adminId = String(cb.from.id);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const r = findRowById(SH.SREQ, reqId);
    if (!r || r.values[4] !== 'PENDING') return ack(cb, t(adminId, 'already_processed'), true);
    sheet(SH.SREQ).getRange(r.row, 5, 1, 2).setValues([['REJECTING', adminId]]);
  } finally { lock.releaseLock(); }
  setState(adminId, 'AWAIT_REJECT_SAL', { reqId: reqId });
  finalizeAdminMsg(cb, '⏳ ' + adminId);
  send(adminId, t(adminId, 'ask_reject_reason') + '\n[' + reqId + ']');
  ack(cb);
}

function onSalaryRejectReason(adminId, chatId, reason, reqId) {
  if (!reason) return send(chatId, t(adminId, 'reason_empty'));
  clearState(adminId);
  const r = findRowById(SH.SREQ, reqId);
  if (!r || r.values[4] !== 'REJECTING' || String(r.values[5]) !== adminId) {
    return send(chatId, t(adminId, 'no_longer_awaiting'), mainMenuKb(adminId));
  }
  const empId = String(r.values[1]);
  sheet(SH.SREQ).getRange(r.row, 5, 1, 4).setValues([['REJECTED', adminId, nowIso(), reason]]);
  audit(adminId, 'REJECT_SALARY', reqId, empId, 'Reason: ' + reason);
  send(empId, t(empId, 'salary_rejected', { reason: reason }));
  send(chatId, t(adminId, 'rejection_recorded'), mainMenuKb(adminId));
}
