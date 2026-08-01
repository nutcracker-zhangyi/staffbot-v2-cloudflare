import {
  approveAbsenceFineRequest,
  approveCheckoutRequest,
  approveIncomeRequest,
  approveLeaveRequest,
  approveSalaryAdvanceRequest,
  approveSalaryRequest,
  hasAttendance,
  hasPendingCheckout,
  insertSystemFine,
  rejectAbsenceFineRequest,
  rejectCheckoutRequest,
  rejectIncomeRequest,
  rejectLeaveRequest,
  rejectSalaryAdvanceRequest,
  rejectSalaryRequest
} from './approvals.js';
import { audit, logError, logEvent, makeId, nowIso, safeJson } from './audit.js';
import { DEFAULT_STORE_ID } from './constants.js';
import {
  getBusinessDate,
  leaveDateOptions,
  leaveMonthRange,
  leaveRuleParams,
  localTime,
  minutesOf,
  validateLeaveDate,
  zonedMidnightIso
} from './dates.js';
import { LANGS, allLangLabels, render, t } from './i18n.js';
import {
  attendanceFineAmount,
  calculateCommissionIncome,
  formatMoney,
  formatPercent,
  isVndStore,
  parseStoreAmount
} from './money.js';
import { getMemberCommissionRate, getTotalIncome } from './payroll.js';
import {
  payrollStartDateOptions,
  validatePayrollStartDate
} from './payroll-cycle.js';
import {
  confirmPayrollReceipt,
  disputePayrollPayment,
  getPayrollPaymentContext,
  maskPaymentValue,
  paymentMethodKeyboard,
  savePaymentSplit,
  savePaymentProfile,
  usdtDetailModeKeyboard
} from './payroll-payments.js';
import { saveTelegramPaymentQr } from './payroll-payment-qr.js';
import {
  payrollReceiptMessage,
  sendPayrollForEmployeeConfirmation
} from './payroll-notifications.js';
import {
  completePayrollProofs,
  storeTelegramProof
} from './payroll-proofs.js';
import { adminIds, isGlobalAdmin } from './security.js';
import {
  getMemberDisplayName,
  getStore,
  getStoreForMember,
  isStoreAdmin,
  listActiveStores,
  listMemberStores,
  resolveStoreForUser,
  setCurrentStore
} from './stores.js';
import {
  answerCallback,
  editCallbackMessage,
  sendMessage,
  sendPhoto
} from './telegram-client.js';

export async function handleUpdate(update, env) {
  try {
    if (update.message) return handleMessage(update.message, env);
    if (update.callback_query) return handleCallback(update.callback_query, env);
  } catch (error) {
    await logError(env, 'handle_update_error', error, update);
  }
}

async function handleMessage(message, env) {
  if (!message.chat || message.chat.type !== 'private') return;

  const chatId = String(message.chat.id);
  const userId = String(message.from.id);
  const text = (message.text || '').trim();

  await upsertUser(env, message.from);
  const lang = await getUserLang(env, userId);
  const normalized = text.toLowerCase();
  const state = await getState(env, userId);
  const storeResolution = await resolveStoreForUser(env, userId, state && state.data && state.data.store_id);
  const store = storeResolution.store;

  await logEvent(env, 'debug', 'message_received', { store_id: store ? store.store_id : DEFAULT_STORE_ID, telegram_id: userId, text });

  if (normalized === '/ping' || normalized === 'ping') {
    return sendMessage(env, chatId, `pong ${nowIso()}`);
  }

  if (normalized === '/cancel' || normalized === 'cancel' || text === t(lang, 'btn_cancel')) {
    await clearState(env, userId);
    return sendMessage(env, chatId, t(lang, 'cancelled'), mainMenu(lang));
  }

  if (normalized.startsWith('/start') || normalized === 'start') {
    await clearState(env, userId);
    const inviteCode = text.split(/\s+/)[1];
    if (inviteCode) {
      const invitedStore = await acceptInvite(env, userId, inviteCode);
      if (invitedStore) {
        return sendMessage(env, chatId, `${render(lang, 'joined_store', { store: invitedStore.name })}\n\n${t(lang, 'welcome')}\n\n${t(lang, 'help')}`, mainMenu(lang));
      }
    }
    if (!store) {
      return sendRegistrationStoreChooser(env, chatId, lang);
    }
    return sendMessage(env, chatId, `${t(lang, 'welcome')}\n\n${t(lang, 'help')}`, mainMenu(lang));
  }

  if (normalized === '/lang' || normalized === 'lang') {
    return sendMessage(env, chatId, t(lang, 'choose_lang'), languageKeyboard());
  }

  if (isStoreCommand(text, lang)) {
    return sendStoreChooser(env, userId, chatId, lang);
  }

  if (state && state.state === 'WAIT_REGISTER_NAME') {
    return finishRegistrationRequest(env, userId, chatId, state.data.store_id, text, lang);
  }
  if (state && state.state === 'WAIT_PAYROLL_BANK_DETAILS') {
    return finishPayrollBankDetails(
      env,
      userId,
      chatId,
      state.data,
      text,
      lang
    );
  }
  if (state && state.state === 'WAIT_PAYROLL_USDT_DETAILS') {
    return finishPayrollUsdtDetails(
      env,
      userId,
      chatId,
      state.data,
      text,
      lang
    );
  }
  if (state && state.state === 'WAIT_PAYROLL_USDT_QR') {
    if (message.photo) {
      return finishPayrollUsdtQr(
        env,
        userId,
        chatId,
        state.data,
        message.photo,
        lang
      );
    }
    return sendMessage(env, chatId, t(lang, 'payroll_ask_usdt_qr'));
  }
  if (state && state.state === 'WAIT_PAYROLL_SPLIT') {
    return finishPayrollSplitAmount(
      env,
      userId,
      chatId,
      state.data,
      text,
      lang
    );
  }
  if (state && state.state === 'WAIT_PAYROLL_PROOF') {
    if (message.photo) {
      return receivePayrollProofPhoto(
        env,
        userId,
        chatId,
        state.data,
        message.photo,
        lang
      );
    }
    return sendMessage(
      env,
      chatId,
      t(lang, 'payroll_proof_upload_prompt'),
      payrollProofKeyboard(state.data, lang)
    );
  }

  if (state && state.state === 'WAIT_INCOME_AMOUNT') {
    const stateStore = await getStoreForMember(env, state.data.store_id, userId);
    if (!stateStore) return sendMessage(env, chatId, t(lang, 'no_store'));
    return handleIncomeAmount(text, userId, chatId, env, lang, stateStore);
  }
  if (state && state.state === 'WAIT_INCOME_FINE') {
    const stateStore = await getStoreForMember(env, state.data.store_id, userId);
    if (!stateStore) return sendMessage(env, chatId, t(lang, 'no_store'));
    return handleIncomeFine(text, userId, chatId, state.data, env, lang, stateStore);
  }
  if (state && state.state === 'WAIT_INCOME_REJECT_REASON') {
    return finishIncomeReject(env, userId, chatId, state.data.store_id, state.data.request_id, text, lang);
  }
  if (state && state.state === 'WAIT_SALARY_REJECT_REASON') {
    return finishSalaryReject(env, userId, chatId, state.data.store_id, state.data.request_id, text, lang);
  }
  if (state && state.state === 'WAIT_ADVANCE_AMOUNT') {
    const stateStore = await getStoreForMember(env, state.data.store_id, userId);
    if (!stateStore) return sendMessage(env, chatId, t(lang, 'no_store'));
    return handleSalaryAdvanceAmount(env, stateStore, userId, chatId, text, lang);
  }
  if (state && state.state === 'WAIT_ADVANCE_REJECT_REASON') {
    return finishSalaryAdvanceReject(env, userId, chatId, state.data.store_id, state.data.request_id, text, lang);
  }
  if (state && state.state === 'WAIT_LEAVE_DATE') {
    const stateStore = await getStoreForMember(env, state.data.store_id, userId);
    if (!stateStore) return sendMessage(env, chatId, t(lang, 'no_store'));
    return handleLeaveDate(env, stateStore, userId, chatId, text, lang);
  }
  if (state && state.state === 'WAIT_LEAVE_REJECT_REASON') {
    return finishLeaveReject(env, userId, chatId, state.data.store_id, state.data.request_id, text, lang);
  }
  if (state && state.state === 'WAIT_CHECKOUT_REJECT_REASON') {
    return finishCheckoutReject(env, userId, chatId, state.data.store_id, state.data.request_id, text, lang);
  }

  if (!store) {
    if (storeResolution.needsChoice) {
      await sendMessage(env, chatId, t(lang, 'need_store_choice'));
      return sendStoreChooser(env, userId, chatId, lang);
    }
    return sendRegistrationStoreChooser(env, chatId, lang);
  }

  if (isIncomeCommand(text, lang)) {
    await setState(env, userId, 'WAIT_INCOME_AMOUNT', { store_id: store.store_id });
    return sendMessage(env, chatId, `${render(lang, 'current_store', { store: store.name })}\n${amountPrompt(lang, store, 'income')}`);
  }

  if (isTotalCommand(text, lang)) {
    const total = await getTotalIncome(env, store.store_id, userId);
    return sendMessage(env, chatId, render(lang, 'total', { store: store.name, total: formatMoney(store, total) }), mainMenu(lang));
  }

  if (isSalaryCommand(text, lang)) {
    return startSalary(env, store, userId, chatId, lang);
  }

  if (isSalaryAdvanceCommand(text, lang)) {
    return startSalaryAdvance(env, store, userId, chatId, lang);
  }

  if (isAttendanceCommand(text, lang)) {
    return startAttendance(env, store, userId, chatId, lang);
  }

  if (isLeaveCommand(text, lang)) {
    return startLeave(env, store, userId, chatId, lang);
  }

  if (message.location) {
    return handleLocation(env, store, userId, chatId, message.location, lang);
  }

  return sendMessage(env, chatId, t(lang, 'unknown'), mainMenu(lang));
}

