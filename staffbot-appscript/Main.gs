function doPost(e) {
  try {
    if (!e || !e.parameter || e.parameter.token !== WEBHOOK_SECRET) {
      return ContentService.createTextOutput('forbidden');
    }
    const update = JSON.parse(e.postData.contents);
    if (isDuplicateUpdate(update.update_id)) return ContentService.createTextOutput('dup');

    if (update.callback_query) handleCallback(update.callback_query);
    else if (update.message) handleMessage(update.message);
    else if (update.edited_message) handleMessage(update.edited_message);
  } catch (err) {
    logError(err);
  }
  return ContentService.createTextOutput('OK');
}

function handleMessage(msg) {
  if (msg.chat.type !== 'private') return;
  const uid = String(msg.from.id);
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  debugLog('message uid=' + uid + ' text=' + text + ' state=' + JSON.stringify(getState(uid)));

  if (text === '/ping' || text === 'ping') {
    debugLog('ping matched uid=' + uid);
    return send(chatId, 'pong ' + nowIso());
  }

  if (text === '/reset' || text === 'reset' || text === '/cancel') {
    clearState(uid);
    debugLog('reset matched uid=' + uid);
    return send(chatId, '状态已重置。现在发送 income 开始测试。');
  }

  if (text === '/income' || text === 'income') {
    clearState(uid);
    debugLog('income command matched uid=' + uid);
    setState(uid, 'AWAIT_INCOME');
    return send(chatId, '请输入收入金额：');
  }

  if (text === '/total' || text === 'total') {
    ensureEmployee(msg.from);
    if (!hasLanguage(uid)) {
      setUserLang(uid, LANGS.ZH);
    }
    debugLog('total command matched uid=' + uid);
    return showTotal(uid, chatId);
  }

  const directState = getState(uid);
  if (directState && directState.s === 'AWAIT_INCOME') {
    const amt = parseAmount(text, false);
    debugLog('direct income amount uid=' + uid + ' text=' + text + ' parsed=' + amt);
    if (amt === null) {
      return send(chatId, '金额无效，请输入正数，例如 2000');
    }
    setState(uid, 'AWAIT_FINE', { income: amt });
    return send(chatId, '请输入罚款金额（如无填 0）：');
  }

  if (directState && directState.s === 'AWAIT_FINE') {
    const fine = parseAmount(text, true);
    debugLog('direct fine amount uid=' + uid + ' text=' + text + ' parsed=' + fine + ' data=' + JSON.stringify(directState.d));
    if (fine === null) {
      return send(chatId, '罚款金额无效，请输入 0 或正数。');
    }
    clearState(uid);
    ensureEmployee(msg.from);

    const income = Number(directState.d.income);
    const reqId = genId('INC');
    appendRow(SH.PEND, [reqId, uid, income, fine, nowIso(), 'PENDING', '', '']);
    debugLog('direct income submitted uid=' + uid + ' reqId=' + reqId + ' income=' + income + ' fine=' + fine);

    send(chatId, '✅ 已提交审核。\n收入：' + fmtMoney(income) + '\n罚款：' + fmtMoney(fine) + '\n审核后会通知您。', mainMenuKb(uid));

    const emp = findRowById(SH.EMP, uid);
    getAdminIds().forEach(function (adminId) {
      send(adminId, '📥 新的收入提交\n员工：' + emp.values[1] +
        '\nTelegram ID：' + uid +
        '\n收入：' + fmtMoney(income) +
        '\n罚款：' + fmtMoney(fine), { inline_keyboard: [[
          { text: '✅ 批准', callback_data: 'inc_app:' + reqId },
          { text: '❌ 驳回', callback_data: 'inc_rej:' + reqId }
        ]] });
    });
    return;
  }

  ensureEmployee(msg.from);

  // 首次使用:先选语言
  if (!hasLanguage(uid)) {
    return send(chatId, DICT.choose_lang.en + '\n' + DICT.choose_lang.zh, langSelectKb());
  }
  if (!isActiveEmployee(uid)) return send(chatId, t(uid, 'inactive'));

  if (msg.location) return onLocation(uid, chatId, msg.location);

  if (text === '/cancel' || text === t(uid, 'btn_cancel')) {
    clearState(uid);
    return send(chatId, t(uid, 'cancelled'), mainMenuKb(uid));
  }

  const st = getState(uid);
  if (st) {
    switch (st.s) {
      case 'AWAIT_INCOME':     return onIncomeAmount(uid, chatId, text);
      case 'AWAIT_FINE':       return onFineAmount(uid, chatId, text, st.d);
      case 'AWAIT_REJECT_INC': return onIncomeRejectReason(uid, chatId, text, st.d.reqId);
      case 'AWAIT_REJECT_SAL': return onSalaryRejectReason(uid, chatId, text, st.d.reqId);
    }
  }

  if (text === '/start' || text === 'start') {
    clearState(uid);
    return send(chatId, t(uid, 'welcome'), mainMenuKb(uid));
  }
  if (text === '/lang') {
    return send(chatId, DICT.choose_lang.en + '\n' + DICT.choose_lang.zh, langSelectKb());
  }
  if (matchesMenu(uid, text, 'btn_submit_income', ['/income', '提交收入', 'Submit Income', 'Nộp thu nhập'])) {
    return startIncome(uid, chatId);
  }
  if (matchesMenu(uid, text, 'btn_total_income', ['/total', '总收入', 'Total Income', 'Tổng thu nhập'])) {
    return showTotal(uid, chatId);
  }
  if (matchesMenu(uid, text, 'btn_request_salary', ['/salary', '申请工资', 'Request Salary', 'Yêu cầu lương'])) {
    return startSalary(uid, chatId);
  }
  if (matchesMenu(uid, text, 'btn_attendance', ['/attendance', '打卡', 'Attendance', 'Chấm công'])) {
    return startAttendance(uid, chatId);
  }

  return send(chatId, t(uid, 'use_menu'), mainMenuKb(uid));
}