async function handleCallback(callback, env) {
  const userId = String(callback.from.id);
  const lang = await getUserLang(env, userId);
  const data = callback.data || '';
  const parts = data.split(':');

  if (parts[0] === 'lang') {
    const langCode = LANGS.includes(parts[1]) ? parts[1] : 'zh';
    await setUserLang(env, userId, langCode);
    await answerCallback(env, callback.id, t(langCode, 'lang_set'));
    return sendMessage(env, callback.message.chat.id, t(langCode, 'welcome'), mainMenu(langCode));
  }

  if (parts[0] === 'store' && parts[1] === 'set') {
    const storeId = parts[2] || '';
    const store = await getStoreForMember(env, storeId, userId);
    if (!store) return answerCallback(env, callback.id, t(lang, 'no_permission'), true);
    await setCurrentStore(env, userId, store.store_id);
    await answerCallback(env, callback.id, render(lang, 'store_set', { store: store.name }));
    return sendMessage(env, callback.message.chat.id, render(lang, 'store_set', { store: store.name }), mainMenu(lang));
  }

  if (parts[0] === 'reg') {
    if (parts[1] === 'store') {
      const store = await getStore(env, parts[2] || DEFAULT_STORE_ID);
      if (!store || store.status !== 'active') return answerCallback(env, callback.id, t(lang, 'no_store'), true);
      await setState(env, userId, 'WAIT_REGISTER_NAME', { store_id: store.store_id });
      await answerCallback(env, callback.id);
      return sendMessage(env, callback.message.chat.id, `${render(lang, 'current_store', { store: store.name })}\n${t(lang, 'ask_register_name')}`);
    }
    if (parts[1] === 'paydate') {
      const store = await getStore(env, parts[2] || DEFAULT_STORE_ID);
      const selectedDate = parts[3] || '';
      const state = await getState(env, userId);
      if (!store
        || store.status !== 'active'
        || !state
        || state.state !== 'WAIT_REGISTER_PAYROLL_DATE'
        || state.data.store_id !== store.store_id) {
        return answerCallback(env, callback.id, t(lang, 'invalid_payroll_start_date'), true);
      }
      const validation = validatePayrollStartDate(store, selectedDate);
      if (!validation.ok) {
        return answerCallback(env, callback.id, t(lang, 'invalid_payroll_start_date'), true);
      }
      return finishRegistrationWithPayrollDate(
        env,
        callback,
        userId,
        store,
        state.data.display_name,
        validation.date,
        lang
      );
    }
    const storeId = parts[2] || DEFAULT_STORE_ID;
    const employeeId = parts[3] || '';
    if (!(await isStoreAdmin(env, userId, storeId))) {
      await audit(env, storeId, userId, 'unauthorized_registration_callback', data, {});
      return answerCallback(env, callback.id, t(lang, 'no_permission'), true);
    }
    if (parts[1] === 'approve') return approveRegistration(env, callback, userId, storeId, employeeId, lang);
    if (parts[1] === 'reject') return rejectRegistration(env, callback, userId, storeId, employeeId, lang);
  }

  if (parts[0] === 'pok' || parts[0] === 'px') {
    const attemptId = parts.slice(1).join(':');
    const target = await employeePaymentAttemptTarget(
      env,
      userId,
      attemptId
    );
    if (!target) {
      return answerCallback(
        env,
        callback.id,
        t(lang, 'payroll_payment_version_stale'),
        true
      );
    }
    if (parts[0] === 'pok') {
      return confirmEmployeePayrollReceipt(
        env,
        callback,
        userId,
        target.payroll_id,
        lang,
        target.attempt_id
      );
    }
    return disputeEmployeePayrollPayment(
      env,
      callback,
      userId,
      target.payroll_id,
      lang,
      target.attempt_id
    );
  }

  if (parts[0] === 'pay') {
    if (parts[1] === 'd') {
      return startPayrollPaymentDetails(
        env,
        callback,
        userId,
        parts.slice(2).join(':'),
        lang
      );
    }
    if (parts[1] === 'm') {
      return togglePayrollPaymentMethod(
        env,
        callback,
        userId,
        parts[2],
        parts.slice(3).join(':'),
        lang
      );
    }
    if (parts[1] === 'um') {
      return selectPayrollUsdtMode(
        env,
        callback,
        userId,
        parts[2],
        parts.slice(3).join(':'),
        lang
      );
    }
    if (parts[1] === 'c') {
      return confirmPayrollPaymentMethods(
        env,
        callback,
        userId,
        parts.slice(2).join(':'),
        lang
      );
    }
    if (parts[1] === 'a') {
      return startAdminPayrollPayment(
        env,
        callback,
        userId,
        parts.slice(2).join(':'),
        lang
      );
    }
    if (parts[1] === 'ps') {
      return selectPayrollProofMethod(
        env,
        callback,
        userId,
        parts[2],
        parts.slice(3).join(':'),
        lang
      );
    }
    if (parts[1] === 'pc') {
      return finishPayrollProofUpload(
        env,
        callback,
        userId,
        parts.slice(2).join(':'),
        lang
      );
    }
    if (parts[1] === 'ok') {
      const target = await legacyEmployeePaymentTarget(
        env,
        userId,
        parts.slice(2).join(':')
      );
      if (!target) {
        return answerCallback(
          env,
          callback.id,
          t(lang, 'payroll_payment_version_stale'),
          true
        );
      }
      return confirmEmployeePayrollReceipt(
        env,
        callback,
        userId,
        target.payroll_id,
        lang,
        target.attempt_id
      );
    }
    if (parts[1] === 'x') {
      const target = await legacyEmployeePaymentTarget(
        env,
        userId,
        parts.slice(2).join(':')
      );
      if (!target) {
        return answerCallback(
          env,
          callback.id,
          t(lang, 'payroll_payment_version_stale'),
          true
        );
      }
      return disputeEmployeePayrollPayment(
        env,
        callback,
        userId,
        target.payroll_id,
        lang,
        target.attempt_id
      );
    }
  }

  if (parts[0] === 'income') {
    const storeId = parts.length >= 4 ? parts[2] : DEFAULT_STORE_ID;
    const requestId = parts.length >= 4 ? parts[3] : parts[2];
    if (!(await isStoreAdmin(env, userId, storeId))) {
      await audit(env, storeId, userId, 'unauthorized_income_callback', data, {});
      return answerCallback(env, callback.id, t(lang, 'no_permission'), true);
    }
    if (parts[1] === 'approve') return approveIncome(env, callback, userId, storeId, requestId, lang);
    if (parts[1] === 'reject') return startIncomeReject(env, callback, userId, storeId, requestId, lang);
  }

  if (parts[0] === 'salary') {
    if (parts[1] === 'confirm') {
      const storeId = parts[2] || DEFAULT_STORE_ID;
      const store = await getStore(env, storeId);
      return confirmSalary(env, callback, store, userId, lang);
    }
    if (parts[1] === 'cancel') {
      await editCallbackMessage(env, callback, `${callback.message.text}\n\n${t(lang, 'cancelled')}`);
      return answerCallback(env, callback.id, t(lang, 'cancelled'));
    }
    const storeId = parts.length >= 4 ? parts[2] : DEFAULT_STORE_ID;
    const requestId = parts.length >= 4 ? parts[3] : parts[2];
    if (!(await isStoreAdmin(env, userId, storeId))) {
      await audit(env, storeId, userId, 'unauthorized_salary_callback', data, {});
      return answerCallback(env, callback.id, t(lang, 'no_permission'), true);
    }
    if (parts[1] === 'approve') return approveSalary(env, callback, userId, storeId, requestId, lang);
    if (parts[1] === 'reject') return startSalaryReject(env, callback, userId, storeId, requestId, lang);
  }

  if (parts[0] === 'sal') {
    const storeId = parts[2] || DEFAULT_STORE_ID;
    const requestId = parts[3] || '';
    if (!(await isStoreAdmin(env, userId, storeId))) {
      await audit(env, storeId, userId, 'unauthorized_salary_callback', data, {});
      return answerCallback(env, callback.id, t(lang, 'no_permission'), true);
    }
    if (parts[1] === 'a') return approveSalary(env, callback, userId, storeId, requestId, lang);
    if (parts[1] === 'r') return startSalaryReject(env, callback, userId, storeId, requestId, lang);
  }

  if (parts[0] === 'advance') {
    const storeId = parts[2] || DEFAULT_STORE_ID;
    const requestId = parts[3] || '';
    if (!(await isStoreAdmin(env, userId, storeId))) {
      await audit(env, storeId, userId, 'unauthorized_advance_callback', data, {});
      return answerCallback(env, callback.id, t(lang, 'no_permission'), true);
    }
    if (parts[1] === 'approve') return approveSalaryAdvance(env, callback, userId, storeId, requestId, lang);
    if (parts[1] === 'reject') return startSalaryAdvanceReject(env, callback, userId, storeId, requestId, lang);
  }

  if (parts[0] === 'adv') {
    const storeId = parts[2] || DEFAULT_STORE_ID;
    const requestId = parts[3] || '';
    if (!(await isStoreAdmin(env, userId, storeId))) {
      await audit(env, storeId, userId, 'unauthorized_advance_callback', data, {});
      return answerCallback(env, callback.id, t(lang, 'no_permission'), true);
    }
    if (parts[1] === 'a') return approveSalaryAdvance(env, callback, userId, storeId, requestId, lang);
    if (parts[1] === 'r') return startSalaryAdvanceReject(env, callback, userId, storeId, requestId, lang);
  }

  if (parts[0] === 'att') {
    const storeId = parts[2] || DEFAULT_STORE_ID;
    const store = await getStore(env, storeId);
    if (parts[1] === 'in') return doCheckIn(env, callback, store, userId, lang);
    if (parts[1] === 'out') return doCheckOut(env, callback, store, userId, lang);
    if (!(await isStoreAdmin(env, userId, storeId))) {
      await audit(env, storeId, userId, 'unauthorized_attendance_callback', data, {});
      return answerCallback(env, callback.id, t(lang, 'no_permission'), true);
    }
    const requestId = parts[3] || '';
    if (parts[1] === 'approve' || parts[1] === 'approve_fine' || parts[1] === 'af') return approveCheckout(env, callback, userId, storeId, requestId, lang, true);
    if (parts[1] === 'approve_no_fine' || parts[1] === 'anf') return approveCheckout(env, callback, userId, storeId, requestId, lang, false);
    if (parts[1] === 'reject') return startCheckoutReject(env, callback, userId, storeId, requestId, lang);
  }

  if (parts[0] === 'leave') {
    if (parts[1] === 'date') {
      const storeId = parts[2] || DEFAULT_STORE_ID;
      const leaveDate = parts[3] || '';
      const store = await getStoreForMember(env, storeId, userId);
      if (!store) return answerCallback(env, callback.id, t(lang, 'no_permission'), true);
      const result = await submitLeaveRequest(env, store, userId, leaveDate, lang);
      if (!result.ok) return answerCallback(env, callback.id, t(lang, result.error), true);
      await editCallbackMessage(env, callback, render(lang, 'leave_submitted', { date: result.date }));
      return answerCallback(env, callback.id, t(lang, 'leave_submitted').split('\n')[0]);
    }
    const storeId = parts.length >= 4 ? parts[2] : DEFAULT_STORE_ID;
    const requestId = parts.length >= 4 ? parts[3] : parts[2];
    if (!(await isStoreAdmin(env, userId, storeId))) {
      await audit(env, storeId, userId, 'unauthorized_leave_callback', data, {});
      return answerCallback(env, callback.id, t(lang, 'no_permission'), true);
    }
    if (parts[1] === 'approve') return approveLeave(env, callback, userId, storeId, requestId, lang);
    if (parts[1] === 'reject') return startLeaveReject(env, callback, userId, storeId, requestId, lang);
  }

  if (parts[0] === 'abs') {
    const requestId = parts[2] || '';
    const request = await env.DB.prepare(
      `SELECT * FROM absence_fine_requests WHERE request_id = ?`
    ).bind(requestId).first();
    if (!request || !(await isStoreAdmin(env, userId, request.store_id))) {
      await audit(env, request ? request.store_id : DEFAULT_STORE_ID, userId, 'unauthorized_absence_callback', data, {});
      return answerCallback(env, callback.id, t(lang, 'no_permission'), true);
    }
    if (parts[1] === 'a') return approveAbsenceFine(env, callback, userId, request, lang);
    if (parts[1] === 'r') return rejectAbsenceFine(env, callback, userId, request, lang);
  }

  return answerCallback(env, callback.id);
}

async function handleIncomeAmount(text, userId, chatId, env, lang, store) {
  const income = parseStoreAmount(store, text, false);
  if (income === null) return sendMessage(env, chatId, t(lang, 'invalid_income'));
  return submitIncome({ income, fine: 0 }, userId, chatId, env, lang, store);
}

async function handleIncomeFine(text, userId, chatId, data, env, lang, store) {
  const fine = parseStoreAmount(store, text, true);
  if (fine === null) return sendMessage(env, chatId, t(lang, 'invalid_fine'));
  return submitIncome({ income: Number(data.income), fine }, userId, chatId, env, lang, store);
}

async function submitIncome(data, userId, chatId, env, lang, store) {
  const income = Number(data.income);
  const fine = Number(data.fine || 0);
  const commissionRate = await getMemberCommissionRate(env, store.store_id, userId);
  const commissionIncome = calculateCommissionIncome(income, commissionRate);
  const requestId = makeId('INC');
  const submittedAt = nowIso();

  await env.DB.prepare(`
    INSERT INTO pending_income
      (request_id, store_id, telegram_id, income, commission_rate, commission_income, fine, status, submitted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).bind(requestId, store.store_id, userId, income, commissionRate, commissionIncome, fine, submittedAt).run();

  await clearState(env, userId);
  await logEvent(env, 'info', 'income_submitted', { store_id: store.store_id, request_id: requestId, telegram_id: userId, income, fine });

  await sendMessage(env, chatId, render(lang, 'income_submitted', {
    store: store.name,
    income: formatMoney(store, income),
    commission: formatPercent(commissionRate),
    commission_income: formatMoney(store, commissionIncome),
    fine: formatMoney(store, fine)
  }), mainMenu(lang));

  const employeeName = await getMemberDisplayName(env, store.store_id, userId);
  await notifyStoreAdmins(env, store.store_id, incomeAdminNotificationText({
    storeName: store.name,
    employeeName,
    userId,
    income: formatMoney(store, income),
    commission: formatPercent(commissionRate),
    commissionIncome: formatMoney(store, commissionIncome),
    requestId
  }), {
    inline_keyboard: [[
      { text: t('zh', 'btn_approve'), callback_data: `income:approve:${store.store_id}:${requestId}` },
      { text: t('zh', 'btn_reject'), callback_data: `income:reject:${store.store_id}:${requestId}` }
    ]]
  });
}

async function approveIncome(env, callback, adminId, storeId, requestId, lang) {
  const result = await approveIncomeRequest(env, storeId, requestId, adminId);
  if (!result.ok) return answerCallback(env, callback.id, t(lang, 'already_processed'), true);
  const empLang = await getUserLang(env, result.row.telegram_id);
  await sendMessage(env, result.row.telegram_id, render(empLang, 'income_approved', {
    income: formatMoney(result.store, result.row.income),
    commission: formatPercent(result.row.commission_rate),
    commission_income: formatMoney(result.store, result.row.commission_income),
    fine: formatMoney(result.store, result.row.fine)
  }));
  await editCallbackMessage(env, callback, `${callback.message.text}\n\n已批准 by ${adminId}`);
  return answerCallback(env, callback.id, '已批准。');
}

async function startIncomeReject(env, callback, adminId, storeId, requestId, lang) {
  const found = await env.DB.prepare(`SELECT * FROM pending_income WHERE store_id = ? AND request_id = ?`).bind(storeId, requestId).first();
  if (!found || found.status !== 'pending') return answerCallback(env, callback.id, t(lang, 'already_processed'), true);

  await setState(env, adminId, 'WAIT_INCOME_REJECT_REASON', { store_id: storeId, request_id: requestId });
  await editCallbackMessage(env, callback, `${callback.message.text}\n\n等待 ${adminId} 输入驳回原因`);
  await sendMessage(env, adminId, `${t(lang, 'ask_reject_reason')}\n${requestId}`);
  return answerCallback(env, callback.id);
}

async function finishIncomeReject(env, adminId, chatId, storeId, requestId, reason, lang) {
  const result = await rejectIncomeRequest(env, storeId, requestId, adminId, reason || 'Rejected by admin');
  await clearState(env, adminId);
  if (!result.ok) return sendMessage(env, chatId, t(lang, 'already_processed'), mainMenu(lang));
  const empLang = await getUserLang(env, result.row.telegram_id);
  await sendMessage(env, result.row.telegram_id, render(empLang, 'income_rejected', { reason: result.reason }));
  return sendMessage(env, chatId, t(lang, 'reject_recorded'), mainMenu(lang));
}

async function startSalary(env, store, userId, chatId, lang) {
  return sendMessage(
    env,
    chatId,
    t(lang, 'salary_automatic_explanation'),
    mainMenu(lang)
  );
}

async function confirmSalary(env, callback, store, userId, lang) {
  if (!store) return answerCallback(env, callback.id, t(lang, 'no_store'), true);
  await editCallbackMessage(
    env,
    callback,
    t(lang, 'salary_automatic_explanation')
  );
  return answerCallback(
    env,
    callback.id,
    t(lang, 'salary_automatic_explanation'),
    true
  );
}

async function approveSalary(env, callback, adminId, storeId, requestId, lang) {
  const result = await approveSalaryRequest(env, storeId, requestId, adminId);
  if (!result.ok) return answerCallback(env, callback.id, t(lang, 'already_processed'), true);
  const empLang = await getUserLang(env, result.row.telegram_id);
  await sendMessage(env, result.row.telegram_id, render(empLang, 'salary_approved', {
    amount: formatMoney(result.store, result.amount),
    start: result.periodStart.substring(0, 10),
    end: result.periodEnd.substring(0, 10)
  }));
  await editCallbackMessage(env, callback, `${callback.message.text}\n\n已批准 by ${adminId}`);
  return answerCallback(env, callback.id, '已批准。');
}

async function startSalaryReject(env, callback, adminId, storeId, requestId, lang) {
  const found = await env.DB.prepare(`SELECT * FROM salary_requests WHERE store_id = ? AND request_id = ?`).bind(storeId, requestId).first();
  if (!found || found.status !== 'pending') return answerCallback(env, callback.id, t(lang, 'already_processed'), true);

  await setState(env, adminId, 'WAIT_SALARY_REJECT_REASON', { store_id: storeId, request_id: requestId });
  await editCallbackMessage(env, callback, `${callback.message.text}\n\n等待 ${adminId} 输入驳回原因`);
  await sendMessage(env, adminId, `${t(lang, 'ask_reject_reason')}\n${requestId}`);
  return answerCallback(env, callback.id);
}

async function finishSalaryReject(env, adminId, chatId, storeId, requestId, reason, lang) {
  const result = await rejectSalaryRequest(env, storeId, requestId, adminId, reason || 'Rejected by admin');
  await clearState(env, adminId);
  if (!result.ok) return sendMessage(env, chatId, t(lang, 'already_processed'), mainMenu(lang));
  const empLang = await getUserLang(env, result.row.telegram_id);
  await sendMessage(env, result.row.telegram_id, render(empLang, 'salary_rejected', { reason: result.reason }));
  return sendMessage(env, chatId, t(lang, 'reject_recorded'), mainMenu(lang));
}

async function startSalaryAdvance(env, store, userId, chatId, lang) {
  const pending = await env.DB.prepare(`
    SELECT request_id FROM salary_advance_requests WHERE store_id = ? AND telegram_id = ? AND status = 'pending'
  `).bind(store.store_id, userId).first();
  if (pending) return sendMessage(env, chatId, t(lang, 'advance_pending'), mainMenu(lang));

  const total = await getTotalIncome(env, store.store_id, userId);
  if (total <= 0) return sendMessage(env, chatId, render(lang, 'no_salary', { total: formatMoney(store, total) }), mainMenu(lang));

  await setState(env, userId, 'WAIT_ADVANCE_AMOUNT', { store_id: store.store_id });
  return sendMessage(env, chatId, [
    render(lang, 'current_store', { store: store.name }),
    render(lang, 'salary_confirm', {
      store: store.name,
      total: formatMoney(store, total),
      commission: formatPercent(await getMemberCommissionRate(env, store.store_id, userId)),
      amount: formatMoney(store, total)
    }),
    amountPrompt(lang, store, 'advance')
  ].join('\n\n'));
}

async function handleSalaryAdvanceAmount(env, store, userId, chatId, text, lang) {
  const amount = parseStoreAmount(store, text, false);
  if (amount === null) return sendMessage(env, chatId, t(lang, 'invalid_advance'));

  const total = await getTotalIncome(env, store.store_id, userId);
  if (amount > total) {
    return sendMessage(env, chatId, render(lang, 'advance_exceeds_salary', { amount: formatMoney(store, total) }), mainMenu(lang));
  }
  const pending = await env.DB.prepare(`
    SELECT request_id FROM salary_advance_requests WHERE store_id = ? AND telegram_id = ? AND status = 'pending'
  `).bind(store.store_id, userId).first();
  if (pending) return sendMessage(env, chatId, t(lang, 'advance_pending'), mainMenu(lang));

  const requestId = makeId('ADV');
  const requestedAt = nowIso();
  await env.DB.prepare(`
    INSERT INTO salary_advance_requests
      (request_id, store_id, telegram_id, amount, status, requested_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).bind(requestId, store.store_id, userId, amount, requestedAt).run();

  await clearState(env, userId);
  await sendMessage(env, chatId, render(lang, 'advance_submitted', { amount: formatMoney(store, amount) }), mainMenu(lang));

  const employeeName = await getMemberDisplayName(env, store.store_id, userId);
  await notifyStoreAdmins(env, store.store_id, [
    '新的预支薪资申请',
    `店铺：${store.name}`,
    `员工：${employeeName}`,
    `员工 ID：${userId}`,
    `当前可申请工资：${formatMoney(store, total)}`,
    `预支金额：${formatMoney(store, amount)}`,
    `请求 ID：${requestId}`
  ].join('\n'), {
    inline_keyboard: [[
      { text: t('zh', 'btn_approve'), callback_data: compactCallbackData('adv', 'a', store.store_id, requestId) },
      { text: t('zh', 'btn_reject'), callback_data: compactCallbackData('adv', 'r', store.store_id, requestId) }
    ]]
  });
}

async function approveSalaryAdvance(env, callback, adminId, storeId, requestId, lang) {
  const result = await approveSalaryAdvanceRequest(env, storeId, requestId, adminId);
  if (!result.ok && result.error === 'amount_exceeds_salary') {
    return answerCallback(env, callback.id, render(lang, 'advance_exceeds_salary', { amount: formatMoney(result.store, result.total || 0) }), true);
  }
  if (!result.ok) return answerCallback(env, callback.id, t(lang, 'already_processed'), true);
  const empLang = await getUserLang(env, result.row.telegram_id);
  await sendMessage(env, result.row.telegram_id, render(empLang, 'advance_approved', {
    amount: formatMoney(result.store, result.row.amount)
  }));
  await editCallbackMessage(env, callback, `${callback.message.text}\n\n已批准 by ${adminId}`);
  return answerCallback(env, callback.id, '已批准。');
}

async function startSalaryAdvanceReject(env, callback, adminId, storeId, requestId, lang) {
  const found = await env.DB.prepare(`SELECT * FROM salary_advance_requests WHERE store_id = ? AND request_id = ?`).bind(storeId, requestId).first();
  if (!found || found.status !== 'pending') return answerCallback(env, callback.id, t(lang, 'already_processed'), true);

  await setState(env, adminId, 'WAIT_ADVANCE_REJECT_REASON', { store_id: storeId, request_id: requestId });
  await editCallbackMessage(env, callback, `${callback.message.text}\n\n等待 ${adminId} 输入驳回原因`);
  await sendMessage(env, adminId, `${t(lang, 'ask_reject_reason')}\n${requestId}`);
  return answerCallback(env, callback.id);
}

async function finishSalaryAdvanceReject(env, adminId, chatId, storeId, requestId, reason, lang) {
  const result = await rejectSalaryAdvanceRequest(env, storeId, requestId, adminId, reason || 'Rejected by admin');
  await clearState(env, adminId);
  if (!result.ok) return sendMessage(env, chatId, t(lang, 'already_processed'), mainMenu(lang));
  const empLang = await getUserLang(env, result.row.telegram_id);
  await sendMessage(env, result.row.telegram_id, render(empLang, 'advance_rejected', { reason: result.reason }));
  return sendMessage(env, chatId, t(lang, 'reject_recorded'), mainMenu(lang));
}

async function startLeave(env, store, userId, chatId, lang) {
  await setState(env, userId, 'WAIT_LEAVE_DATE', { store_id: store.store_id });
  return sendMessage(env, chatId, `${render(lang, 'current_store', { store: store.name })}\n${leaveRulePrompt(lang, store)}`, leaveDateKeyboard(store));
}

async function handleLeaveDate(env, store, userId, chatId, text, lang) {
  const result = await submitLeaveRequest(env, store, userId, text, lang);
  if (!result.ok) {
    if (result.error === 'invalid_leave_date') return sendMessage(env, chatId, render(lang, 'invalid_leave_date', leaveRuleParams(store)), mainMenu(lang));
    if (result.error === 'leave_month_limit') return sendMessage(env, chatId, render(lang, 'leave_month_limit', { limit: Number(store.leave_monthly_limit || 4) }), mainMenu(lang));
    return sendMessage(env, chatId, t(lang, result.error), mainMenu(lang));
  }
  return sendMessage(env, chatId, render(lang, 'leave_submitted', { date: result.date }), mainMenu(lang));
}

async function submitLeaveRequest(env, store, userId, value, lang) {
  const validation = validateLeaveDate(store, value);
  if (!validation.ok) return { ok: false, error: 'invalid_leave_date' };

  const conflict = await leaveDateOccupied(env, store.store_id, validation.date, store.leave_daily_limit);
  if (conflict) return { ok: false, error: 'leave_conflict' };

  const monthCount = await leaveMonthCount(env, store.store_id, userId, validation.date);
  if (monthCount >= Number(store.leave_monthly_limit || 4)) return { ok: false, error: 'leave_month_limit' };

  const requestId = makeId('LEAVE');
  const requestedAt = nowIso();
  await env.DB.prepare(`
    INSERT INTO leave_requests
      (request_id, store_id, telegram_id, leave_date, status, requested_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).bind(requestId, store.store_id, userId, validation.date, requestedAt).run();

  await clearState(env, userId);
  await logEvent(env, 'info', 'leave_submitted', { store_id: store.store_id, request_id: requestId, telegram_id: userId, leave_date: validation.date });

  const employeeName = await getMemberDisplayName(env, store.store_id, userId);
  await notifyStoreAdmins(env, store.store_id, [
    '新的请假申请',
    `店铺：${store.name}`,
    `员工：${employeeName}`,
    `员工 ID：${userId}`,
    `请假日期：${validation.date}`,
    `请求 ID：${requestId}`
  ].join('\n'), {
    inline_keyboard: [[
      { text: t('zh', 'btn_approve'), callback_data: `leave:approve:${store.store_id}:${requestId}` },
      { text: t('zh', 'btn_reject'), callback_data: `leave:reject:${store.store_id}:${requestId}` }
    ]]
  });

  return { ok: true, requestId, date: validation.date };
}

async function approveLeave(env, callback, adminId, storeId, requestId, lang) {
  const result = await approveLeaveRequest(env, storeId, requestId, adminId);
  if (!result.ok) return answerCallback(env, callback.id, t(lang, result.error === 'leave_conflict' ? 'leave_conflict' : 'already_processed'), true);
  const empLang = await getUserLang(env, result.row.telegram_id);
  await sendMessage(env, result.row.telegram_id, render(empLang, 'leave_approved', { date: result.row.leave_date }));
  await editCallbackMessage(env, callback, `${callback.message.text}\n\n已批准 by ${adminId}`);
  return answerCallback(env, callback.id, '已批准。');
}

async function startLeaveReject(env, callback, adminId, storeId, requestId, lang) {
  const found = await env.DB.prepare(`SELECT * FROM leave_requests WHERE store_id = ? AND request_id = ?`).bind(storeId, requestId).first();
  if (!found || found.status !== 'pending') return answerCallback(env, callback.id, t(lang, 'already_processed'), true);

  await setState(env, adminId, 'WAIT_LEAVE_REJECT_REASON', { store_id: storeId, request_id: requestId });
  await editCallbackMessage(env, callback, `${callback.message.text}\n\n等待 ${adminId} 输入驳回原因`);
  await sendMessage(env, adminId, `${t(lang, 'ask_reject_reason')}\n${requestId}`);
  return answerCallback(env, callback.id);
}

async function finishLeaveReject(env, adminId, chatId, storeId, requestId, reason, lang) {
  const result = await rejectLeaveRequest(env, storeId, requestId, adminId, reason || 'Rejected by admin');
  await clearState(env, adminId);
  if (!result.ok) return sendMessage(env, chatId, t(lang, 'already_processed'), mainMenu(lang));
  const empLang = await getUserLang(env, result.row.telegram_id);
  await sendMessage(env, result.row.telegram_id, render(empLang, 'leave_rejected', { date: result.row.leave_date, reason: result.reason }));
  return sendMessage(env, chatId, t(lang, 'reject_recorded'), mainMenu(lang));
}

async function startAttendance(env, store, userId, chatId, lang) {
  await setState(env, userId, 'WAIT_ATTENDANCE_LOCATION', { store_id: store.store_id });
  return sendMessage(env, chatId, t(lang, 'ask_location'), {
    keyboard: [
      [{ text: t(lang, 'btn_share_location'), request_location: true }],
      [{ text: t(lang, 'btn_cancel') }]
    ],
    resize_keyboard: true,
    one_time_keyboard: true
  });
}

async function handleLocation(env, store, userId, chatId, location, lang) {
  await setState(env, userId, 'WAIT_ATTENDANCE_ACTION', {
    store_id: store.store_id,
    lat: location.latitude,
    lng: location.longitude
  });
  await sendMessage(env, chatId, t(lang, 'location_received'), { remove_keyboard: true });
  return sendMessage(env, chatId, t(lang, 'choose_attendance_action'), attendanceActionReplyMarkup(store.store_id, lang));
}

export function attendanceActionReplyMarkup(storeId, lang) {
  return {
    inline_keyboard: [[
      { text: t(lang, 'btn_checkin'), callback_data: `att:in:${storeId}` },
      { text: t(lang, 'btn_checkout'), callback_data: `att:out:${storeId}` }
    ]]
  };
}

async function doCheckIn(env, callback, store, userId, lang) {
  const state = await getState(env, userId);
  if (!store || !state || state.state !== 'WAIT_ATTENDANCE_ACTION' || state.data.store_id !== store.store_id) {
    return answerCallback(env, callback.id, t(lang, 'location_expired'), true);
  }

  const now = new Date();
  const businessDate = getBusinessDate(now, store.timezone);
  const existing = await hasAttendance(env, store.store_id, userId, businessDate, 'checkin');
  if (existing) return answerCallback(env, callback.id, t(lang, 'already_checkin'), true);

  const time = localTime(now, store.timezone);
  const late = minutesOf(time) > minutesOf(store.checkin_time);
  const fine = late ? attendanceFineAmount(store, store.late_fine) : 0;
  const recordId = makeId('ATT');
  const at = nowIso();

  await env.DB.prepare(`
    INSERT INTO attendance_records
      (record_id, store_id, telegram_id, business_date, type, timestamp, latitude, longitude, late, early_leave, original_fine, fine)
    VALUES (?, ?, ?, ?, 'checkin', ?, ?, ?, ?, 0, ?, ?)
  `).bind(recordId, store.store_id, userId, businessDate, at, state.data.lat, state.data.lng, late ? 1 : 0, fine, fine).run();

  if (fine > 0) await insertSystemFine(env, store.store_id, userId, fine, 'attendance_late', recordId);
  await clearState(env, userId);

  const extra = late ? render(lang, 'late', { fine: formatMoney(store, fine) }) : t(lang, 'ontime');
  await editCallbackMessage(env, callback, render(lang, 'checkin_done', { date: businessDate, time, extra }));
  return answerCallback(env, callback.id, 'OK');
}

async function doCheckOut(env, callback, store, userId, lang) {
  const state = await getState(env, userId);
  if (!store || !state || state.state !== 'WAIT_ATTENDANCE_ACTION' || state.data.store_id !== store.store_id) {
    return answerCallback(env, callback.id, t(lang, 'location_expired'), true);
  }

  const now = new Date();
  const businessDate = getBusinessDate(now, store.timezone);
  const checkedIn = await hasAttendance(env, store.store_id, userId, businessDate, 'checkin');
  if (!checkedIn) return answerCallback(env, callback.id, t(lang, 'need_checkin'), true);
  const checkedOut = await hasAttendance(env, store.store_id, userId, businessDate, 'checkout');
  if (checkedOut) return answerCallback(env, callback.id, t(lang, 'already_checkout'), true);
  if (await hasPendingCheckout(env, store.store_id, userId, businessDate)) {
    return answerCallback(env, callback.id, t(lang, 'checkout_pending'), true);
  }

  const time = localTime(now, store.timezone);
  const early = minutesOf(time) < minutesOf(store.checkout_time);
  const fine = early ? attendanceFineAmount(store, store.early_leave_fine) : 0;
  const requestId = makeId('OUT');
  const at = nowIso();

  await env.DB.prepare(`
    INSERT INTO pending_checkout_requests
      (request_id, store_id, telegram_id, business_date, timestamp, latitude, longitude, early_leave, fine, status, submitted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).bind(requestId, store.store_id, userId, businessDate, at, state.data.lat, state.data.lng, early ? 1 : 0, fine, at).run();

  await clearState(env, userId);

  const extra = early ? render(lang, 'early', { fine: formatMoney(store, fine) }) : t(lang, 'ontime');
  await editCallbackMessage(env, callback, render(lang, 'checkout_submitted', { date: businessDate, time, extra }));

  const employeeName = await getMemberDisplayName(env, store.store_id, userId);
  await notifyStoreAdmins(env, store.store_id, [
    '新的签退申请',
    `店铺：${store.name}`,
    `员工：${employeeName}`,
    `员工 ID：${userId}`,
    `日期：${businessDate}`,
    `时间：${time}`,
    `罚款：${formatMoney(store, fine)}`,
    `请求 ID：${requestId}`
  ].join('\n'), {
    inline_keyboard: checkoutApprovalKeyboard(store.store_id, requestId, fine)
  });

  return answerCallback(env, callback.id, 'OK');
}

async function approveCheckout(env, callback, adminId, storeId, requestId, lang, applyFine = true) {
  const result = await approveCheckoutRequest(env, storeId, requestId, adminId, applyFine);
  if (!result.ok) return answerCallback(env, callback.id, t(lang, 'already_processed'), true);
  const empLang = await getUserLang(env, result.row.telegram_id);
  const time = localTime(new Date(result.row.timestamp), result.store.timezone);
  const extra = result.row.early_leave
    ? render(empLang, result.waivedFine ? 'early_waived' : 'early', { fine: formatMoney(result.store, result.row.fine) })
    : t(empLang, 'ontime');
  await sendMessage(env, result.row.telegram_id, render(empLang, 'checkout_done', { date: result.row.business_date, time, extra }));
  await editCallbackMessage(env, callback, `${callback.message.text}\n\n已批准 by ${adminId}`);
  return answerCallback(env, callback.id, '已批准。');
}

export function checkoutApprovalKeyboard(storeId, requestId, fine) {
  if (Number(fine || 0) > 0) {
    return [[
      { text: '批准并罚款', callback_data: `att:af:${storeId}:${requestId}` },
      { text: '批准不罚款', callback_data: `att:anf:${storeId}:${requestId}` }
    ], [
      { text: t('zh', 'btn_reject'), callback_data: `att:reject:${storeId}:${requestId}` }
    ]];
  }
  return [[
    { text: t('zh', 'btn_approve'), callback_data: `att:approve:${storeId}:${requestId}` },
    { text: t('zh', 'btn_reject'), callback_data: `att:reject:${storeId}:${requestId}` }
  ]];
}

async function approveAbsenceFine(env, callback, adminId, request, lang) {
  const result = await approveAbsenceFineRequest(env, request.request_id, adminId);
  if (!result.ok) return answerCallback(env, callback.id, t(lang, 'already_processed'), true);
  await editCallbackMessage(env, callback, `${callback.message.text}\n\n已批准罚款 by ${adminId}`);
  return answerCallback(env, callback.id, '已批准罚款。');
}

async function rejectAbsenceFine(env, callback, adminId, request, lang) {
  const result = await rejectAbsenceFineRequest(env, request.request_id, adminId);
  if (!result.ok) return answerCallback(env, callback.id, t(lang, 'already_processed'), true);
  await editCallbackMessage(env, callback, `${callback.message.text}\n\n已驳回 by ${adminId}`);
  return answerCallback(env, callback.id, '已驳回。');
}

async function startCheckoutReject(env, callback, adminId, storeId, requestId, lang) {
  const found = await env.DB.prepare(`SELECT * FROM pending_checkout_requests WHERE store_id = ? AND request_id = ?`).bind(storeId, requestId).first();
  if (!found || found.status !== 'pending') return answerCallback(env, callback.id, t(lang, 'already_processed'), true);

  await setState(env, adminId, 'WAIT_CHECKOUT_REJECT_REASON', { store_id: storeId, request_id: requestId });
  await editCallbackMessage(env, callback, `${callback.message.text}\n\n等待 ${adminId} 输入驳回原因`);
  await sendMessage(env, adminId, `${t(lang, 'ask_reject_reason')}\n${requestId}`);
  return answerCallback(env, callback.id);
}

async function finishCheckoutReject(env, adminId, chatId, storeId, requestId, reason, lang) {
  const result = await rejectCheckoutRequest(env, storeId, requestId, adminId, reason || 'Rejected by admin');
  await clearState(env, adminId);
  if (!result.ok) return sendMessage(env, chatId, t(lang, 'already_processed'), mainMenu(lang));
  const empLang = await getUserLang(env, result.row.telegram_id);
  await sendMessage(env, result.row.telegram_id, render(empLang, 'checkout_rejected', { date: result.row.business_date, reason: result.reason }));
  return sendMessage(env, chatId, t(lang, 'reject_recorded'), mainMenu(lang));
}

async function leaveDateOccupied(env, storeId, leaveDate, dailyLimit = 1) {
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS total FROM leave_requests
    WHERE store_id = ? AND leave_date = ? AND status IN ('pending', 'approved')
  `).bind(storeId, leaveDate).first();
  return Number(row && row.total ? row.total : 0) >= Number(dailyLimit || 1);
}

async function leaveMonthCount(env, storeId, userId, leaveDate) {
  const range = leaveMonthRange(leaveDate);
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS total FROM leave_requests
    WHERE store_id = ? AND telegram_id = ? AND leave_date >= ? AND leave_date < ?
      AND status IN ('pending', 'approved')
  `).bind(storeId, userId, range.startDate, range.endDate).first();
  return Number(row && row.total ? row.total : 0);
}

async function upsertUser(env, from) {
  const telegramId = String(from.id);
  const name = [from.first_name || '', from.last_name || ''].join(' ').trim();
  const username = from.username || '';
  const now = nowIso();
  const role = isGlobalAdmin(env, telegramId) ? 'admin' : 'employee';

  await env.DB.prepare(`
    INSERT INTO users
      (telegram_id, name, username, role, status, cycle_start, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET
      name = excluded.name,
      username = excluded.username,
      role = CASE WHEN users.role = 'admin' THEN users.role ELSE excluded.role END,
      updated_at = excluded.updated_at
  `).bind(telegramId, name, username, role, now, now, now).run();

  if (role === 'admin') await ensureDefaultMembership(env, telegramId, role);
}

async function ensureDefaultMembership(env, telegramId, role) {
  if (role !== 'admin') return;
  const existing = await env.DB.prepare(`
    SELECT 1 FROM store_members WHERE telegram_id = ? LIMIT 1
  `).bind(telegramId).first();
  if (existing && role !== 'admin') return;

  const now = nowIso();
  await env.DB.prepare(`
    INSERT INTO store_members (store_id, telegram_id, role, status, cycle_start, joined_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?, ?)
    ON CONFLICT(store_id, telegram_id) DO UPDATE SET
      role = CASE WHEN excluded.role = 'admin' THEN 'admin' ELSE store_members.role END,
      updated_at = excluded.updated_at
  `).bind(DEFAULT_STORE_ID, telegramId, role, now, now, now).run();
}

async function acceptInvite(env, telegramId, inviteCode) {
  const invite = await env.DB.prepare(`
    SELECT i.*, s.name FROM store_invites i
    JOIN stores s ON s.store_id = i.store_id
    WHERE i.invite_code = ? AND i.status = 'active'
      AND (i.expires_at IS NULL OR i.expires_at > ?)
      AND s.status = 'active'
  `).bind(inviteCode, nowIso()).first();
  if (!invite) return null;
  const now = nowIso();
  await env.DB.prepare(`
    INSERT INTO store_members (store_id, telegram_id, role, status, cycle_start, joined_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?, ?)
    ON CONFLICT(store_id, telegram_id) DO UPDATE SET
      status = 'active',
      role = excluded.role,
      updated_at = excluded.updated_at
  `).bind(invite.store_id, telegramId, invite.role, now, now, now).run();
  await setCurrentStore(env, telegramId, invite.store_id);
  return invite;
}

async function getState(env, telegramId) {
  const row = await env.DB.prepare(`SELECT state, data_json FROM user_states WHERE telegram_id = ?`).bind(telegramId).first();
  if (!row) return null;
  return { state: row.state, data: safeJson(row.data_json) };
}

async function setState(env, telegramId, state, data) {
  await env.DB.prepare(`
    INSERT INTO user_states (telegram_id, state, data_json, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET
      state = excluded.state,
      data_json = excluded.data_json,
      updated_at = excluded.updated_at
  `).bind(telegramId, state, JSON.stringify(data || {}), nowIso()).run();
}

async function clearState(env, telegramId) {
  await env.DB.prepare(`DELETE FROM user_states WHERE telegram_id = ?`).bind(telegramId).run();
}

async function getUserLang(env, telegramId) {
  const row = await env.DB.prepare(`SELECT language FROM user_preferences WHERE telegram_id = ?`).bind(telegramId).first();
  return row && LANGS.includes(row.language) ? row.language : 'zh';
}

async function setUserLang(env, telegramId, language) {
  const lang = LANGS.includes(language) ? language : 'zh';
  await env.DB.prepare(`
    INSERT INTO user_preferences (telegram_id, language, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET
      language = excluded.language,
      updated_at = excluded.updated_at
  `).bind(telegramId, lang, nowIso()).run();
}

async function sendStoreChooser(env, userId, chatId, lang) {
  const stores = await listMemberStores(env, userId);
  if (!stores.length) return sendMessage(env, chatId, t(lang, 'no_store'));
  if (stores.length === 1) {
    await setCurrentStore(env, userId, stores[0].store_id);
    return sendMessage(env, chatId, render(lang, 'store_set', { store: stores[0].name }), mainMenu(lang));
  }
  return sendMessage(env, chatId, t(lang, 'choose_store'), storeKeyboard(stores));
}

async function sendRegistrationStoreChooser(env, chatId, lang) {
  const stores = await listActiveStores(env);
  if (!stores.length) return sendMessage(env, chatId, t(lang, 'no_store'));
  return sendMessage(env, chatId, t(lang, 'register_intro'), registrationStoreKeyboard(stores));
}

async function finishRegistrationRequest(env, userId, chatId, storeId, name, lang) {
  const store = await getStore(env, storeId);
  if (!store || store.status !== 'active') {
    await clearState(env, userId);
    return sendMessage(env, chatId, t(lang, 'no_store'));
  }
  const displayName = String(name || '').trim();
  if (!displayName) return sendMessage(env, chatId, t(lang, 'ask_register_name'));
  await setState(env, userId, 'WAIT_REGISTER_PAYROLL_DATE', {
    store_id: storeId,
    display_name: displayName
  });
  return sendMessage(
    env,
    chatId,
    t(lang, 'ask_register_payroll_date'),
    registrationPayrollDateKeyboard(store)
  );
}

async function finishRegistrationWithPayrollDate(
  env,
  callback,
  userId,
  store,
  displayName,
  payrollStartDate,
  lang
) {
  const now = nowIso();
  const payrollStartAt = zonedMidnightIso(
    payrollStartDate,
    store.timezone || 'Asia/Tokyo'
  );
  await env.DB.prepare(`
    INSERT INTO store_members (
      store_id, telegram_id, display_name, role, status,
      cycle_start, joined_at, payroll_start_date,
      payroll_automation_started_at, updated_at
    )
    VALUES (?, ?, ?, 'employee', 'pending', ?, ?, ?, ?, ?)
    ON CONFLICT(store_id, telegram_id) DO UPDATE SET
      display_name = excluded.display_name,
      role = 'employee',
      status = 'pending',
      cycle_start = excluded.cycle_start,
      payroll_start_date = excluded.payroll_start_date,
      payroll_automation_started_at = excluded.payroll_automation_started_at,
      updated_at = excluded.updated_at
  `).bind(
    store.store_id,
    userId,
    displayName,
    payrollStartAt,
    now,
    payrollStartDate,
    payrollStartAt,
    now
  ).run();
  await clearState(env, userId);
  await notifyStoreAdmins(env, store.store_id, [
    '新的员工加入申请',
    `店铺：${store.name}`,
    `员工：${displayName}`,
    `员工 ID：${userId}`,
    `第一工作日期：${payrollStartDate}`
  ].join('\n'), {
    inline_keyboard: [[
      { text: t('zh', 'btn_approve'), callback_data: `reg:approve:${store.store_id}:${userId}` },
      { text: t('zh', 'btn_reject'), callback_data: `reg:reject:${store.store_id}:${userId}` }
    ]]
  });
  await editCallbackMessage(
    env,
    callback,
    `${callback.message.text}\n\n${payrollStartDate}`
  );
  await answerCallback(env, callback.id);
  return sendMessage(env, callback.message.chat.id, t(lang, 'register_submitted'));
}

async function approveRegistration(env, callback, adminId, storeId, employeeId, lang) {
  const row = await env.DB.prepare(`
    SELECT m.*, s.name AS store_name FROM store_members m
    JOIN stores s ON s.store_id = m.store_id
    WHERE m.store_id = ? AND m.telegram_id = ?
  `).bind(storeId, employeeId).first();
  if (!row || row.status !== 'pending') return answerCallback(env, callback.id, t(lang, 'already_processed'), true);
  await env.DB.prepare(`
    UPDATE store_members SET status = 'active', updated_at = ? WHERE store_id = ? AND telegram_id = ?
  `).bind(nowIso(), storeId, employeeId).run();
  await setCurrentStore(env, employeeId, storeId);
  await audit(env, storeId, adminId, 'approve_registration', employeeId, row);
  const empLang = await getUserLang(env, employeeId);
  await sendMessage(env, employeeId, render(empLang, 'register_approved', { store: row.store_name }), mainMenu(empLang));
  await editCallbackMessage(env, callback, `${callback.message.text}\n\n已批准 by ${adminId}`);
  return answerCallback(env, callback.id, '已批准。');
}

async function rejectRegistration(env, callback, adminId, storeId, employeeId, lang) {
  const row = await env.DB.prepare(`
    SELECT m.*, s.name AS store_name FROM store_members m
    JOIN stores s ON s.store_id = m.store_id
    WHERE m.store_id = ? AND m.telegram_id = ?
  `).bind(storeId, employeeId).first();
  if (!row || row.status !== 'pending') return answerCallback(env, callback.id, t(lang, 'already_processed'), true);
  await env.DB.prepare(`
    UPDATE store_members SET status = 'disabled', updated_at = ? WHERE store_id = ? AND telegram_id = ?
  `).bind(nowIso(), storeId, employeeId).run();
  await audit(env, storeId, adminId, 'reject_registration', employeeId, row);
  const empLang = await getUserLang(env, employeeId);
  await sendMessage(env, employeeId, render(empLang, 'register_rejected', { store: row.store_name }));
  await editCallbackMessage(env, callback, `${callback.message.text}\n\n已驳回 by ${adminId}`);
  return answerCallback(env, callback.id, '已驳回。');
}

async function storeAdminRecipients(env, storeId) {
  const rows = await env.DB.prepare(`
    SELECT telegram_id FROM store_members
    WHERE store_id = ? AND status = 'active' AND role IN ('admin', 'owner')
  `).bind(storeId).all();
  return new Set([
    ...(rows.results || []).map((row) => String(row.telegram_id)),
    ...adminIds(env)
  ]);
}

async function notifyStoreAdmins(env, storeId, text, replyMarkup) {
  const recipients = await storeAdminRecipients(env, storeId);
  for (const adminId of recipients) {
    await sendMessage(env, adminId, text, replyMarkup);
  }
}

function payrollPaymentState(payroll) {
  return {
    payroll_id: payroll.payroll_id,
    store_id: payroll.store_id,
    store_name: payroll.store_name,
    currency: payroll.currency,
    amount_snapshot_micros: payroll.amount_snapshot_micros,
    accepts_bank: Number(payroll.profile_accepts_bank) === 1,
    accepts_usdt: Number(payroll.profile_accepts_usdt) === 1,
    accepts_cash: Number(payroll.profile_accepts_cash) === 1,
    bank_details: payroll.profile_bank_details || null,
    usdt_details: payroll.profile_usdt_details || null,
    usdt_qr_id: payroll.profile_usdt_qr_id || null
  };
}

async function startPayrollPaymentDetails(
  env,
  callback,
  userId,
  payrollId,
  lang
) {
  let payroll;
  try {
    payroll = await getPayrollPaymentContext(env, userId, payrollId);
  } catch {
    return answerCallback(env, callback.id, t(lang, 'no_permission'), true);
  }
  if (![
    'awaiting_employee_details',
    'awaiting_admin_payment'
  ].includes(payroll.status) || payroll.current_admin_id !== null) {
    return answerCallback(
      env,
      callback.id,
      t(lang, 'payroll_payment_details_locked'),
      true
    );
  }
  const state = payrollPaymentState(payroll);
  await setState(env, userId, 'WAIT_PAYROLL_METHODS', state);
  await answerCallback(env, callback.id);
  return sendMessage(
    env,
    callback.message.chat.id,
    t(lang, 'payroll_choose_methods'),
    paymentMethodKeyboard(payrollId, state, lang)
  );
}

async function togglePayrollPaymentMethod(
  env,
  callback,
  userId,
  method,
  payrollId,
  lang
) {
  const state = await getState(env, userId);
  if (!state
    || state.state !== 'WAIT_PAYROLL_METHODS'
    || state.data.payroll_id !== payrollId) {
    return answerCallback(env, callback.id, t(lang, 'no_permission'), true);
  }
  const field = {
    b: 'accepts_bank',
    u: 'accepts_usdt',
    c: 'accepts_cash'
  }[method];
  if (!field) {
    return answerCallback(env, callback.id, t(lang, 'no_permission'), true);
  }
  state.data[field] = !state.data[field];
  await setState(env, userId, 'WAIT_PAYROLL_METHODS', state.data);
  await editCallbackMessage(
    env,
    callback,
    t(lang, 'payroll_choose_methods'),
    paymentMethodKeyboard(payrollId, state.data, lang)
  );
  return answerCallback(env, callback.id);
}

async function confirmPayrollPaymentMethods(
  env,
  callback,
  userId,
  payrollId,
  lang
) {
  const state = await getState(env, userId);
  if (!state
    || state.state !== 'WAIT_PAYROLL_METHODS'
    || state.data.payroll_id !== payrollId) {
    return answerCallback(env, callback.id, t(lang, 'no_permission'), true);
  }
  const data = state.data;
  if (!data.accepts_bank && !data.accepts_usdt && !data.accepts_cash) {
    return answerCallback(
      env,
      callback.id,
      t(lang, 'payroll_method_required'),
      true
    );
  }
  if (data.accepts_bank && !String(data.bank_details || '').trim()) {
    await setState(env, userId, 'WAIT_PAYROLL_BANK_DETAILS', data);
    await answerCallback(env, callback.id);
    return sendMessage(
      env,
      callback.message.chat.id,
      t(lang, 'payroll_ask_bank_details')
    );
  }
  if (data.accepts_usdt) {
    await setState(env, userId, 'WAIT_PAYROLL_USDT_MODE', data);
    await answerCallback(env, callback.id);
    return sendMessage(
      env,
      callback.message.chat.id,
      t(lang, 'payroll_choose_usdt_details'),
      usdtDetailModeKeyboard(payrollId, lang)
    );
  }
  await answerCallback(env, callback.id);
  return finishPayrollPaymentProfile(
    env,
    userId,
    callback.message.chat.id,
    data,
    lang
  );
}

async function finishPayrollBankDetails(
  env,
  userId,
  chatId,
  data,
  text,
  lang
) {
  const bankDetails = String(text || '').trim();
  if (!bankDetails) {
    return sendMessage(env, chatId, t(lang, 'payroll_ask_bank_details'));
  }
  const next = { ...data, bank_details: bankDetails };
  if (next.accepts_usdt) {
    await setState(env, userId, 'WAIT_PAYROLL_USDT_MODE', next);
    return sendMessage(
      env,
      chatId,
      t(lang, 'payroll_choose_usdt_details'),
      usdtDetailModeKeyboard(next.payroll_id, lang)
    );
  }
  return finishPayrollPaymentProfile(env, userId, chatId, next, lang);
}

async function selectPayrollUsdtMode(
  env,
  callback,
  userId,
  mode,
  payrollId,
  lang
) {
  const state = await getState(env, userId);
  if (!state
    || state.state !== 'WAIT_PAYROLL_USDT_MODE'
    || state.data.payroll_id !== payrollId
    || !state.data.accepts_usdt) {
    return answerCallback(env, callback.id, t(lang, 'no_permission'), true);
  }
  const usdtMode = {
    a: 'address',
    q: 'qr',
    b: 'both'
  }[mode];
  if (!usdtMode) {
    return answerCallback(env, callback.id, t(lang, 'no_permission'), true);
  }
  const next = {
    ...state.data,
    usdt_mode: usdtMode,
    usdt_details: null,
    usdt_qr_id: null
  };
  await answerCallback(env, callback.id);
  if (usdtMode === 'qr') {
    await setState(env, userId, 'WAIT_PAYROLL_USDT_QR', next);
    return sendMessage(
      env,
      callback.message.chat.id,
      t(lang, 'payroll_ask_usdt_qr')
    );
  }
  await setState(env, userId, 'WAIT_PAYROLL_USDT_DETAILS', next);
  return sendMessage(
    env,
    callback.message.chat.id,
    t(lang, 'payroll_ask_usdt_details')
  );
}

async function finishPayrollUsdtDetails(
  env,
  userId,
  chatId,
  data,
  text,
  lang
) {
  const usdtDetails = String(text || '').trim();
  if (!usdtDetails) {
    return sendMessage(env, chatId, t(lang, 'payroll_ask_usdt_details'));
  }
  const next = { ...data, usdt_details: usdtDetails };
  if (data.usdt_mode === 'both') {
    await setState(env, userId, 'WAIT_PAYROLL_USDT_QR', next);
    return sendMessage(env, chatId, t(lang, 'payroll_ask_usdt_qr'));
  }
  return finishPayrollPaymentProfile(
    env,
    userId,
    chatId,
    next,
    lang
  );
}

async function finishPayrollUsdtQr(
  env,
  userId,
  chatId,
  data,
  photo,
  lang
) {
  let payroll;
  try {
    payroll = await saveTelegramPaymentQr(
      env,
      userId,
      data.payroll_id,
      data,
      photo
    );
  } catch (error) {
    if (error.message === 'payroll payment details are locked') {
      await clearState(env, userId);
      return sendMessage(
        env,
        chatId,
        t(lang, 'payroll_payment_details_locked')
      );
    }
    const safeReasons = new Set([
      'telegram image is required',
      'telegram image is too large',
      'telegram_file_lookup_failed',
      'telegram_file_download_failed',
      'telegram upload must be an image',
      'payroll QR storage is not configured',
      'payroll QR object already exists',
      'payroll not found',
      'payroll identity mismatch'
    ]);
    await logEvent(env, 'error', 'payroll_usdt_qr_upload_failed', {
      store_id: data.store_id,
      telegram_id: userId,
      payroll_id: data.payroll_id,
      stage: error.qr_upload_stage || 'precondition',
      reason: safeReasons.has(error.message)
        ? error.message
        : 'unexpected_error'
    });
    return sendMessage(env, chatId, t(lang, 'payroll_usdt_qr_failed'));
  }
  await clearState(env, userId);
  await notifyPayrollPaymentProfile(env, payroll, lang);
  return sendMessage(env, chatId, t(lang, 'payroll_usdt_qr_saved'));
}

async function finishPayrollPaymentProfile(
  env,
  userId,
  chatId,
  data,
  lang
) {
  let payroll;
  try {
    payroll = await savePaymentProfile(
      env,
      userId,
      data.payroll_id,
      data
    );
  } catch (error) {
    if (error.message === 'payroll payment details are locked') {
      await clearState(env, userId);
      return sendMessage(
        env,
        chatId,
        t(lang, 'payroll_payment_details_locked')
      );
    }
    throw error;
  }
  await clearState(env, userId);
  await notifyPayrollPaymentProfile(env, payroll, lang);
  return sendMessage(env, chatId, t(lang, 'payroll_profile_saved'));
}

async function notifyPayrollPaymentProfile(env, payroll, lang) {
  const usdtSummary = payroll.accepts_usdt
    ? [
        payroll.usdt_details_snapshot || '未提供地址',
        payroll.usdt_qr_id_snapshot ? '二维码已提供' : ''
      ].filter(Boolean).join('；')
    : '不使用';
  await notifyStoreAdmins(env, payroll.store_id, [
    '员工已提交工资收款信息',
    `工资 ID：${payroll.payroll_id}`,
    `员工 ID：${payroll.telegram_id}`,
    `固定工资：${formatMoney(
      { currency: payroll.currency },
      Number(payroll.amount_snapshot_micros) / 1_000_000
    )}`,
    `银行卡：${payroll.accepts_bank ? payroll.bank_details_snapshot : '不使用'}`,
    `USDT：${usdtSummary}`,
    `现金：${payroll.accepts_cash ? '使用' : '不使用'}`
  ].join('\n'), {
    inline_keyboard: [[{
      text: t(lang, 'btn_admin_process_payroll'),
      callback_data: `pay:a:${payroll.payroll_id}`
    }]]
  });
  if (!payroll.usdt_qr_id_snapshot) return;

  const qr = await env.DB.prepare(`
    SELECT telegram_file_id
    FROM payroll_payment_qr_codes
    WHERE qr_id = ?
  `).bind(payroll.usdt_qr_id_snapshot).first();
  if (!qr) return;
  const recipients = await storeAdminRecipients(
    env,
    payroll.store_id
  );
  for (const adminId of recipients) {
    try {
      const adminLang = await getUserLang(env, adminId);
      const result = await sendPhoto(
        env,
        adminId,
        qr.telegram_file_id,
        render(adminLang, 'payroll_usdt_qr_caption', {
          payroll_id: payroll.payroll_id
        })
      );
      if (!result || !result.ok) {
        throw new Error('telegram_send_failed');
      }
    } catch {
      await logEvent(
        env,
        'warn',
        'payroll_usdt_qr_delivery_failed',
        {
          store_id: payroll.store_id,
          payroll_id: payroll.payroll_id,
          admin_id: String(adminId),
          error: 'telegram_send_failed'
        }
      );
    }
  }
}

const PAYROLL_METHODS = ['bank', 'usdt', 'cash'];
const PAYROLL_METHOD_CODES = {
  b: 'bank',
  u: 'usdt',
  c: 'cash'
};

function payrollMethodLabel(lang, method) {
  return t(lang, `payroll_profile_${method}`);
}

function payrollSplitState(payroll) {
  const methods = PAYROLL_METHODS.filter(
    (method) => Number(payroll[`accepts_${method}`]) === 1
  );
  return {
    payroll_id: payroll.payroll_id,
    store_id: payroll.store_id,
    currency: payroll.currency,
    amount_snapshot_micros: Number(payroll.amount_snapshot_micros),
    methods,
    method_index: 0,
    remaining_micros: Number(payroll.amount_snapshot_micros),
    bank_micros: 0,
    usdt_micros: 0,
    cash_micros: 0
  };
}

function payrollSplitPrompt(data, lang) {
  const method = data.methods[data.method_index];
  return render(lang, 'payroll_ask_split_amount', {
    method: payrollMethodLabel(lang, method),
    remaining: formatMoney(
      { currency: data.currency },
      Number(data.remaining_micros) / 1_000_000
    )
  });
}

async function startAdminPayrollPayment(
  env,
  callback,
  adminId,
  payrollId,
  lang
) {
  const payroll = await env.DB.prepare(`
    SELECT * FROM payroll_disbursements
    WHERE payroll_id = ?
  `).bind(payrollId).first();
  if (!payroll
    || !(await isStoreAdmin(env, adminId, payroll.store_id))) {
    return answerCallback(env, callback.id, t(lang, 'no_permission'), true);
  }
  if (!['awaiting_admin_payment', 'disputed'].includes(payroll.status)) {
    return answerCallback(env, callback.id, t(lang, 'already_processed'), true);
  }
  const savedSplit = PAYROLL_METHODS.reduce(
    (total, method) => total + Number(payroll[`${method}_micros`] || 0),
    0
  );
  if (payroll.status === 'awaiting_admin_payment'
    && payroll.current_admin_id
    && savedSplit === Number(payroll.amount_snapshot_micros)) {
    await answerCallback(env, callback.id);
    return startPayrollProofUpload(
      env,
      adminId,
      callback.message.chat.id,
      payroll,
      lang
    );
  }
  const data = payrollSplitState(payroll);
  if (!data.methods.length) {
    return answerCallback(
      env,
      callback.id,
      t(lang, 'payroll_method_required'),
      true
    );
  }
  await answerCallback(env, callback.id);
  if (data.methods.length === 1) {
    data[`${data.methods[0]}_micros`] = data.remaining_micros;
    return saveAdminPayrollSplit(
      env,
      adminId,
      callback.message.chat.id,
      data,
      lang
    );
  }
  await setState(env, adminId, 'WAIT_PAYROLL_SPLIT', data);
  return sendMessage(
    env,
    callback.message.chat.id,
    payrollSplitPrompt(data, lang)
  );
}

async function finishPayrollSplitAmount(
  env,
  adminId,
  chatId,
  data,
  text,
  lang
) {
  const store = await getStore(env, data.store_id);
  if (!store || !(await isStoreAdmin(env, adminId, data.store_id))) {
    await clearState(env, adminId);
    return sendMessage(env, chatId, t(lang, 'no_permission'));
  }
  const amount = parseStoreAmount(store, text, true);
  const amountMicros = amount === null
    ? null
    : Math.round(amount * 1_000_000);
  if (!Number.isSafeInteger(amountMicros)
    || amountMicros < 0
    || amountMicros > Number(data.remaining_micros)) {
    return sendMessage(
      env,
      chatId,
      `${t(lang, 'payroll_invalid_split_amount')}\n${payrollSplitPrompt(data, lang)}`
    );
  }

  const method = data.methods[data.method_index];
  const next = {
    ...data,
    [`${method}_micros`]: amountMicros,
    method_index: data.method_index + 1,
    remaining_micros: Number(data.remaining_micros) - amountMicros
  };
  if (next.method_index === next.methods.length - 1) {
    const lastMethod = next.methods[next.method_index];
    next[`${lastMethod}_micros`] = next.remaining_micros;
    return saveAdminPayrollSplit(
      env,
      adminId,
      chatId,
      next,
      lang
    );
  }
  await setState(env, adminId, 'WAIT_PAYROLL_SPLIT', next);
  return sendMessage(env, chatId, payrollSplitPrompt(next, lang));
}

async function saveAdminPayrollSplit(
  env,
  adminId,
  chatId,
  data,
  lang
) {
  const payroll = await savePaymentSplit(
    env,
    adminId,
    data.payroll_id,
    {
      bank_micros: Number(data.bank_micros),
      usdt_micros: Number(data.usdt_micros),
      cash_micros: Number(data.cash_micros)
    }
  );
  return startPayrollProofUpload(
    env,
    adminId,
    chatId,
    payroll,
    lang
  );
}

async function startPayrollProofUpload(
  env,
  adminId,
  chatId,
  payroll,
  lang
) {
  const proofMethods = PAYROLL_METHODS.filter(
    (method) => Number(payroll[`${method}_micros`]) > 0
  );
  const proofState = {
    payroll_id: payroll.payroll_id,
    store_id: payroll.store_id,
    currency: payroll.currency,
    proof_methods: proofMethods,
    proof_method: proofMethods[0] || null
  };
  await setState(env, adminId, 'WAIT_PAYROLL_PROOF', proofState);
  return sendMessage(
    env,
    chatId,
    t(lang, 'payroll_proof_upload_prompt'),
    payrollProofKeyboard(proofState, lang)
  );
}

function payrollProofKeyboard(data, lang) {
  const methodCode = {
    bank: 'b',
    usdt: 'u',
    cash: 'c'
  };
  const rows = (data.proof_methods || []).map((method) => [{
    text: `${data.proof_method === method ? '☑' : '☐'} ${payrollMethodLabel(lang, method)}`,
    callback_data: `pay:ps:${methodCode[method]}:${data.payroll_id}`
  }]);
  rows.push([{
    text: t(lang, 'btn_finish_proof_upload'),
    callback_data: `pay:pc:${data.payroll_id}`
  }]);
  return { inline_keyboard: rows };
}

async function selectPayrollProofMethod(
  env,
  callback,
  adminId,
  methodCode,
  payrollId,
  lang
) {
  const state = await getState(env, adminId);
  const method = PAYROLL_METHOD_CODES[methodCode];
  if (!state
    || state.state !== 'WAIT_PAYROLL_PROOF'
    || state.data.payroll_id !== payrollId
    || !state.data.proof_methods.includes(method)) {
    return answerCallback(env, callback.id, t(lang, 'no_permission'), true);
  }
  const next = { ...state.data, proof_method: method };
  await setState(env, adminId, 'WAIT_PAYROLL_PROOF', next);
  await editCallbackMessage(
    env,
    callback,
    t(lang, 'payroll_proof_upload_prompt'),
    payrollProofKeyboard(next, lang)
  );
  return answerCallback(env, callback.id);
}

async function receivePayrollProofPhoto(
  env,
  adminId,
  chatId,
  data,
  photos,
  lang
) {
  if (!data.proof_method) {
    return sendMessage(
      env,
      chatId,
      t(lang, 'payroll_select_proof_method'),
      payrollProofKeyboard(data, lang)
    );
  }
  try {
    await storeTelegramProof(
      env,
      adminId,
      data.payroll_id,
      data.proof_method,
      photos
    );
  } catch (error) {
    await logError(env, 'payroll_proof_upload_error', error, {
      store_id: data.store_id,
      telegram_id: adminId,
      payroll_id: data.payroll_id
    });
    return sendMessage(
      env,
      chatId,
      t(lang, 'payroll_proof_upload_failed'),
      payrollProofKeyboard(data, lang)
    );
  }
  return sendMessage(
    env,
    chatId,
    render(lang, 'payroll_proof_saved', {
      method: payrollMethodLabel(lang, data.proof_method)
    }),
    payrollProofKeyboard(data, lang)
  );
}

async function finishPayrollProofUpload(
  env,
  callback,
  adminId,
  payrollId,
  lang
) {
  const state = await getState(env, adminId);
  if (!state
    || state.state !== 'WAIT_PAYROLL_PROOF'
    || state.data.payroll_id !== payrollId) {
    return answerCallback(env, callback.id, t(lang, 'no_permission'), true);
  }
  let payroll;
  try {
    payroll = await completePayrollProofs(env, adminId, payrollId);
  } catch (error) {
    const missing = Array.isArray(error.missing_methods)
      ? error.missing_methods.map(
        (method) => payrollMethodLabel(lang, method)
      ).join('、')
      : '';
    if (missing) {
      return answerCallback(
        env,
        callback.id,
        render(lang, 'payroll_proofs_incomplete', { methods: missing }),
        true
      );
    }
    payroll = await env.DB.prepare(`
      SELECT * FROM payroll_disbursements
      WHERE payroll_id = ?
    `).bind(payrollId).first();
    if (!payroll || payroll.status !== 'awaiting_employee_confirmation') {
      return answerCallback(
        env,
        callback.id,
        t(lang, 'payroll_proof_upload_failed'),
        true
      );
    }
  }
  try {
    await sendPayrollForEmployeeConfirmation(
      env,
      adminId,
      payroll.payroll_id
    );
  } catch (error) {
    await logError(env, 'payroll_confirmation_delivery_error', error, {
      store_id: payroll.store_id,
      telegram_id: payroll.telegram_id,
      payroll_id: payroll.payroll_id
    });
    return answerCallback(
      env,
      callback.id,
      t(lang, 'payroll_confirmation_delivery_failed'),
      true
    );
  }
  await clearState(env, adminId);
  await editCallbackMessage(
    env,
    callback,
    t(lang, 'payroll_proof_upload_complete')
  );
  return answerCallback(
    env,
    callback.id,
    t(lang, 'payroll_proof_upload_complete')
  );
}

async function employeePaymentAttemptTarget(env, employeeId, attemptId) {
  if (!attemptId) return null;
  return env.DB.prepare(`
    SELECT a.attempt_id, a.payroll_id
    FROM payroll_payment_attempts a
    JOIN payroll_disbursements d ON d.payroll_id = a.payroll_id
    WHERE a.attempt_id = ? AND d.telegram_id = ?
  `).bind(attemptId, String(employeeId)).first();
}

async function legacyEmployeePaymentTarget(env, employeeId, payrollId) {
  const target = await env.DB.prepare(`
    SELECT
      d.payroll_id,
      d.current_payment_attempt_id AS attempt_id,
      COUNT(a.attempt_id) AS attempt_count,
      current.status AS current_attempt_status
    FROM payroll_disbursements d
    LEFT JOIN payroll_payment_attempts a
      ON a.payroll_id = d.payroll_id
    LEFT JOIN payroll_payment_attempts current
      ON current.attempt_id = d.current_payment_attempt_id
     AND current.payroll_id = d.payroll_id
    WHERE d.payroll_id = ? AND d.telegram_id = ?
    GROUP BY d.payroll_id
  `).bind(payrollId, String(employeeId)).first();
  if (!target
    || Number(target.attempt_count) !== 1
    || !target.attempt_id
    || target.current_attempt_status !== 'submitted') {
    return null;
  }
  return target;
}

async function confirmEmployeePayrollReceipt(
  env,
  callback,
  employeeId,
  payrollId,
  lang,
  expectedAttemptId
) {
  let payroll;
  try {
    payroll = await confirmPayrollReceipt(
      env,
      employeeId,
      payrollId,
      env.PAYROLL_FINANCE_EMAIL,
      new Date(),
      expectedAttemptId
    );
  } catch (error) {
    return answerCallback(
      env,
      callback.id,
      error.message === 'stale_payment_attempt'
        ? t(lang, 'payroll_payment_version_stale')
        : error.message === 'already_processed'
          ? t(lang, 'already_processed')
        : t(lang, 'payroll_confirmation_failed'),
      true
    );
  }
  const receipt = payrollReceiptMessage({
    ...payroll,
    language: lang
  });
  await editCallbackMessage(
    env,
    callback,
    receipt
  );
  return answerCallback(
    env,
    callback.id,
    t(lang, 'payroll_receipt_confirmed_ack')
  );
}

async function disputeEmployeePayrollPayment(
  env,
  callback,
  employeeId,
  payrollId,
  lang,
  expectedAttemptId
) {
  let payroll;
  try {
    payroll = await disputePayrollPayment(
      env,
      employeeId,
      payrollId,
      new Date(),
      expectedAttemptId
    );
  } catch (error) {
    return answerCallback(
      env,
      callback.id,
      error.message === 'stale_payment_attempt'
        ? t(lang, 'payroll_payment_version_stale')
        : error.message === 'already_processed'
          ? t(lang, 'already_processed')
        : t(lang, 'no_permission'),
      true
    );
  }
  if (!payroll.employee_response_replay) {
    await notifyStoreAdmins(env, payroll.store_id, [
      '员工对工资付款提出争议',
      `工资 ID：${payroll.payroll_id}`,
      `员工 ID：${payroll.telegram_id}`,
      `固定工资：${formatMoney(
        { currency: payroll.currency },
        Number(payroll.amount_snapshot_micros) / 1_000_000
      )}`,
      `银行卡：${payroll.accepts_bank
        ? maskPaymentValue(payroll.bank_details_snapshot)
        : '不使用'}`,
      `USDT：${payroll.accepts_usdt
        ? maskPaymentValue(payroll.usdt_details_snapshot)
        : '不使用'}`,
      `现金：${payroll.accepts_cash ? '使用' : '不使用'}`
    ].join('\n'), {
      inline_keyboard: [[{
        text: t(lang, 'btn_admin_correct_payroll'),
        callback_data: `pay:a:${payroll.payroll_id}`
      }]]
    });
  }
  await editCallbackMessage(
    env,
    callback,
    t(lang, 'payroll_dispute_submitted')
  );
  return answerCallback(
    env,
    callback.id,
    t(lang, 'payroll_dispute_submitted')
  );
}

function isIncomeCommand(text, lang) {
  return commandMatches(text, ['/income', 'income'], allLangLabels(lang, 'btn_income'));
}

function isTotalCommand(text, lang) {
  return commandMatches(text, ['/total', 'total'], allLangLabels(lang, 'btn_total'));
}

function isSalaryCommand(text, lang) {
  return commandMatches(text, ['/salary', 'salary'], allLangLabels(lang, 'btn_salary'));
}

function isSalaryAdvanceCommand(text, lang) {
  return commandMatches(text, ['/advance', 'advance'], allLangLabels(lang, 'btn_advance'));
}

function isAttendanceCommand(text, lang) {
  return commandMatches(text, ['/attendance', 'attendance'], allLangLabels(lang, 'btn_attendance'));
}

function isLeaveCommand(text, lang) {
  return commandMatches(text, ['/leave', 'leave'], allLangLabels(lang, 'btn_leave'));
}

function isStoreCommand(text, lang) {
  return commandMatches(text, ['/store', '/shop', 'store', 'shop'], allLangLabels(lang, 'btn_store'));
}

function commandMatches(text, commands, labels) {
  const normalized = String(text || '').trim();
  return commands.includes(normalized.toLowerCase()) || labels.includes(normalized);
}

export function compactCallbackData(prefix, action, storeId, requestId) {
  if (requestId === undefined) return `${prefix}:${action}:${storeId}`;
  return `${prefix}:${action}:${storeId}:${requestId}`;
}

function mainMenu(lang) {
  return {
    keyboard: [
      [{ text: t(lang, 'btn_store') }],
      [{ text: t(lang, 'btn_income') }, { text: t(lang, 'btn_total') }],
      [{ text: t(lang, 'btn_advance') }],
      [{ text: t(lang, 'btn_attendance') }, { text: t(lang, 'btn_leave') }]
    ],
    resize_keyboard: true,
    is_persistent: true
  };
}

function storeKeyboard(stores) {
  return {
    inline_keyboard: stores.map((store) => [{
      text: store.name,
      callback_data: `store:set:${store.store_id}`
    }])
  };
}

function registrationStoreKeyboard(stores) {
  return {
    inline_keyboard: stores.map((store) => [{
      text: store.name,
      callback_data: `reg:store:${store.store_id}`
    }])
  };
}

export function registrationPayrollDateKeyboard(store, now = new Date()) {
  return {
    inline_keyboard: payrollStartDateOptions(store, now).map((date) => [{
      text: date,
      callback_data: `reg:paydate:${store.store_id}:${date}`
    }])
  };
}

function languageKeyboard() {
  return {
    inline_keyboard: [[
      { text: '中文', callback_data: 'lang:zh' },
      { text: 'English', callback_data: 'lang:en' },
      { text: 'Tiếng Việt', callback_data: 'lang:vi' },
      { text: 'Русский', callback_data: 'lang:ru' }
    ]]
  };
}

function leaveDateKeyboard(store) {
  return {
    inline_keyboard: leaveDateOptions(store).map((date) => [{
      text: date,
      callback_data: `leave:date:${store.store_id}:${date}`
    }])
  };
}

export function incomeAdminNotificationText({ storeName, employeeName, userId, income, commission, commissionIncome, requestId }) {
  return [
    '新的收入提交',
    `店铺：${storeName}`,
    `员工：${employeeName}`,
    `员工 ID：${userId}`,
    `收入：${income}`,
    `提成比例：${commission}`,
    `提成收入：${commissionIncome}`,
    `请求 ID：${requestId}`
  ].join('\n');
}

function amountPrompt(lang, store, type) {
  const key = type === 'fine' ? 'ask_fine' : type === 'advance' ? 'ask_advance' : 'ask_income';
  const base = t(lang, key);
  if (!isVndStore(store)) return base;
  const hintKey = type === 'fine' ? 'vnd_fine_hint' : type === 'advance' ? 'vnd_advance_hint' : 'vnd_income_hint';
  return `${base}\n${t(lang, hintKey)}`;
}

function leaveRulePrompt(lang, store) {
  return render(lang, 'ask_leave_date', leaveRuleParams(store));
}