function matchesMenu(uid, text, key, aliases) {
  const normalized = String(text || '').trim();
  if (normalized === t(uid, key)) return true;
  return aliases.indexOf(normalized) !== -1;
}

function debugLog(message) {
  try {
    appendRow(SH.ERR, [nowIso(), 'DEBUG ' + message]);
  } catch (e) {}
}

function handleCallback(cb) {
  const uid = String(cb.from.id);
  const parts = (cb.data || '').split(':');
  const action = parts[0];
  const id = parts[1] || '';

  if (action === 'lang') {
    setUserLang(uid, id);
    ack(cb, t(uid, 'lang_set'));
    send(cb.message.chat.id, t(uid, 'lang_set'));
    return send(cb.message.chat.id, t(uid, 'welcome'), mainMenuKb(uid));
  }

  const adminActions = ['inc_app', 'inc_rej', 'sal_app', 'sal_rej'];
  if (adminActions.indexOf(action) !== -1 && !isAdmin(uid)) {
    audit(uid, 'UNAUTHORIZED_ATTEMPT', id, '', 'callback: ' + cb.data);
    return ack(cb, t(uid, 'not_authorized'), true);
  }

  switch (action) {
    case 'inc_app': return approveIncome(cb, id);
    case 'inc_rej': return startRejectIncome(cb, id);
    case 'sal_app': return approveSalary(cb, id);
    case 'sal_rej': return startRejectSalary(cb, id);
    case 'sal_cfm': return confirmSalary(cb);
    case 'sal_cxl':
      ack(cb, t(uid, 'btn_cancel'));
      return finalizeAdminMsg(cb, t(uid, 'salary_cancelled'));
    case 'att_in':  return doCheckIn(cb);
    case 'att_out': return doCheckOut(cb);
    default: return ack(cb);
  }
}
