import {
  addRangeFilter,
  adminOrderSql,
  adminPage,
  adminSortColumns,
  adminStoreWhere,
  absenceAdminSortColumns,
  currentAdminStoreId,
  memberListQuery,
  placeholders,
  resetAdminSortPages,
  sumAttendanceEmployeeStats,
  toCsv,
  visibleAdminStores
} from './admin-query.js';
import {
  approveAbsenceFineRequest,
  approveCheckoutRequest,
  approveIncomeRequest,
  approveLeaveRequest,
  approveSalaryAdvanceRequest,
  approveSalaryRequest,
  cancelAbsenceForApprovedLeave,
  deleteIncomeRecord,
  deletePendingIncome,
  hasAttendance,
  hasPendingCheckout,
  insertSystemFine,
  mutationCount,
  rejectAbsenceFineRequest,
  rejectCheckoutRequest,
  rejectIncomeRequest,
  rejectLeaveRequest,
  rejectSalaryAdvanceRequest,
  rejectSalaryRequest,
  updateIncomeFineRecord
} from './approvals.js';
import {
  audit,
  auditStatement,
  logError,
  logEvent,
  makeId,
  makeStoreId,
  nowIso,
  safeJson
} from './audit.js';
import { DEFAULT_STORE_ID } from './constants.js';
import {
  absenceScanDates,
  addIsoDays,
  completedAttendanceDate,
  dateRange,
  formatAdminDateTime,
  formatAdminShortDateHour,
  getBusinessDate,
  leaveDateOptions,
  leaveMonthRange,
  leaveRuleParams,
  localDate,
  localParts,
  localTime,
  minutesOf,
  validateLeaveDate,
  zonedMidnightIso
} from './dates.js';
import {
  CSV_HEADERS,
  clearSessionCookie,
  html,
  json,
  readJson,
  sessionCookieValue,
  setSessionCookie
} from './http.js';
import { LANGS, allLangLabels, render, t } from './i18n.js';
import {
  attendanceAdminActions,
  attendanceFineAmount,
  calculateCommissionIncome,
  calculateIncomeRowsTotal,
  calculateNetIncome,
  checkoutFineWaiverAmount,
  formatAdminMoney,
  formatMoney,
  formatPercent,
  isVndStore,
  normalizeCommissionRate,
  parseStoreAmount
} from './money.js';
import {
  calculateSalaryAmount,
  getMemberCommissionRate,
  getTotalIncome
} from './payroll.js';
import {
  adminIds,
  isGlobalAdmin,
  isWebhookConfigReady,
  nextLoginFailureState,
  parseTelegramAllowlist,
  scheduledTasksEnabled,
  serviceEnvironment,
  webhookSecretMatches
} from './security.js';
import {
  getCurrentStoreId,
  getMemberDisplayName,
  getStore,
  getStoreForMember,
  isAnyAdmin,
  isStoreAdmin,
  listActiveStores,
  listMemberStores,
  resolveStoreForUser,
  setCurrentStore
} from './stores.js';
import {
  answerCallback,
  editCallbackMessage,
  sendMessage
} from './telegram-client.js';
import { normalizePositiveInt, validTime } from './validation.js';

export * from './admin-query.js';
export * from './dates.js';
export * from './ids.js';
export * from './money.js';
export * from './security.js';
export {
  approveAbsenceFineRequest,
  approveLeaveRequest,
  cancelAbsenceForApprovedLeave,
  rejectAbsenceFineRequest
} from './approvals.js';
export { sanitizeLogPayload } from './audit.js';
export { render } from './i18n.js';
export { telegram } from './telegram-client.js';

export const ABSENCE_PENDING_COLUMNS = Object.freeze([
  'store_id', 'display_name', 'business_date', 'fine', 'created_at',
  'notification_status', 'notification_delivery', 'action'
]);
export const ABSENCE_HISTORY_COLUMNS = Object.freeze([
  'store_id', 'display_name', 'business_date', 'status', 'original_fine',
  'actual_fine', 'admin_id', 'decided_at', 'decision_reason', 'income_record_id'
]);
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return json({
        ok: true,
        service: 'staffbot-v2',
        environment: serviceEnvironment(env),
        admin: '/admin'
      });
    }

    if (request.method === 'GET' && url.pathname === '/admin') {
      return html(adminHtml(env));
    }

    if (url.pathname.startsWith('/api/admin/')) {
      if (!isWebhookConfigReady(env)) return json({ ok: false, error: 'server_not_configured' }, 500);
      return handleAdminApi(request, env, url, ctx);
    }

    if (request.method === 'POST' && url.pathname.startsWith('/webhook/')) {
      if (!isWebhookConfigReady(env)) return json({ ok: false, error: 'server_not_configured' }, 500);
      if (url.pathname !== `/webhook/${env.WEBHOOK_SECRET}`) return json({ ok: false, error: 'not_found' }, 404);
      if (!webhookSecretMatches(request.headers.get('x-telegram-bot-api-secret-token') || '', env.WEBHOOK_SECRET)) {
        return json({ ok: false, error: 'forbidden' }, 403);
      }
      const update = await request.json();
      ctx.waitUntil(logEvent(env, 'debug', 'telegram_update', update.message ? {
        telegram_id: update.message.from && update.message.from.id,
        chat_id: update.message.chat && update.message.chat.id,
        update_id: update.update_id
      } : { update_id: update.update_id }));
      await handleUpdate(update, env);
      return json({ ok: true });
    }

    return json({ ok: false, error: 'not_found' }, 404);
  },

  async scheduled(controller, env, ctx) {
    if (!scheduledTasksEnabled(env)) return;
    ctx.waitUntil(processAbsenceFines(env, new Date(controller.scheduledTime)));
  }
};

async function handleUpdate(update, env) {
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
    const storeId = parts[2] || DEFAULT_STORE_ID;
    const employeeId = parts[3] || '';
    if (!(await isStoreAdmin(env, userId, storeId))) {
      await audit(env, storeId, userId, 'unauthorized_registration_callback', data, {});
      return answerCallback(env, callback.id, t(lang, 'no_permission'), true);
    }
    if (parts[1] === 'approve') return approveRegistration(env, callback, userId, storeId, employeeId, lang);
    if (parts[1] === 'reject') return rejectRegistration(env, callback, userId, storeId, employeeId, lang);
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
  const pending = await env.DB.prepare(`
    SELECT request_id FROM salary_requests WHERE store_id = ? AND telegram_id = ? AND status = 'pending'
  `).bind(store.store_id, userId).first();
  if (pending) return sendMessage(env, chatId, t(lang, 'salary_pending'), mainMenu(lang));

  const total = await getTotalIncome(env, store.store_id, userId);
  if (total <= 0) {
    return sendMessage(env, chatId, render(lang, 'no_salary', { total: formatMoney(store, total) }), mainMenu(lang));
  }
  const commissionRate = await getMemberCommissionRate(env, store.store_id, userId);
  const salaryAmount = total;

  return sendMessage(env, chatId, render(lang, 'salary_confirm', {
    store: store.name,
    total: formatMoney(store, total),
    commission: formatPercent(commissionRate),
    amount: formatMoney(store, salaryAmount)
  }), {
    inline_keyboard: [[
      { text: t(lang, 'btn_confirm'), callback_data: `salary:confirm:${store.store_id}` },
      { text: t(lang, 'btn_cancel'), callback_data: 'salary:cancel' }
    ]]
  });
}

async function confirmSalary(env, callback, store, userId, lang) {
  if (!store) return answerCallback(env, callback.id, t(lang, 'no_store'), true);
  const pending = await env.DB.prepare(`
    SELECT request_id FROM salary_requests WHERE store_id = ? AND telegram_id = ? AND status = 'pending'
  `).bind(store.store_id, userId).first();
  if (pending) return answerCallback(env, callback.id, t(lang, 'salary_pending'), true);

  const total = await getTotalIncome(env, store.store_id, userId);
  if (total <= 0) return answerCallback(env, callback.id, t(lang, 'no_salary'), true);
  const commissionRate = await getMemberCommissionRate(env, store.store_id, userId);
  const salaryAmount = total;

  const requestId = makeId('SALREQ');
  const requestedAt = nowIso();
  await env.DB.prepare(`
    INSERT INTO salary_requests
      (request_id, store_id, telegram_id, amount_snapshot, status, requested_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).bind(requestId, store.store_id, userId, salaryAmount, requestedAt).run();

  await editCallbackMessage(env, callback, `${callback.message.text}\n\n${t(lang, 'salary_submitted')}`);
  const employeeName = await getMemberDisplayName(env, store.store_id, userId);
  await notifyStoreAdmins(env, store.store_id, [
    '新的工资申请',
    `店铺：${store.name}`,
    `员工：${employeeName}`,
    `员工 ID：${userId}`,
    `当前总收入：${formatMoney(store, total)}`,
    `提成比例：${formatPercent(commissionRate)}`,
    `可申请工资：${formatMoney(store, salaryAmount)}`,
    `请求 ID：${requestId}`
  ].join('\n'), {
    inline_keyboard: [[
      { text: t('zh', 'btn_approve'), callback_data: compactCallbackData('sal', 'a', store.store_id, requestId) },
      { text: t('zh', 'btn_reject'), callback_data: compactCallbackData('sal', 'r', store.store_id, requestId) }
    ]]
  });
  return answerCallback(env, callback.id, t(lang, 'salary_submitted'));
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

export function absenceApprovalKeyboard(requestId) {
  return [[
    { text: '批准罚款', callback_data: compactCallbackData('abs', 'a', requestId) },
    { text: '驳回', callback_data: compactCallbackData('abs', 'r', requestId) }
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
  const now = nowIso();
  await env.DB.prepare(`
    INSERT INTO store_members (store_id, telegram_id, display_name, role, status, cycle_start, joined_at, updated_at)
    VALUES (?, ?, ?, 'employee', 'pending', ?, ?, ?)
    ON CONFLICT(store_id, telegram_id) DO UPDATE SET
      display_name = excluded.display_name,
      role = 'employee',
      status = 'pending',
      updated_at = excluded.updated_at
  `).bind(storeId, userId, displayName, now, now, now).run();
  await clearState(env, userId);
  await notifyStoreAdmins(env, storeId, [
    '新的员工加入申请',
    `店铺：${store.name}`,
    `员工：${displayName}`,
    `员工 ID：${userId}`
  ].join('\n'), {
    inline_keyboard: [[
      { text: t('zh', 'btn_approve'), callback_data: `reg:approve:${storeId}:${userId}` },
      { text: t('zh', 'btn_reject'), callback_data: `reg:reject:${storeId}:${userId}` }
    ]]
  });
  return sendMessage(env, chatId, t(lang, 'register_submitted'));
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

async function handleAdminApi(request, env, url, ctx) {
  try {
    if (request.method === 'POST' && url.pathname === '/api/admin/login/start') return adminLoginStart(request, env);
    if (request.method === 'POST' && url.pathname === '/api/admin/login/verify') return adminLoginVerify(request, env);

    const session = await requireAdminSession(request, env);
    if (!session) return json({ ok: false, error: 'unauthorized' }, 401);

    if (request.method === 'POST' && url.pathname === '/api/admin/logout') {
      ctx.waitUntil(env.DB.prepare(`DELETE FROM admin_sessions WHERE token = ?`).bind(session.token).run());
      return json({ ok: true }, 200, clearSessionCookie());
    }

    if (request.method === 'GET' && url.pathname === '/api/admin/me') {
      return json({ ok: true, telegram_id: session.telegram_id, global_admin: isGlobalAdmin(env, session.telegram_id) });
    }

    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[2] !== 'stores') return json({ ok: false, error: 'not_found' }, 404);

    if (parts.length === 3) {
      if (request.method === 'GET') return listAdminStores(env, url, session.telegram_id);
      if (request.method === 'POST') return createAdminStore(request, env, session.telegram_id);
    }

    const storeId = decodeURIComponent(parts[3] || '');
    if (!storeId || !(await isStoreAdmin(env, session.telegram_id, storeId))) {
      return json({ ok: false, error: 'forbidden' }, 403);
    }

    if (parts.length === 4 && request.method === 'PATCH') return updateAdminStore(request, env, session.telegram_id, storeId);
    if (parts.length === 4 && request.method === 'DELETE') return deleteAdminStore(env, session.telegram_id, storeId);
    if (parts[4] === 'members') return handleAdminMembers(request, env, url, storeId, parts, session.telegram_id);
    if (parts[4] === 'income') return handleAdminIncome(request, env, url, storeId, parts, session.telegram_id);
    if (parts[4] === 'salary') return handleAdminSalary(request, env, url, storeId, parts, session.telegram_id);
    if (parts[4] === 'advances') return handleAdminSalaryAdvances(request, env, url, storeId, parts, session.telegram_id);
    if (parts[4] === 'attendance') return handleAdminAttendance(request, env, url, storeId, parts, session.telegram_id);
    if (parts[4] === 'absence') return handleAdminAbsence(request, env, url, storeId, parts, session.telegram_id);
    if (parts[4] === 'leave') return handleAdminLeave(request, env, url, storeId, parts, session.telegram_id);
    if (parts[4] === 'logs' && request.method === 'GET') {
      const result = await listPagedRows(
        env,
        url,
        'logs_page',
        'rows',
        `SELECT * FROM bot_logs WHERE store_id = ?`,
        `SELECT COUNT(*) AS total FROM bot_logs WHERE store_id = ?`,
        [storeId],
        `ORDER BY id DESC`,
        adminSortColumns(['id','store_id','level','event','telegram_id','message_text','payload_json','created_at'])
      );
      return json({ ok: true, rows: result.rows, pagination: { rows: result.pagination } });
    }
    if (parts[4] === 'export' && request.method === 'GET') return exportCsv(env, url, storeId, parts[5], session.telegram_id);

    return json({ ok: false, error: 'not_found' }, 404);
  } catch (error) {
    await logError(env, 'admin_api_error', error, { path: url.pathname });
    return json({ ok: false, error: 'server_error' }, 500);
  }
}

async function adminLoginStart(request, env) {
  const body = await readJson(request);
  const telegramId = String(body.telegram_id || '').trim();
  if (!telegramId || !(await isAnyAdmin(env, telegramId))) {
    return json({ ok: false, error: 'forbidden' }, 403);
  }
  const existing = await env.DB.prepare(`SELECT locked_until FROM admin_login_codes WHERE telegram_id = ?`).bind(telegramId).first();
  if (existing && existing.locked_until && existing.locked_until > nowIso()) {
    return json({ ok: false, error: 'too_many_attempts' }, 429);
  }
  const code = makeNumericCode();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
  await env.DB.prepare(`
    INSERT INTO admin_login_codes (telegram_id, code, expires_at, created_at, failed_attempts, locked_until)
    VALUES (?, ?, ?, ?, 0, NULL)
    ON CONFLICT(telegram_id) DO UPDATE SET
      code = excluded.code,
      expires_at = excluded.expires_at,
      created_at = excluded.created_at,
      failed_attempts = 0,
      locked_until = NULL
  `).bind(telegramId, code, expiresAt, now.toISOString()).run();
  await sendMessage(env, telegramId, `StaffBot 后台登录验证码：${code}\n10 分钟内有效。`);
  return json({ ok: true });
}

async function adminLoginVerify(request, env) {
  const body = await readJson(request);
  const telegramId = String(body.telegram_id || '').trim();
  const code = String(body.code || '').trim();
  const found = await env.DB.prepare(`SELECT * FROM admin_login_codes WHERE telegram_id = ?`).bind(telegramId).first();
  if (found && found.locked_until && found.locked_until > nowIso()) {
    return json({ ok: false, error: 'too_many_attempts' }, 429);
  }
  if (!found || found.code !== code || found.expires_at <= nowIso() || !(await isAnyAdmin(env, telegramId))) {
    if (found) {
      const next = nextLoginFailureState(found.failed_attempts, new Date());
      await env.DB.prepare(`
        UPDATE admin_login_codes SET failed_attempts = ?, locked_until = ? WHERE telegram_id = ?
      `).bind(next.failedAttempts, next.lockedUntil, telegramId).run();
    }
    return json({ ok: false, error: 'invalid_code' }, 403);
  }
  await env.DB.prepare(`DELETE FROM admin_login_codes WHERE telegram_id = ?`).bind(telegramId).run();
  const token = makeId('SESS');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(`
    INSERT INTO admin_sessions (token, telegram_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).bind(token, telegramId, expiresAt, now.toISOString()).run();
  return json({ ok: true }, 200, setSessionCookie(token, expiresAt));
}

async function requireAdminSession(request, env) {
  const token = sessionCookieValue(request.headers.get('cookie') || '');
  if (!token) return null;
  const row = await env.DB.prepare(`SELECT * FROM admin_sessions WHERE token = ? AND expires_at > ?`).bind(token, nowIso()).first();
  if (!row || !(await isAnyAdmin(env, row.telegram_id))) return null;
  return { ...row, token };
}

async function listAdminStores(env, url, adminId) {
  const orderSql = adminOrderSql(url, 'stores_page', adminSortColumns([
    'store_id','name','status','timezone','currency','checkin_time','checkout_time',
    'late_fine','early_leave_fine','leave_min_notice_days','leave_max_notice_days',
    'leave_monthly_limit','leave_daily_limit','leave_same_day_cutoff_hour','absence_fine',
    'absence_fine_enabled_at','absence_last_checked_date'
  ], 's'), 'ORDER BY s.name');
  const allRows = isGlobalAdmin(env, adminId)
    ? await env.DB.prepare(`SELECT s.* FROM stores s WHERE s.status = 'active' ${orderSql}`).all()
    : await env.DB.prepare(`
        SELECT s.* FROM stores s
        JOIN store_members m ON m.store_id = s.store_id
        WHERE m.telegram_id = ? AND m.status = 'active' AND m.role IN ('admin', 'owner') AND s.status = 'active'
        ${orderSql}
      `).bind(adminId).all();
  const allStores = visibleAdminStores(allRows.results || []);
  const pagination = adminPage(url.searchParams.get('stores_page'), allStores.length);
  return json({
    ok: true,
    stores: allStores.slice(pagination.offset, pagination.offset + pagination.limit),
    all_stores: allStores,
    pagination: { stores: pagination }
  });
}

async function createAdminStore(request, env, adminId) {
  if (!isGlobalAdmin(env, adminId)) return json({ ok: false, error: 'forbidden' }, 403);
  const body = await readJson(request);
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const storeId = cleanStoreId(body.store_id || body.name || makeStoreId());
  const name = String(body.name || storeId).trim();
  const normalizedStore = normalizeStoreInput({ ...body, store_id: storeId, name });
  const store = {
    ...normalizedStore,
    ...normalizeAbsenceFineSetting(body, normalizedStore, nowDate)
  };
  const globalAdminMembers = adminIds(env).map((telegramId) => env.DB.prepare(`
    INSERT INTO store_members (store_id, telegram_id, role, status, cycle_start, joined_at, updated_at)
    VALUES (?, ?, 'admin', 'active', ?, ?, ?)
    ON CONFLICT(store_id, telegram_id) DO UPDATE SET
      role = 'admin',
      status = 'active',
      updated_at = excluded.updated_at
  `).bind(store.store_id, telegramId, now, now, now));
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO stores (
        store_id, name, status, timezone, currency, checkin_time, checkout_time,
        late_fine, early_leave_fine, leave_min_notice_days, leave_max_notice_days,
        leave_monthly_limit, leave_daily_limit, leave_same_day_cutoff_hour,
        absence_fine, absence_fine_enabled_at, absence_last_checked_date, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      store.store_id, store.name, store.status, store.timezone, store.currency,
      store.checkin_time, store.checkout_time, store.late_fine, store.early_leave_fine,
      store.leave_min_notice_days, store.leave_max_notice_days, store.leave_monthly_limit,
      store.leave_daily_limit, store.leave_same_day_cutoff_hour, store.absence_fine,
      store.absence_fine_enabled_at, store.absence_last_checked_date, now, now
    ),
    ...globalAdminMembers
  ]);
  await audit(env, store.store_id, adminId, 'create_store', store.store_id, store);
  return json({ ok: true, store });
}

async function updateAdminStore(request, env, adminId, storeId) {
  const body = await readJson(request);
  const current = await getStore(env, storeId);
  if (!current) return json({ ok: false, error: 'not_found' }, 404);
  const now = new Date();
  const next = {
    ...normalizeStoreInput({ ...current, ...body, store_id: storeId }),
    ...normalizeAbsenceFineSetting(body, current, now)
  };
  await env.DB.prepare(`
    UPDATE stores SET
      name = ?, status = ?, timezone = ?, currency = ?, checkin_time = ?,
      checkout_time = ?, late_fine = ?, early_leave_fine = ?,
      leave_min_notice_days = ?, leave_max_notice_days = ?,
      leave_monthly_limit = ?, leave_daily_limit = ?, leave_same_day_cutoff_hour = ?,
      absence_fine = ?, absence_fine_enabled_at = ?, absence_last_checked_date = ?, updated_at = ?
    WHERE store_id = ?
  `).bind(
    next.name, next.status, next.timezone, next.currency, next.checkin_time,
    next.checkout_time, next.late_fine, next.early_leave_fine,
    next.leave_min_notice_days, next.leave_max_notice_days, next.leave_monthly_limit,
    next.leave_daily_limit, next.leave_same_day_cutoff_hour, next.absence_fine,
    next.absence_fine_enabled_at, next.absence_last_checked_date, now.toISOString(), storeId
  ).run();
  await audit(env, storeId, adminId, 'update_store', storeId, body);
  return json({ ok: true, store: next });
}

async function deleteAdminStore(env, adminId, storeId) {
  if (storeId === DEFAULT_STORE_ID) return json({ ok: false, error: 'default_store_cannot_be_deleted' }, 400);
  await env.DB.prepare(`
    UPDATE stores SET status = 'disabled', updated_at = ? WHERE store_id = ?
  `).bind(nowIso(), storeId).run();
  await audit(env, storeId, adminId, 'delete_store', storeId, {});
  return json({ ok: true });
}

async function handleAdminMembers(request, env, url, storeId, parts, adminId) {
  if (request.method === 'GET') {
    if (url.searchParams.get('all') === '1') {
      return listRows(env, `
        SELECT
          m.store_id,
          m.telegram_id,
          COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), m.telegram_id) AS display_name,
          u.name AS telegram_name,
          u.username,
          m.role,
          m.status,
          m.commission_rate,
          m.absence_check_enabled,
          m.cycle_start,
          m.joined_at,
          m.updated_at
        FROM store_members m
        LEFT JOIN users u ON u.telegram_id = m.telegram_id
        WHERE m.store_id = ? ORDER BY m.role DESC, display_name, m.telegram_id
      `, [storeId], 'members');
    }
    const filters = await adminFilters(env, url, storeId, adminId);
    if (!filters.ok) return json({ ok: false, error: filters.error }, filters.status);
    const storeWhere = adminStoreWhere('m', filters.storeIds);
    const memberSort = {
      ...adminSortColumns(['store_id','telegram_id','role','status','commission_rate','cycle_start','joined_at','updated_at'], 'm'),
      display_name: 'display_name',
      telegram_name: 'u.name',
      username: 'u.username'
    };
    const result = await listPagedRows(env, url, 'members_page', 'members', `
      SELECT
        m.store_id,
        m.telegram_id,
        COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), m.telegram_id) AS display_name,
        u.name AS telegram_name,
        u.username,
        m.role,
        m.status,
        m.commission_rate,
        m.absence_check_enabled,
        m.cycle_start,
        m.joined_at,
        m.updated_at
      FROM store_members m
      LEFT JOIN users u ON u.telegram_id = m.telegram_id
      WHERE ${storeWhere.sql}
    `, `SELECT COUNT(*) AS total FROM store_members m WHERE ${storeWhere.sql}`, storeWhere.params, `ORDER BY m.role DESC, display_name, m.telegram_id`, memberSort);
    return json({ ok: true, members: result.members, pagination: { members: result.pagination } });
  }
  if (request.method === 'DELETE' && parts[5]) {
    const telegramId = decodeURIComponent(parts[5]);
    await env.DB.prepare(`
      DELETE FROM store_members WHERE store_id = ? AND telegram_id = ?
    `).bind(storeId, telegramId).run();
    await audit(env, storeId, adminId, 'delete_member', telegramId, {});
    return json({ ok: true });
  }
  const body = await readJson(request);
  const telegramId = String(body.telegram_id || '').trim();
  if (!telegramId) return json({ ok: false, error: 'telegram_id_required' }, 400);
  if (Object.prototype.hasOwnProperty.call(body, 'absence_check_enabled')
    && typeof body.absence_check_enabled !== 'boolean') {
    return json({ ok: false, error: 'invalid_absence_check_enabled' }, 400);
  }
  const role = ['employee', 'admin', 'owner'].includes(body.role) ? body.role : 'employee';
  const status = ['active', 'pending', 'disabled'].includes(body.status) ? body.status : 'active';
  const commissionRate = normalizeCommissionRate(body.commission_rate);
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const currentMember = await env.DB.prepare(`
    SELECT absence_check_enabled, absence_check_enabled_at
    FROM store_members WHERE store_id = ? AND telegram_id = ?
  `).bind(storeId, telegramId).first();
  const absenceCheck = normalizeEmployeeAbsenceCheck(body, currentMember, nowDate);
  const disablingAbsenceCheck = !!currentMember
    && Number(currentMember.absence_check_enabled) === 1
    && absenceCheck.absence_check_enabled === 0;
  const statements = [
    env.DB.prepare(`
      INSERT INTO users (telegram_id, name, username, role, status, cycle_start, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET
        name = COALESCE(NULLIF(excluded.name, ''), users.name),
        username = COALESCE(NULLIF(excluded.username, ''), users.username),
        updated_at = excluded.updated_at
    `).bind(telegramId, String(body.name || ''), String(body.username || ''), role, status, now, now, now),
    env.DB.prepare(`
      INSERT INTO store_members (
        store_id, telegram_id, display_name, role, status, commission_rate,
        cycle_start, joined_at, updated_at, absence_check_enabled, absence_check_enabled_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(store_id, telegram_id) DO UPDATE SET
        display_name = COALESCE(NULLIF(excluded.display_name, ''), store_members.display_name),
        role = excluded.role,
        status = excluded.status,
        commission_rate = excluded.commission_rate,
        absence_check_enabled = excluded.absence_check_enabled,
        absence_check_enabled_at = excluded.absence_check_enabled_at,
        updated_at = excluded.updated_at
    `).bind(
      storeId, telegramId, String(body.name || ''), role, status, commissionRate,
      now, now, now, absenceCheck.absence_check_enabled, absenceCheck.absence_check_enabled_at
    )
  ];
  if (disablingAbsenceCheck) {
    statements.push(
      env.DB.prepare(`
        UPDATE absence_fine_requests
        SET status = 'cancelled', cancellation_reason = 'absence_check_disabled',
            decided_at = ?, admin_id = ?
        WHERE store_id = ? AND telegram_id = ? AND status = 'pending'
      `).bind(now, adminId, storeId, telegramId),
      env.DB.prepare(`
        UPDATE absence_fine_notifications
        SET status = 'cancelled', last_error = 'absence_check_disabled'
        WHERE status IN ('pending', 'sending')
          AND request_id IN (
            SELECT request_id FROM absence_fine_requests
            WHERE store_id = ? AND telegram_id = ?
              AND status = 'cancelled'
              AND cancellation_reason = 'absence_check_disabled'
          )
      `).bind(storeId, telegramId)
    );
  }
  statements.push(auditStatement(env, storeId, adminId, 'update_member', telegramId, {
    absence_check: {
      before: currentMember ? Number(currentMember.absence_check_enabled) : null,
      after: absenceCheck.absence_check_enabled
    }
  }, now));
  await env.DB.batch(statements);
  return json({ ok: true });
}

async function handleAdminIncome(request, env, url, storeId, parts, adminId) {
  if (parts.length === 5 && request.method === 'GET') {
    const filters = await adminFilters(env, url, storeId, adminId);
    if (!filters.ok) return json({ ok: false, error: filters.error }, filters.status);
    const pendingWhere = [
      `p.store_id IN (${placeholders(filters.storeIds.length)})`,
      `p.status = 'pending'`
    ];
    const pendingParams = [...filters.storeIds];
    const rejectedWhere = [
      `p.store_id IN (${placeholders(filters.storeIds.length)})`,
      `p.status = 'rejected'`
    ];
    const rejectedParams = [...filters.storeIds];
    const recordWhere = [
      `r.store_id IN (${placeholders(filters.storeIds.length)})`
    ];
    const recordParams = [...filters.storeIds];
    if (filters.employeeId) {
      pendingWhere.push(`p.telegram_id = ?`);
      pendingParams.push(filters.employeeId);
      rejectedWhere.push(`p.telegram_id = ?`);
      rejectedParams.push(filters.employeeId);
      recordWhere.push(`r.telegram_id = ?`);
      recordParams.push(filters.employeeId);
    }
    addRangeFilter(pendingWhere, pendingParams, 'p.submitted_at', filters.monthStart, filters.monthEnd);
    addRangeFilter(rejectedWhere, rejectedParams, 'p.submitted_at', filters.monthStart, filters.monthEnd);
    addRangeFilter(recordWhere, recordParams, 'r.approved_at', filters.monthStart, filters.monthEnd);
    const pendingSort = {
      ...adminSortColumns(['request_id','store_id','telegram_id','income','commission_rate','commission_income','fine','status','submitted_at','decided_at','admin_id','reject_reason'], 'p'),
      original_fine: 'p.fine',
      display_name: 'display_name',
      username: 'u.username'
    };
    const recordSort = {
      ...adminSortColumns(['record_id','store_id','telegram_id','type','income','commission_rate','commission_income','original_fine','fine','approved_at','admin_id'], 'r'),
      submitted_at: 'p.submitted_at',
      display_name: 'display_name',
      username: 'u.username'
    };
    const pending = await listPagedRows(env, url, 'pending_page', 'pending', `
      SELECT p.*, p.fine AS original_fine, COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), p.telegram_id) AS display_name, u.username
      FROM pending_income p
      LEFT JOIN users u ON u.telegram_id = p.telegram_id
      LEFT JOIN store_members m ON m.store_id = p.store_id AND m.telegram_id = p.telegram_id
      WHERE ${pendingWhere.join(' AND ')}
    `, `SELECT COUNT(*) AS total FROM pending_income p WHERE ${pendingWhere.join(' AND ')}`, pendingParams, `ORDER BY p.submitted_at DESC`, pendingSort);
    const rejected = await listPagedRows(env, url, 'rejected_page', 'rejected', `
      SELECT p.*, COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), p.telegram_id) AS display_name, u.username
      FROM pending_income p
      LEFT JOIN users u ON u.telegram_id = p.telegram_id
      LEFT JOIN store_members m ON m.store_id = p.store_id AND m.telegram_id = p.telegram_id
      WHERE ${rejectedWhere.join(' AND ')}
    `, `SELECT COUNT(*) AS total FROM pending_income p WHERE ${rejectedWhere.join(' AND ')}`, rejectedParams, `ORDER BY COALESCE(p.decided_at, p.submitted_at) DESC`, pendingSort);
    const records = await listPagedRows(env, url, 'records_page', 'records', `
      SELECT r.*, p.submitted_at, COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), r.telegram_id) AS display_name, u.username
      FROM income_records r
      LEFT JOIN pending_income p ON p.store_id = r.store_id AND p.request_id = r.request_id
      LEFT JOIN users u ON u.telegram_id = r.telegram_id
      LEFT JOIN store_members m ON m.store_id = r.store_id AND m.telegram_id = r.telegram_id
      WHERE ${recordWhere.join(' AND ')}
    `, `SELECT COUNT(*) AS total FROM income_records r WHERE ${recordWhere.join(' AND ')}`, recordParams, `ORDER BY r.approved_at DESC`, recordSort);
    return json({
      ok: true,
      pending: pending.pending,
      records: records.records,
      rejected: rejected.rejected,
      filters,
      pagination: { pending: pending.pagination, records: records.pagination, rejected: rejected.pagination }
    });
  }
  if (parts.length >= 7 && request.method === 'POST') {
    const requestId = decodeURIComponent(parts[5]);
    if (parts[6] === 'approve') return json(await approveIncomeRequest(env, storeId, requestId, adminId));
    if (parts[6] === 'reject') {
      const body = await readJson(request);
      return json(await rejectIncomeRequest(env, storeId, requestId, adminId, String(body.reason || 'Rejected from admin page')));
    }
  }
  if (parts.length === 7 && request.method === 'PATCH' && parts[5] === 'records') {
    const body = await readJson(request);
    return json(await updateIncomeFineRecord(env, storeId, decodeURIComponent(parts[6]), adminId, body.fine));
  }
  if (parts.length === 7 && request.method === 'DELETE') {
    const kind = parts[5];
    const id = decodeURIComponent(parts[6]);
    if (kind === 'pending') return json(await deletePendingIncome(env, storeId, id, adminId));
    if (kind === 'records') return json(await deleteIncomeRecord(env, storeId, id, adminId));
  }
  return json({ ok: false, error: 'not_found' }, 404);
}

async function handleAdminSalary(request, env, url, storeId, parts, adminId) {
  if (parts.length === 5 && request.method === 'GET') {
    const filters = await adminFilters(env, url, storeId, adminId);
    if (!filters.ok) return json({ ok: false, error: filters.error }, filters.status);
    const requestWhere = [
      `s.store_id IN (${placeholders(filters.storeIds.length)})`,
      `s.status = 'pending'`
    ];
    const requestParams = [...filters.storeIds];
    const rejectedWhere = [
      `s.store_id IN (${placeholders(filters.storeIds.length)})`,
      `s.status = 'rejected'`
    ];
    const rejectedParams = [...filters.storeIds];
    const recordWhere = [
      `r.store_id IN (${placeholders(filters.storeIds.length)})`
    ];
    const recordParams = [...filters.storeIds];
    if (filters.employeeId) {
      requestWhere.push(`s.telegram_id = ?`);
      requestParams.push(filters.employeeId);
      rejectedWhere.push(`s.telegram_id = ?`);
      rejectedParams.push(filters.employeeId);
      recordWhere.push(`r.telegram_id = ?`);
      recordParams.push(filters.employeeId);
    }
    addRangeFilter(requestWhere, requestParams, 's.requested_at', filters.monthStart, filters.monthEnd);
    addRangeFilter(rejectedWhere, rejectedParams, 's.requested_at', filters.monthStart, filters.monthEnd);
    addRangeFilter(recordWhere, recordParams, 'r.approved_at', filters.monthStart, filters.monthEnd);
    const requestSort = {
      ...adminSortColumns(['request_id','store_id','telegram_id','amount_snapshot','status','requested_at','decided_at','admin_id','reject_reason'], 's'),
      display_name: 'display_name',
      username: 'u.username'
    };
    const salaryRecordSort = {
      ...adminSortColumns(['record_id','store_id','telegram_id','amount','period_start','period_end','approved_at','admin_id'], 'r'),
      display_name: 'display_name',
      username: 'u.username'
    };
    const requests = await listPagedRows(env, url, 'requests_page', 'requests', `
      SELECT s.*, COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), s.telegram_id) AS display_name, u.username FROM salary_requests s
      LEFT JOIN users u ON u.telegram_id = s.telegram_id
      LEFT JOIN store_members m ON m.store_id = s.store_id AND m.telegram_id = s.telegram_id
      WHERE ${requestWhere.join(' AND ')}
    `, `SELECT COUNT(*) AS total FROM salary_requests s WHERE ${requestWhere.join(' AND ')}`, requestParams, `ORDER BY s.requested_at DESC`, requestSort);
    const rejected = await listPagedRows(env, url, 'rejected_page', 'rejected', `
      SELECT s.*, COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), s.telegram_id) AS display_name, u.username FROM salary_requests s
      LEFT JOIN users u ON u.telegram_id = s.telegram_id
      LEFT JOIN store_members m ON m.store_id = s.store_id AND m.telegram_id = s.telegram_id
      WHERE ${rejectedWhere.join(' AND ')}
    `, `SELECT COUNT(*) AS total FROM salary_requests s WHERE ${rejectedWhere.join(' AND ')}`, rejectedParams, `ORDER BY COALESCE(s.decided_at, s.requested_at) DESC`, requestSort);
    const records = await listPagedRows(env, url, 'records_page', 'records', `
      SELECT r.*, COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), r.telegram_id) AS display_name, u.username FROM salary_records r
      LEFT JOIN users u ON u.telegram_id = r.telegram_id
      LEFT JOIN store_members m ON m.store_id = r.store_id AND m.telegram_id = r.telegram_id
      WHERE ${recordWhere.join(' AND ')}
    `, `SELECT COUNT(*) AS total FROM salary_records r WHERE ${recordWhere.join(' AND ')}`, recordParams, `ORDER BY r.approved_at DESC`, salaryRecordSort);
    return json({
      ok: true,
      requests: requests.requests,
      records: records.records,
      rejected: rejected.rejected,
      filters,
      pagination: { requests: requests.pagination, records: records.pagination, rejected: rejected.pagination }
    });
  }
  if (parts.length >= 7 && request.method === 'POST') {
    const requestId = decodeURIComponent(parts[5]);
    if (parts[6] === 'approve') return json(await approveSalaryRequest(env, storeId, requestId, adminId));
    if (parts[6] === 'reject') {
      const body = await readJson(request);
      return json(await rejectSalaryRequest(env, storeId, requestId, adminId, String(body.reason || 'Rejected from admin page')));
    }
  }
  return json({ ok: false, error: 'not_found' }, 404);
}

async function handleAdminSalaryAdvances(request, env, url, storeId, parts, adminId) {
  if (parts.length === 5 && request.method === 'GET') {
    const filters = await adminFilters(env, url, storeId, adminId);
    if (!filters.ok) return json({ ok: false, error: filters.error }, filters.status);
    const pendingWhere = [
      `a.store_id IN (${placeholders(filters.storeIds.length)})`,
      `a.status = 'pending'`
    ];
    const pendingParams = [...filters.storeIds];
    const approvedWhere = [
      `a.store_id IN (${placeholders(filters.storeIds.length)})`,
      `a.status = 'approved'`
    ];
    const approvedParams = [...filters.storeIds];
    const rejectedWhere = [
      `a.store_id IN (${placeholders(filters.storeIds.length)})`,
      `a.status = 'rejected'`
    ];
    const rejectedParams = [...filters.storeIds];
    if (filters.employeeId) {
      pendingWhere.push(`a.telegram_id = ?`);
      pendingParams.push(filters.employeeId);
      approvedWhere.push(`a.telegram_id = ?`);
      approvedParams.push(filters.employeeId);
      rejectedWhere.push(`a.telegram_id = ?`);
      rejectedParams.push(filters.employeeId);
    }
    addRangeFilter(pendingWhere, pendingParams, 'a.requested_at', filters.monthStart, filters.monthEnd);
    addRangeFilter(approvedWhere, approvedParams, 'a.decided_at', filters.monthStart, filters.monthEnd);
    addRangeFilter(rejectedWhere, rejectedParams, 'a.requested_at', filters.monthStart, filters.monthEnd);
    const advanceSort = {
      ...adminSortColumns(['request_id','store_id','telegram_id','amount','status','requested_at','decided_at','admin_id','reject_reason'], 'a'),
      display_name: 'display_name',
      username: 'u.username'
    };
    const selectSql = (where) => `
      SELECT a.*, COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), a.telegram_id) AS display_name, u.username
      FROM salary_advance_requests a
      LEFT JOIN users u ON u.telegram_id = a.telegram_id
      LEFT JOIN store_members m ON m.store_id = a.store_id AND m.telegram_id = a.telegram_id
      WHERE ${where.join(' AND ')}
    `;
    const pending = await listPagedRows(env, url, 'pending_page', 'pending', selectSql(pendingWhere), `SELECT COUNT(*) AS total FROM salary_advance_requests a WHERE ${pendingWhere.join(' AND ')}`, pendingParams, `ORDER BY a.requested_at DESC`, advanceSort);
    const approved = await listPagedRows(env, url, 'approved_page', 'approved', selectSql(approvedWhere), `SELECT COUNT(*) AS total FROM salary_advance_requests a WHERE ${approvedWhere.join(' AND ')}`, approvedParams, `ORDER BY a.decided_at DESC`, advanceSort);
    const rejected = await listPagedRows(env, url, 'rejected_page', 'rejected', selectSql(rejectedWhere), `SELECT COUNT(*) AS total FROM salary_advance_requests a WHERE ${rejectedWhere.join(' AND ')}`, rejectedParams, `ORDER BY COALESCE(a.decided_at, a.requested_at) DESC`, advanceSort);
    return json({
      ok: true,
      pending: pending.pending,
      approved: approved.approved,
      rejected: rejected.rejected,
      filters,
      pagination: { pending: pending.pagination, approved: approved.pagination, rejected: rejected.pagination }
    });
  }
  if (parts.length >= 7 && request.method === 'POST') {
    const requestId = decodeURIComponent(parts[5]);
    if (parts[6] === 'approve') return json(await approveSalaryAdvanceRequest(env, storeId, requestId, adminId));
    if (parts[6] === 'reject') {
      const body = await readJson(request);
      return json(await rejectSalaryAdvanceRequest(env, storeId, requestId, adminId, String(body.reason || 'Rejected from admin page')));
    }
  }
  return json({ ok: false, error: 'not_found' }, 404);
}

async function handleAdminAttendance(request, env, url, storeId, parts, adminId) {
  if (parts.length === 5 && request.method === 'GET') {
    const filters = await adminFilters(env, url, storeId, adminId);
    if (!filters.ok) return json({ ok: false, error: filters.error }, filters.status);
    const employeeStats = await attendanceEmployeeStats(env, filters);
    const pendingWhere = [
      `p.store_id IN (${placeholders(filters.storeIds.length)})`,
      `p.status = 'pending'`
    ];
    const pendingParams = [...filters.storeIds];
    const approvedWhere = [`a.store_id IN (${placeholders(filters.storeIds.length)})`];
    const approvedParams = [...filters.storeIds];
    const rejectedWhere = [
      `p.store_id IN (${placeholders(filters.storeIds.length)})`,
      `p.status = 'rejected'`
    ];
    const rejectedParams = [...filters.storeIds];
    if (filters.employeeId) {
      pendingWhere.push(`p.telegram_id = ?`);
      pendingParams.push(filters.employeeId);
      approvedWhere.push(`a.telegram_id = ?`);
      approvedParams.push(filters.employeeId);
      rejectedWhere.push(`p.telegram_id = ?`);
      rejectedParams.push(filters.employeeId);
    }
    addRangeFilter(pendingWhere, pendingParams, 'p.business_date', filters.monthDateStart, filters.monthDateEnd);
    addRangeFilter(approvedWhere, approvedParams, 'a.business_date', filters.monthDateStart, filters.monthDateEnd);
    addRangeFilter(rejectedWhere, rejectedParams, 'p.business_date', filters.monthDateStart, filters.monthDateEnd);
    const pendingSelect = (where) => `
      SELECT p.*, COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), p.telegram_id) AS display_name, u.username
      FROM pending_checkout_requests p
      LEFT JOIN users u ON u.telegram_id = p.telegram_id
      LEFT JOIN store_members m ON m.store_id = p.store_id AND m.telegram_id = p.telegram_id
      WHERE ${where.join(' AND ')}
    `;
    const pendingSort = {
      ...adminSortColumns(['request_id','store_id','telegram_id','business_date','timestamp','early_leave','fine','original_fine','status','submitted_at','decided_at','admin_id','reject_reason'], 'p'),
      display_name: 'display_name',
      username: 'u.username'
    };
    const approvedSort = {
      ...adminSortColumns(['record_id','store_id','telegram_id','business_date','type','timestamp','late','early_leave','fine','original_fine'], 'a'),
      display_name: 'display_name',
      username: 'u.username'
    };
    const approved = await listPagedRows(env, url, 'approved_page', 'approved', `
      SELECT
        a.*,
        COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), a.telegram_id) AS display_name,
        u.username
      FROM attendance_records a
      LEFT JOIN users u ON u.telegram_id = a.telegram_id
      LEFT JOIN store_members m ON m.store_id = a.store_id AND m.telegram_id = a.telegram_id
      WHERE ${approvedWhere.join(' AND ')}
    `, `SELECT COUNT(*) AS total FROM attendance_records a WHERE ${approvedWhere.join(' AND ')}`, approvedParams, `ORDER BY a.timestamp DESC`, approvedSort);
    const pending = await listPagedRows(env, url, 'pending_page', 'pending', pendingSelect(pendingWhere), `SELECT COUNT(*) AS total FROM pending_checkout_requests p WHERE ${pendingWhere.join(' AND ')}`, pendingParams, `ORDER BY p.submitted_at DESC`, pendingSort);
    const rejected = await listPagedRows(env, url, 'rejected_page', 'rejected', pendingSelect(rejectedWhere), `SELECT COUNT(*) AS total FROM pending_checkout_requests p WHERE ${rejectedWhere.join(' AND ')}`, rejectedParams, `ORDER BY COALESCE(p.decided_at, p.submitted_at) DESC`, pendingSort);
    return json({
      ok: true,
      pending: pending.pending,
      approved: approved.approved,
      rejected: rejected.rejected,
      employee_stats: employeeStats,
      summary: sumAttendanceEmployeeStats(employeeStats),
      filters,
      pagination: { pending: pending.pagination, approved: approved.pagination, rejected: rejected.pagination }
    });
  }
  if (parts.length >= 7 && request.method === 'POST') {
    const requestId = decodeURIComponent(parts[5]);
    if (parts[6] === 'approve' || parts[6] === 'approve_fine' || parts[6] === 'approve_no_fine') {
      const result = await approveCheckoutRequest(env, storeId, requestId, adminId, parts[6] !== 'approve_no_fine');
      if (result.ok) {
        const empLang = await getUserLang(env, result.row.telegram_id);
        const time = localTime(new Date(result.row.timestamp), result.store.timezone);
        const extra = result.row.early_leave
          ? render(empLang, result.waivedFine ? 'early_waived' : 'early', { fine: formatMoney(result.store, result.row.fine) })
          : t(empLang, 'ontime');
        await sendMessage(env, result.row.telegram_id, render(empLang, 'checkout_done', { date: result.row.business_date, time, extra }));
      }
      return json(result);
    }
    if (parts[6] === 'reject') {
      const body = await readJson(request);
      const result = await rejectCheckoutRequest(env, storeId, requestId, adminId, String(body.reason || 'Rejected from admin page'));
      if (result.ok) {
        const empLang = await getUserLang(env, result.row.telegram_id);
        await sendMessage(env, result.row.telegram_id, render(empLang, 'checkout_rejected', { date: result.row.business_date, reason: result.reason }));
      }
      return json(result);
    }
  }
  return json({ ok: false, error: 'not_found' }, 404);
}

export async function attendanceEmployeeStats(env, filters, now = new Date()) {
  const stores = await env.DB.prepare(`
    SELECT store_id, name, timezone, currency
    FROM stores
    WHERE store_id IN (${placeholders(filters.storeIds.length)})
  `).bind(...filters.storeIds).all();
  const storesById = new Map((stores.results || []).map((store) => [store.store_id, store]));
  const employeeStats = [];

  for (const storeId of filters.storeIds) {
    const store = storesById.get(storeId);
    if (!store) continue;
    const timezone = store.timezone || 'Asia/Tokyo';
    const completedDate = completedAttendanceDate(now, timezone);
    const selectedEnd = filters.monthDateEnd ? addIsoDays(filters.monthDateEnd, -1) : completedDate;
    const endDate = selectedEnd < completedDate ? selectedEnd : completedDate;
    const queryStart = filters.monthDateStart || '0000-01-01';
    const memberWhere = [
      `m.store_id = (SELECT store_id FROM target)`,
      `m.status = 'active'`,
      `((SELECT employee_id FROM target) = '' OR m.telegram_id = (SELECT employee_id FROM target))`
    ];
    const params = [storeId, queryStart, endDate, filters.employeeId || ''];
    const rows = await env.DB.prepare(`
      WITH target AS (
        SELECT ? AS store_id, ? AS start_date, ? AS end_date, ? AS employee_id
      ), attendance_events AS (
        SELECT a.store_id, a.telegram_id, a.business_date, 'work' AS event_kind, 0 AS fine
        FROM attendance_records a, target t
        WHERE a.store_id = t.store_id AND a.business_date BETWEEN t.start_date AND t.end_date
          AND (t.employee_id = '' OR a.telegram_id = t.employee_id)
          AND a.type = 'checkin'
        UNION ALL
        SELECT a.store_id, a.telegram_id, a.business_date, 'late' AS event_kind, 0 AS fine
        FROM attendance_records a, target t
        WHERE a.store_id = t.store_id AND a.business_date BETWEEN t.start_date AND t.end_date
          AND (t.employee_id = '' OR a.telegram_id = t.employee_id)
          AND a.type = 'checkin' AND a.late = 1
      ), leave_events AS (
        SELECT l.store_id, l.telegram_id, l.leave_date AS business_date, 'leave' AS event_kind, 0 AS fine
        FROM leave_requests l, target t
        WHERE l.store_id = t.store_id AND l.leave_date BETWEEN t.start_date AND t.end_date
          AND (t.employee_id = '' OR l.telegram_id = t.employee_id)
          AND l.status = 'approved'
      ), attendance_fines AS (
        SELECT i.store_id, i.telegram_id, a.business_date, 'fine' AS event_kind, i.fine
        FROM income_records i
        JOIN target t ON t.store_id = i.store_id
        JOIN attendance_records a
          ON a.store_id = i.store_id
         AND a.telegram_id = i.telegram_id
         AND a.record_id = i.request_id
         AND a.business_date BETWEEN t.start_date AND t.end_date
         AND ((i.source = 'attendance_late' AND a.type = 'checkin')
           OR (i.source = 'attendance_early' AND a.type = 'checkout'))
        WHERE t.employee_id = '' OR i.telegram_id = t.employee_id
      ), absence_fines AS (
        SELECT i.store_id, i.telegram_id, r.business_date, 'fine' AS event_kind, i.fine
        FROM income_records i
        JOIN target t ON t.store_id = i.store_id
        JOIN absence_fine_requests r
          ON r.store_id = i.store_id
         AND r.telegram_id = i.telegram_id
         AND r.request_id = i.request_id
         AND r.business_date BETWEEN t.start_date AND t.end_date
        WHERE i.source = 'attendance_absence'
          AND (t.employee_id = '' OR i.telegram_id = t.employee_id)
      ), events AS (
        SELECT * FROM attendance_events
        UNION ALL SELECT * FROM leave_events
        UNION ALL SELECT * FROM attendance_fines
        UNION ALL SELECT * FROM absence_fines
      )
      SELECT
        m.store_id,
        s.name AS store_name,
        m.telegram_id,
        COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), m.telegram_id) AS display_name,
        m.joined_at,
        m.absence_check_enabled,
        m.absence_check_enabled_at,
        e.business_date,
        e.event_kind,
        e.fine
      FROM store_members m
      JOIN stores s ON s.store_id = m.store_id
      LEFT JOIN users u ON u.telegram_id = m.telegram_id
      LEFT JOIN events e
        ON e.store_id = m.store_id
       AND e.telegram_id = m.telegram_id
      WHERE ${memberWhere.join(' AND ')}
      ORDER BY display_name, m.telegram_id, e.business_date
    `).bind(...params).all();

    const members = new Map();
    for (const row of rows.results || []) {
      let member = members.get(row.telegram_id);
      if (!member) {
        const joinedDate = localDate(new Date(row.joined_at), timezone);
        const startDate = filters.monthDateStart && filters.monthDateStart > joinedDate
          ? filters.monthDateStart
          : joinedDate;
        const enabledDate = row.absence_check_enabled_at
          ? localDate(new Date(row.absence_check_enabled_at), timezone)
          : startDate;
        member = {
          row: {
            store_id: row.store_id,
            store_name: row.store_name,
            currency: store.currency || '',
            telegram_id: row.telegram_id,
            display_name: row.display_name,
            work_days: 0,
            late_days: 0,
            absence_days: 0,
            leave_days: 0,
            fine_total: 0
          },
          startDate,
          absenceStartDate: Number(row.absence_check_enabled) === 1
            ? (enabledDate > startDate ? enabledDate : startDate)
            : null,
          workDates: new Set(),
          lateDates: new Set(),
          leaveDates: new Set()
        };
        members.set(row.telegram_id, member);
      }
      if (!row.business_date || row.business_date < member.startDate || row.business_date > endDate) continue;
      if (row.event_kind === 'work') member.workDates.add(row.business_date);
      if (row.event_kind === 'late') member.lateDates.add(row.business_date);
      if (row.event_kind === 'leave') member.leaveDates.add(row.business_date);
      if (row.event_kind === 'fine') member.row.fine_total += Number(row.fine || 0);
    }

    for (const member of members.values()) {
      if (member.startDate <= endDate) {
        member.row.work_days = member.workDates.size;
        member.row.late_days = member.lateDates.size;
        member.row.leave_days = member.leaveDates.size;
        if (member.absenceStartDate && member.absenceStartDate <= endDate) {
          const attendedOrLeave = new Set(
            [...member.workDates, ...member.leaveDates]
              .filter((businessDate) => businessDate >= member.absenceStartDate)
          );
          const eligibleDays = Math.floor(
            (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${member.absenceStartDate}T00:00:00Z`)) / 86400000
          ) + 1;
          member.row.absence_days = eligibleDays - attendedOrLeave.size;
        }
      }
      employeeStats.push(member.row);
    }
  }

  return employeeStats;
}

async function handleAdminLeave(request, env, url, storeId, parts, adminId) {
  if (parts.length === 5 && request.method === 'GET') {
    const filters = await adminFilters(env, url, storeId, adminId);
    if (!filters.ok) return json({ ok: false, error: filters.error }, filters.status);
    const pendingWhere = [
      `l.store_id IN (${placeholders(filters.storeIds.length)})`,
      `l.status = 'pending'`
    ];
    const pendingParams = [...filters.storeIds];
    const approvedWhere = [
      `l.store_id IN (${placeholders(filters.storeIds.length)})`,
      `l.status = 'approved'`
    ];
    const approvedParams = [...filters.storeIds];
    const rejectedWhere = [
      `l.store_id IN (${placeholders(filters.storeIds.length)})`,
      `l.status = 'rejected'`
    ];
    const rejectedParams = [...filters.storeIds];
    if (filters.employeeId) {
      pendingWhere.push(`l.telegram_id = ?`);
      pendingParams.push(filters.employeeId);
      approvedWhere.push(`l.telegram_id = ?`);
      approvedParams.push(filters.employeeId);
      rejectedWhere.push(`l.telegram_id = ?`);
      rejectedParams.push(filters.employeeId);
    }
    addRangeFilter(pendingWhere, pendingParams, 'l.leave_date', filters.monthDateStart, filters.monthDateEnd);
    addRangeFilter(approvedWhere, approvedParams, 'l.leave_date', filters.monthDateStart, filters.monthDateEnd);
    addRangeFilter(rejectedWhere, rejectedParams, 'l.leave_date', filters.monthDateStart, filters.monthDateEnd);
    const selectSql = (where) => `
      SELECT l.*, COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), l.telegram_id) AS display_name, u.username
      FROM leave_requests l
      LEFT JOIN users u ON u.telegram_id = l.telegram_id
      LEFT JOIN store_members m ON m.store_id = l.store_id AND m.telegram_id = l.telegram_id
      WHERE ${where.join(' AND ')}
    `;
    const leaveSort = {
      ...adminSortColumns(['request_id','store_id','telegram_id','leave_date','status','requested_at','decided_at','admin_id','reject_reason'], 'l'),
      display_name: 'display_name',
      username: 'u.username'
    };
    const pending = await listPagedRows(env, url, 'pending_page', 'pending', selectSql(pendingWhere), `SELECT COUNT(*) AS total FROM leave_requests l WHERE ${pendingWhere.join(' AND ')}`, pendingParams, `ORDER BY l.requested_at DESC`, leaveSort);
    const approved = await listPagedRows(env, url, 'approved_page', 'approved', selectSql(approvedWhere), `SELECT COUNT(*) AS total FROM leave_requests l WHERE ${approvedWhere.join(' AND ')}`, approvedParams, `ORDER BY l.leave_date DESC`, leaveSort);
    const rejected = await listPagedRows(env, url, 'rejected_page', 'rejected', selectSql(rejectedWhere), `SELECT COUNT(*) AS total FROM leave_requests l WHERE ${rejectedWhere.join(' AND ')}`, rejectedParams, `ORDER BY COALESCE(l.decided_at, l.requested_at) DESC`, leaveSort);
    return json({
      ok: true,
      pending: pending.pending,
      approved: approved.approved,
      rejected: rejected.rejected,
      filters,
      pagination: { pending: pending.pagination, approved: approved.pagination, rejected: rejected.pagination }
    });
  }
  if (parts.length >= 7 && request.method === 'POST') {
    const requestId = decodeURIComponent(parts[5]);
    if (parts[6] === 'approve') {
      const result = await approveLeaveRequest(env, storeId, requestId, adminId);
      if (result.ok) {
        const empLang = await getUserLang(env, result.row.telegram_id);
        await sendMessage(env, result.row.telegram_id, render(empLang, 'leave_approved', { date: result.row.leave_date }));
      }
      return json(result);
    }
    if (parts[6] === 'reject') {
      const body = await readJson(request);
      const result = await rejectLeaveRequest(env, storeId, requestId, adminId, String(body.reason || 'Rejected from admin page'));
      if (result.ok) {
        const empLang = await getUserLang(env, result.row.telegram_id);
        await sendMessage(env, result.row.telegram_id, render(empLang, 'leave_rejected', { date: result.row.leave_date, reason: result.reason }));
      }
      return json(result);
    }
  }
  return json({ ok: false, error: 'not_found' }, 404);
}

async function handleAdminAbsence(request, env, url, storeId, parts, adminId) {
  if (parts.length === 5 && request.method === 'GET') {
    const filters = await adminFilters(env, url, storeId, adminId);
    if (!filters.ok) return json({ ok: false, error: filters.error }, filters.status);

    const storeWhere = adminStoreWhere('r', filters.storeIds);
    const baseWhere = [storeWhere.sql];
    const baseParams = [...storeWhere.params];
    if (filters.employeeId) {
      baseWhere.push(`r.telegram_id = ?`);
      baseParams.push(filters.employeeId);
    }
    addRangeFilter(baseWhere, baseParams, 'r.business_date', filters.monthDateStart, filters.monthDateEnd);
    const status = String(url.searchParams.get('status') || '').trim();
    if (['pending', 'approved', 'rejected', 'cancelled'].includes(status)) {
      baseWhere.push(`r.status = ?`);
      baseParams.push(status);
    }

    const pendingWhere = [...baseWhere, `r.status = 'pending'`];
    const historyWhere = [...baseWhere, `r.status <> 'pending'`];
    const selectSql = (where) => `
      WITH notification AS (
        SELECT
          request_id,
          COUNT(*) AS notification_total,
          SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent_total,
          MAX(attempts) AS notification_attempts,
          MAX(last_error) AS notification_last_error
        FROM absence_fine_notifications
        GROUP BY request_id
      )
      SELECT
        r.*,
        s.name AS store_name,
        s.currency,
        s.timezone,
        COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), r.telegram_id) AS display_name,
        u.username,
        i.fine AS actual_fine,
        COALESCE(i.fine, r.fine) AS current_fine,
        CASE
          WHEN n.request_id IS NULL THEN 'not_queued'
          WHEN n.sent_total = n.notification_total THEN 'sent'
          ELSE 'retrying'
        END AS notification_status,
        COALESCE(n.sent_total, 0) AS notification_sent_total,
        COALESCE(n.notification_total, 0) AS notification_total,
        COALESCE(n.notification_attempts, 0) AS notification_attempts,
        n.notification_last_error
      FROM absence_fine_requests r
      JOIN stores s ON s.store_id = r.store_id
      LEFT JOIN users u ON u.telegram_id = r.telegram_id
      LEFT JOIN store_members m ON m.store_id = r.store_id AND m.telegram_id = r.telegram_id
      LEFT JOIN income_records i
        ON i.record_id = r.income_record_id
       AND i.source = 'attendance_absence'
      LEFT JOIN notification n ON n.request_id = r.request_id
      WHERE ${where.join(' AND ')}
    `;
    const absenceSort = absenceAdminSortColumns();
    const pending = await listPagedRows(
      env, url, 'pending_page', 'pending', selectSql(pendingWhere),
      `SELECT COUNT(*) AS total FROM absence_fine_requests r WHERE ${pendingWhere.join(' AND ')}`,
      baseParams, `ORDER BY r.business_date DESC, r.created_at DESC, r.request_id DESC`, absenceSort, `r.request_id DESC`
    );
    const history = await listPagedRows(
      env, url, 'history_page', 'history', selectSql(historyWhere),
      `SELECT COUNT(*) AS total FROM absence_fine_requests r WHERE ${historyWhere.join(' AND ')}`,
      baseParams, `ORDER BY COALESCE(r.decided_at, r.created_at) DESC, r.request_id DESC`, absenceSort, `r.request_id DESC`
    );
    const statusRows = await env.DB.prepare(`
      SELECT r.status, COUNT(*) AS total
      FROM absence_fine_requests r
      WHERE ${baseWhere.join(' AND ')}
      GROUP BY r.status
    `).bind(...baseParams).all();
    const fineRows = await env.DB.prepare(`
      SELECT s.currency, SUM(i.fine) AS amount
      FROM absence_fine_requests r
      JOIN stores s ON s.store_id = r.store_id
      JOIN income_records i
        ON i.record_id = r.income_record_id
       AND i.source = 'attendance_absence'
      WHERE ${baseWhere.join(' AND ')} AND r.status = 'approved'
      GROUP BY s.currency
      ORDER BY s.currency
    `).bind(...baseParams).all();
    const notificationRows = await env.DB.prepare(`
      WITH notification AS (
        SELECT request_id, COUNT(*) AS notification_total,
          SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent_total
        FROM absence_fine_notifications
        GROUP BY request_id
      )
      SELECT
        CASE
          WHEN n.request_id IS NULL THEN 'not_queued'
          WHEN n.sent_total = n.notification_total THEN 'sent'
          ELSE 'retrying'
        END AS status,
        COUNT(*) AS total
      FROM absence_fine_requests r
      LEFT JOIN notification n ON n.request_id = r.request_id
      WHERE ${pendingWhere.join(' AND ')}
      GROUP BY 1
    `).bind(...baseParams).all();
    const statusCounts = Object.fromEntries(
      (statusRows.results || []).map((row) => [row.status, Number(row.total)])
    );
    const notificationCounts = Object.fromEntries(
      (notificationRows.results || []).map((row) => [row.status, Number(row.total)])
    );
    return json({
      ok: true,
      pending: pending.pending,
      history: history.history,
      summary: {
        status_counts: statusCounts,
        fine_totals: (fineRows.results || []).map((row) => ({
          currency: row.currency,
          amount: Number(row.amount || 0)
        })),
        notification_counts: notificationCounts
      },
      filters: { ...filters, status },
      pagination: { pending: pending.pagination, history: history.pagination }
    });
  }
  if (parts.length === 7 && request.method === 'POST') {
    const requestId = decodeURIComponent(parts[5]);
    const found = await env.DB.prepare(`
      SELECT status FROM absence_fine_requests WHERE request_id = ? AND store_id = ?
    `).bind(requestId, storeId).first();
    if (!found) return json({ ok: false, error: 'not_found' }, 404);
    if (found.status !== 'pending') return json({ ok: false, error: 'already_decided' }, 409);

    if (parts[6] === 'approve') {
      const result = await approveAbsenceFineRequest(env, requestId, adminId, storeId);
      return result.ok
        ? json(result)
        : json({ ...result, error: 'already_decided' }, 409);
    }
    if (parts[6] === 'reject') {
      const body = await readJson(request);
      const reason = body && typeof body === 'object' && !Array.isArray(body) && typeof body.reason === 'string'
        ? body.reason.trim()
        : '';
      if (!reason) {
        return json({ ok: false, error: 'rejection_reason_required' }, 400);
      }
      const result = await rejectAbsenceFineRequest(env, requestId, adminId, reason, storeId);
      return result.ok
        ? json(result)
        : json({ ...result, error: 'already_decided' }, 409);
    }
  }
  return json({ ok: false, error: 'not_found' }, 404);
}

async function exportCsv(env, url, storeId, type, adminId) {
  const filters = await adminFilters(env, url, storeId, adminId);
  if (!filters.ok) return json({ ok: false, error: filters.error }, filters.status);
  const storeWhere = `store_id IN (${placeholders(filters.storeIds.length)})`;
  const memberStoreWhere = adminStoreWhere('m', filters.storeIds);
  const map = {
    'members.csv': [`SELECT m.store_id, m.telegram_id, COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), m.telegram_id) AS display_name, u.name AS telegram_name, u.username, m.role, m.status, m.commission_rate, m.cycle_start, m.joined_at, m.updated_at FROM store_members m LEFT JOIN users u ON u.telegram_id = m.telegram_id WHERE ${memberStoreWhere.sql}`, memberStoreWhere.params],
    'income.csv': exportSql(`SELECT * FROM income_records WHERE ${storeWhere}`, [...filters.storeIds], filters, 'approved_at', false, 'ORDER BY approved_at DESC'),
    'salary.csv': exportSql(`SELECT * FROM salary_records WHERE ${storeWhere}`, [...filters.storeIds], filters, 'approved_at', false, 'ORDER BY approved_at DESC'),
    'advances.csv': exportSql(`SELECT * FROM salary_advance_requests WHERE ${storeWhere}`, [...filters.storeIds], filters, 'requested_at', false, 'ORDER BY requested_at DESC'),
    'attendance.csv': exportSql(`SELECT * FROM attendance_records WHERE ${storeWhere}`, [...filters.storeIds], filters, 'business_date', true, 'ORDER BY timestamp DESC'),
    'leave.csv': exportSql(`SELECT * FROM leave_requests WHERE ${storeWhere}`, [...filters.storeIds], filters, 'leave_date', true, 'ORDER BY leave_date DESC, requested_at DESC')
  };
  const item = map[type];
  if (!item) return json({ ok: false, error: 'unknown_export' }, 404);
  const rows = await env.DB.prepare(item[0]).bind(...item[1]).all();
  return new Response(toCsv(rows.results || []), { headers: CSV_HEADERS });
}

async function listRows(env, sql, params, key = 'rows') {
  const rows = await env.DB.prepare(sql).bind(...params).all();
  return json({ ok: true, [key]: rows.results || [] });
}

async function listPagedRows(env, url, pageParam, rowsKey, selectSql, countSql, params, orderSql, sortColumns, tieBreakerSql = '') {
  const totalRow = await env.DB.prepare(countSql).bind(...params).first();
  const pagination = adminPage(url.searchParams.get(pageParam), Number(totalRow && totalRow.total ? totalRow.total : 0));
  const rows = await env.DB.prepare(`${selectSql} ${adminOrderSql(url, pageParam, sortColumns, orderSql, tieBreakerSql)} LIMIT ? OFFSET ?`)
    .bind(...params, pagination.limit, pagination.offset)
    .all();
  return { [rowsKey]: rows.results || [], pagination };
}

async function adminFilters(env, url, fallbackStoreId, adminId) {
  const requestedStoreIds = String(url.searchParams.get('stores') || fallbackStoreId)
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const storeIds = Array.from(new Set(requestedStoreIds.length ? requestedStoreIds : [fallbackStoreId]));
  for (const id of storeIds) {
    if (!(await isStoreAdmin(env, adminId, id))) {
      return { ok: false, error: 'forbidden_store', status: 403 };
    }
  }

  const employeeRaw = String(url.searchParams.get('employee') || '').trim();
  const employeeId = employeeRaw && employeeRaw !== 'all' ? employeeRaw : '';
  const hasDateFilter = url.searchParams.has('date_from') || url.searchParams.has('date_to');
  const dateFrom = String(url.searchParams.get('date_from') || '').trim();
  const dateTo = String(url.searchParams.get('date_to') || '').trim();
  const store = await getStore(env, fallbackStoreId);
  const range = hasDateFilter ? dateRange(dateFrom, dateTo, store && store.timezone) : legacyMonthRange(url);
  return {
    ok: true,
    storeIds,
    employeeId,
    monthFrom: dateFrom,
    monthTo: dateTo,
    monthStart: range ? range.startIso : '',
    monthEnd: range ? range.endIso : '',
    monthDateStart: range ? range.startDate : '',
    monthDateEnd: range ? range.endDate : ''
  };
}

function exportSql(baseSql, params, filters, dateColumn, dateOnly, orderSql) {
  const where = [];
  const nextParams = [...params];
  if (filters.employeeId) {
    where.push('telegram_id = ?');
    nextParams.push(filters.employeeId);
  }
  addRangeFilter(
    where,
    nextParams,
    dateColumn,
    dateOnly ? filters.monthDateStart : filters.monthStart,
    dateOnly ? filters.monthDateEnd : filters.monthEnd
  );
  return [`${baseSql}${where.length ? ` AND ${where.join(' AND ')}` : ''} ${orderSql}`, nextParams];
}

function legacyMonthRange(url) {
  const legacyMonth = String(url.searchParams.get('month') || '').trim();
  const monthFrom = String(url.searchParams.get('month_from') || legacyMonth).trim();
  const monthTo = String(url.searchParams.get('month_to') || legacyMonth || monthFrom).trim();
  return monthRange(monthFrom, monthTo);
}

function parseMonth(month) {
  const match = /^(\d{4})-(\d{2})$/.exec(month || '');
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return null;
  return { year, monthIndex };
}

function monthRange(monthFrom, monthTo) {
  const from = parseMonth(monthFrom);
  const to = parseMonth(monthTo || monthFrom);
  if (!from && !to) return null;
  let startMonth = from || to;
  let endMonth = to || from;
  const startValue = startMonth.year * 12 + startMonth.monthIndex;
  const endValue = endMonth.year * 12 + endMonth.monthIndex;
  if (startValue > endValue) {
    const temp = startMonth;
    startMonth = endMonth;
    endMonth = temp;
  }
  const start = new Date(Date.UTC(startMonth.year, startMonth.monthIndex, 1));
  const end = new Date(Date.UTC(endMonth.year, endMonth.monthIndex + 1, 1));
  return {
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10)
  };
}

async function notifyStoreAdmins(env, storeId, text, replyMarkup) {
  const rows = await env.DB.prepare(`
    SELECT telegram_id FROM store_members
    WHERE store_id = ? AND status = 'active' AND role IN ('admin', 'owner')
  `).bind(storeId).all();
  const ids = new Set([...(rows.results || []).map((row) => String(row.telegram_id)), ...adminIds(env)]);
  for (const adminId of ids) {
    await sendMessage(env, adminId, text, replyMarkup);
  }
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
      [{ text: t(lang, 'btn_salary') }, { text: t(lang, 'btn_advance') }],
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

function makeNumericCode() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const value = ((bytes[0] << 24) >>> 0) + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3];
  return String(value % 1000000).padStart(6, '0');
}

export async function processAbsenceFines(env, now = new Date()) {
  const stores = await env.DB.prepare(`
    SELECT * FROM stores
    WHERE status = 'active' AND absence_fine_enabled_at IS NOT NULL
  `).all();

  for (const store of stores.results || []) {
    const timezone = store.timezone || 'Asia/Tokyo';
    for (const businessDate of absenceScanDates(store, now)) {
      const candidates = await env.DB.prepare(`
        SELECT m.telegram_id,
               m.joined_at,
               m.absence_check_enabled_at,
               COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), m.telegram_id) AS display_name
        FROM store_members m
        LEFT JOIN users u ON u.telegram_id = m.telegram_id
        WHERE m.store_id = ?
          AND m.status = 'active'
          AND m.role = 'employee'
          AND m.absence_check_enabled = 1
          AND NOT EXISTS (
            SELECT 1 FROM attendance_records a
            WHERE a.store_id = m.store_id
              AND a.telegram_id = m.telegram_id
              AND a.business_date = ?
              AND a.type = 'checkin'
          )
          AND NOT EXISTS (
            SELECT 1 FROM leave_requests l
            WHERE l.store_id = m.store_id
              AND l.telegram_id = m.telegram_id
              AND l.leave_date = ?
              AND l.status = 'approved'
          )
      `).bind(store.store_id, businessDate, businessDate).all();

      for (const member of candidates.results || []) {
        if (localDate(new Date(member.joined_at), timezone) > businessDate) continue;
        if (member.absence_check_enabled_at
          && localDate(new Date(member.absence_check_enabled_at), timezone) > businessDate) continue;
        const fine = attendanceFineAmount(store, store.absence_fine);
        const nextBusinessDate = zonedMidnightIso(addIsoDays(businessDate, 1), timezone);
        await env.DB.prepare(`
          INSERT OR IGNORE INTO absence_fine_requests
            (request_id, store_id, telegram_id, business_date, original_fine, fine, status, created_at)
          SELECT ?, ?, ?, ?, ?, ?, 'pending', ?
          FROM store_members m
          WHERE m.store_id = ? AND m.telegram_id = ?
            AND m.status = 'active' AND m.role = 'employee'
            AND m.absence_check_enabled = 1
            AND m.joined_at < ?
            AND m.absence_check_enabled_at IS NOT NULL
            AND m.absence_check_enabled_at < ?
            AND NOT EXISTS (
              SELECT 1 FROM attendance_records a
              WHERE a.store_id = m.store_id
                AND a.telegram_id = m.telegram_id
                AND a.business_date = ? AND a.type = 'checkin'
            )
            AND NOT EXISTS (
              SELECT 1 FROM leave_requests l
              WHERE l.store_id = m.store_id
                AND l.telegram_id = m.telegram_id
                AND l.leave_date = ? AND l.status = 'approved'
            )
        `).bind(
          makeId('ABS'), store.store_id, member.telegram_id, businessDate, fine, fine, now.toISOString(),
          store.store_id, member.telegram_id, nextBusinessDate, nextBusinessDate, businessDate, businessDate
        ).run();
      }

      await env.DB.prepare(`
        UPDATE stores SET absence_last_checked_date = ?, updated_at = ? WHERE store_id = ?
      `).bind(businessDate, now.toISOString(), store.store_id).run();
      store.absence_last_checked_date = businessDate;
    }

    const requests = await env.DB.prepare(`
      SELECT r.*,
             COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), r.telegram_id) AS display_name
      FROM absence_fine_requests r
      LEFT JOIN store_members m ON m.store_id = r.store_id AND m.telegram_id = r.telegram_id
      LEFT JOIN users u ON u.telegram_id = r.telegram_id
      WHERE r.store_id = ? AND r.status = 'pending'
      ORDER BY r.business_date, r.created_at
    `).bind(store.store_id).all();

    const adminRows = await env.DB.prepare(`
      SELECT telegram_id FROM store_members
      WHERE store_id = ? AND status = 'active' AND role IN ('admin', 'owner')
    `).bind(store.store_id).all();
    const admins = new Set([...(adminRows.results || []).map((row) => String(row.telegram_id)), ...adminIds(env)]);
    for (const request of requests.results || []) {
      for (const adminId of admins) {
        await env.DB.prepare(`
          INSERT OR IGNORE INTO absence_fine_notifications (request_id, admin_id)
          SELECT ?, ?
          WHERE EXISTS (
            SELECT 1
            FROM absence_fine_requests r
            JOIN store_members m
              ON m.store_id = r.store_id AND m.telegram_id = r.telegram_id
            WHERE r.request_id = ? AND r.status = 'pending'
              AND m.status = 'active' AND m.role = 'employee'
              AND m.absence_check_enabled = 1
          )
        `).bind(request.request_id, adminId, request.request_id).run();
      }
    }

    const staleClaim = new Date(now.getTime() - 15 * 60 * 1000).toISOString();
    const notifications = await env.DB.prepare(`
      SELECT n.*, r.store_id, r.telegram_id, r.business_date, r.fine,
             COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), r.telegram_id) AS display_name
      FROM absence_fine_notifications n
      JOIN absence_fine_requests r ON r.request_id = n.request_id
      LEFT JOIN store_members m ON m.store_id = r.store_id AND m.telegram_id = r.telegram_id
      LEFT JOIN users u ON u.telegram_id = r.telegram_id
      WHERE r.store_id = ? AND r.status = 'pending'
        AND (n.status = 'pending' OR (n.status = 'sending' AND n.claimed_at < ?))
      ORDER BY r.business_date, r.created_at, n.admin_id
    `).bind(store.store_id, staleClaim).all();
    for (const notification of notifications.results || []) {
      await deliverAbsenceNotification(env, store, notification, now);
    }
  }
}

export async function deliverAbsenceNotification(env, store, notification, now = new Date()) {
  if (!(await isStoreAdmin(env, notification.admin_id, notification.store_id))) {
    await cancelAbsenceNotification(env, notification, 'admin_access_revoked');
    return false;
  }
  const claimedAt = now.toISOString();
  const staleClaim = new Date(now.getTime() - 15 * 60 * 1000).toISOString();
  const claim = await env.DB.prepare(`
    UPDATE absence_fine_notifications
    SET status = 'sending', attempts = attempts + 1, claimed_at = ?, last_error = NULL
    WHERE request_id = ? AND admin_id = ?
      AND (status = 'pending' OR (status = 'sending' AND claimed_at < ?))
      AND EXISTS (
        SELECT 1 FROM absence_fine_requests r
        WHERE r.request_id = absence_fine_notifications.request_id
          AND r.store_id = ? AND r.status = 'pending'
      )
  `).bind(claimedAt, notification.request_id, notification.admin_id, staleClaim, notification.store_id).run();
  if (mutationCount(claim) !== 1) {
    await env.DB.prepare(`
      UPDATE absence_fine_notifications
      SET status = 'cancelled', claimed_at = NULL, last_error = 'absence_request_not_pending'
      WHERE request_id = ? AND admin_id = ? AND status != 'sent'
        AND NOT EXISTS (
          SELECT 1 FROM absence_fine_requests r
          WHERE r.request_id = absence_fine_notifications.request_id
            AND r.store_id = ? AND r.status = 'pending'
        )
    `).bind(notification.request_id, notification.admin_id, notification.store_id).run();
    return false;
  }
  if (!(await isStoreAdmin(env, notification.admin_id, notification.store_id))) {
    await cancelAbsenceNotification(env, notification, 'admin_access_revoked');
    return false;
  }

  const sendable = await env.DB.prepare(`
    SELECT 1
    FROM absence_fine_notifications n
    JOIN absence_fine_requests r ON r.request_id = n.request_id
    JOIN store_members m ON m.store_id = r.store_id AND m.telegram_id = r.telegram_id
    WHERE n.request_id = ? AND n.admin_id = ?
      AND n.status = 'sending' AND n.claimed_at = ?
      AND r.store_id = ? AND r.status = 'pending'
      AND m.status = 'active' AND m.role = 'employee'
      AND m.absence_check_enabled = 1
  `).bind(
    notification.request_id, notification.admin_id, claimedAt, notification.store_id
  ).first();
  if (!sendable) {
    await env.DB.prepare(`
      UPDATE absence_fine_notifications
      SET status = 'cancelled', claimed_at = NULL,
          last_error = CASE WHEN EXISTS (
            SELECT 1 FROM absence_fine_requests r
            WHERE r.request_id = absence_fine_notifications.request_id
              AND r.store_id = ? AND r.status = 'pending'
          ) THEN 'absence_check_disabled' ELSE 'absence_request_not_pending' END
      WHERE request_id = ? AND admin_id = ?
        AND status = 'sending' AND claimed_at = ?
    `).bind(
      notification.store_id, notification.request_id, notification.admin_id, claimedAt
    ).run();
    return false;
  }

  // State can still change while Telegram is in flight, so this external boundary remains at-least-once.
  let result;
  try {
    result = await sendMessage(env, notification.admin_id, [
      '缺勤罚款待审核',
      `店铺：${store.name}`,
      `员工：${notification.display_name} (${notification.telegram_id})`,
      `日期：${notification.business_date}`,
      `建议罚款：${formatMoney(store, notification.fine)}`
    ].join('\n'), { inline_keyboard: absenceApprovalKeyboard(notification.request_id) });
  } catch (error) {
    result = { ok: false, description: String(error && error.message ? error.message : error) };
  }

  if (result && result.ok === true) {
    await env.DB.prepare(`
      UPDATE absence_fine_notifications
      SET status = 'sent', sent_at = ?, last_error = NULL
      WHERE request_id = ? AND admin_id = ? AND status = 'sending' AND claimed_at = ?
    `).bind(claimedAt, notification.request_id, notification.admin_id, claimedAt).run();
    return true;
  }
  await env.DB.prepare(`
    UPDATE absence_fine_notifications
    SET status = 'pending', claimed_at = NULL, last_error = ?
    WHERE request_id = ? AND admin_id = ? AND status = 'sending' AND claimed_at = ?
  `).bind(JSON.stringify(result || { ok: false }), notification.request_id, notification.admin_id, claimedAt).run();
  return false;
}

async function cancelAbsenceNotification(env, notification, reason) {
  await env.DB.prepare(`
    UPDATE absence_fine_notifications
    SET status = 'cancelled', claimed_at = NULL, last_error = ?
    WHERE request_id = ? AND admin_id = ? AND status != 'sent'
  `).bind(reason, notification.request_id, notification.admin_id).run();
}

function cleanStoreId(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40) || makeStoreId();
}

function normalizeStoreInput(input) {
  return {
    store_id: cleanStoreId(input.store_id),
    name: String(input.name || input.store_id || 'Store').trim().slice(0, 80),
    status: ['active', 'disabled'].includes(input.status) ? input.status : 'active',
    timezone: String(input.timezone || 'Asia/Tokyo').trim(),
    currency: String(input.currency || '$').trim().slice(0, 8),
    checkin_time: validTime(input.checkin_time) ? input.checkin_time : '18:30',
    checkout_time: validTime(input.checkout_time) ? input.checkout_time : '01:30',
    late_fine: Number.isFinite(Number(input.late_fine)) ? Number(input.late_fine) : 0.5,
    early_leave_fine: Number.isFinite(Number(input.early_leave_fine)) ? Number(input.early_leave_fine) : 1.5,
    leave_min_notice_days: normalizePositiveInt(input.leave_min_notice_days, 1, 1, 365),
    leave_max_notice_days: Math.max(
      normalizePositiveInt(input.leave_max_notice_days, 5, 1, 365),
      normalizePositiveInt(input.leave_min_notice_days, 1, 1, 365)
    ),
    leave_monthly_limit: normalizePositiveInt(input.leave_monthly_limit, 4, 1, 31),
    leave_daily_limit: normalizePositiveInt(input.leave_daily_limit, 1, 1, 100),
    leave_same_day_cutoff_hour: normalizePositiveInt(input.leave_same_day_cutoff_hour, 5, 0, 23)
  };
}

export function normalizeAbsenceFineSetting(input, currentStore = {}, now = new Date()) {
  const rawFine = Number(input && input.absence_fine);
  const absenceFine = Number.isFinite(rawFine) && rawFine >= 0
    ? rawFine
    : Number(currentStore.absence_fine ?? 1.5);
  const hasEnabled = !!input && Object.prototype.hasOwnProperty.call(input, 'absence_fine_enabled');
  const enabled = hasEnabled
    ? input.absence_fine_enabled === true
    : !!currentStore.absence_fine_enabled_at;
  if (!enabled) {
    return {
      absence_fine: absenceFine,
      absence_fine_enabled_at: null,
      absence_last_checked_date: null
    };
  }
  if (currentStore.absence_fine_enabled_at) {
    return {
      absence_fine: absenceFine,
      absence_fine_enabled_at: currentStore.absence_fine_enabled_at,
      absence_last_checked_date: currentStore.absence_last_checked_date || null
    };
  }
  const timezone = String((input && input.timezone) || currentStore.timezone || 'Asia/Tokyo').trim();
  const enabledDate = localDate(now, timezone);
  return {
    absence_fine: absenceFine,
    absence_fine_enabled_at: now.toISOString(),
    absence_last_checked_date: addIsoDays(enabledDate, -1)
  };
}

export function normalizeEmployeeAbsenceCheck(input, currentMember, now = new Date()) {
  const currentEnabled = currentMember
    ? Number(currentMember.absence_check_enabled) === 1
    : true;
  const currentEnabledAt = currentEnabled
    ? (currentMember ? currentMember.absence_check_enabled_at : now.toISOString())
    : null;
  if (!input || !Object.prototype.hasOwnProperty.call(input, 'absence_check_enabled')) {
    return {
      absence_check_enabled: currentEnabled ? 1 : 0,
      absence_check_enabled_at: currentEnabledAt
    };
  }
  if (input.absence_check_enabled !== true) {
    return { absence_check_enabled: 0, absence_check_enabled_at: null };
  }
  return {
    absence_check_enabled: 1,
    absence_check_enabled_at: currentEnabled ? currentEnabledAt : now.toISOString()
  };
}

function adminHtml(env) {
  const stagingBanner = serviceEnvironment(env) === 'staging'
    ? '<div class="staging-banner" role="status">STAGING 测试环境</div>'
    : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>StaffBot Admin</title>
  <style>
    :root { color-scheme: dark; --bg:#010102; --panel:#0f1011; --panel-2:#141516; --panel-3:#18191a; --ink:#f7f8f8; --muted:#8a8f98; --muted-2:#62666d; --line:#23252a; --line-strong:#34343a; --soft:#18191a; --soft-2:#191a1b; --accent:#5e6ad2; --accent-2:#828fff; --bad:#ff6b6b; --bad-soft:#2a1416; --success:#27a644; --shadow:none; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:"SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif; background:var(--bg); color:var(--ink); font-size:14px; font-variant-numeric:tabular-nums; letter-spacing:0; }
    header { position:sticky; top:0; z-index:10; display:flex; gap:16px; align-items:center; justify-content:space-between; min-height:56px; padding:12px 24px; background:rgba(1,1,2,.92); color:var(--ink); border-bottom:1px solid var(--line); backdrop-filter:blur(16px); }
    h1 { font-size:20px; margin:0; font-weight:650; letter-spacing:0; }
    h2 { margin:0 0 14px; font-size:15px; font-weight:600; letter-spacing:0; }
    main { max-width:1280px; margin:0 auto; padding:24px; }
    a { color:var(--accent-2); text-decoration:none; font-weight:550; }
    a:hover { text-decoration:underline; }
    .panel { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:18px; margin-bottom:16px; box-shadow:var(--shadow); }
    .panel, .summary, .filter-panel, .table-wrap { box-shadow:inset 0 1px 0 rgba(255,255,255,.03); }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; align-items:center; justify-content:space-between; }
    .exports { display:flex; gap:8px; flex-wrap:nowrap; align-items:center; overflow:auto; padding-bottom:1px; }
    .exports a { flex:0 0 auto; background:var(--panel-2); border:1px solid var(--line); border-radius:8px; padding:8px 12px; color:var(--ink); font-size:13px; white-space:nowrap; }
    .exports a:hover { background:var(--panel-3); border-color:var(--line-strong); text-decoration:none; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; }
    label { display:grid; gap:6px; color:var(--muted); font-size:12px; font-weight:500; min-width:0; }
    input, select, button { min-height:40px; border:1px solid var(--line); border-radius:8px; padding:0 12px; font:inherit; background:var(--panel-2); color:var(--ink); }
    input:focus, select:focus, button:focus-visible, a:focus-visible { outline:2px solid rgba(94,106,210,.5); outline-offset:2px; border-color:var(--accent); }
    select[multiple] { height:auto; min-height:96px; padding:8px 12px; }
    button { cursor:pointer; background:var(--accent); color:#fff; border-color:var(--accent); font-weight:550; white-space:nowrap; transition:background-color .16s ease, border-color .16s ease, color .16s ease; }
    button:hover:not(:disabled) { background:var(--accent-2); border-color:var(--accent-2); }
    button.secondary { background:var(--panel); color:var(--ink); border-color:var(--line); }
    button.secondary:hover:not(:disabled) { background:var(--panel-2); border-color:var(--line-strong); }
    button.danger { background:var(--bad-soft); color:var(--bad); border-color:#fecaca; }
    button.danger:hover:not(:disabled) { background:var(--bad); color:#fff; border-color:var(--bad); }
    button:disabled { opacity:.48; cursor:not-allowed; }
    button[aria-busy="true"] { cursor:wait; }
    nav { display:flex; flex-wrap:nowrap; gap:4px; margin-bottom:16px; padding:4px; background:var(--panel); border:1px solid var(--line); border-radius:12px; overflow:auto; }
    nav button { flex:0 0 auto; min-height:36px; background:transparent; color:var(--muted); border-color:transparent; }
    nav button:hover:not(:disabled) { background:var(--panel-2); color:var(--ink); border-color:transparent; }
    nav button.active { background:var(--accent); color:#fff; border-color:var(--accent); }
    table { width:max-content; min-width:100%; border-collapse:separate; border-spacing:0; font-size:13px; overflow:hidden; }
    th, td { max-width:240px; padding:9px 10px; border-bottom:1px solid var(--line); text-align:left; vertical-align:middle; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    th { color:var(--muted); font-size:12px; font-weight:600; background:var(--panel-2); position:sticky; top:0; z-index:1; }
    th:last-child, td:last-child { max-width:none; }
    .sort-btn { width:100%; padding:0; height:auto; min-height:0; border:0; background:transparent; color:inherit; font:inherit; text-align:left; cursor:pointer; }
    .sort-btn:hover:not(:disabled) { background:transparent; color:var(--accent); border-color:transparent; }
    td button { min-height:30px; padding:0 8px; font-size:12px; }
    tbody tr:nth-child(odd) td { background:#010102; }
    tbody tr:nth-child(even) td { background:#18191a; }
    tbody tr:hover td { background:#242747; }
    td.id-cell { max-width:96px; font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; color:var(--muted); }
    .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; min-width:0; }
    .muted { color:var(--muted); }
    .hidden { display:none; }
    .status { min-height:20px; color:var(--muted); font-size:13px; }
    .pager { display:flex; gap:8px; flex-wrap:wrap; align-items:center; justify-content:flex-end; padding-top:10px; color:var(--muted); font-size:13px; }
    .pager button { min-height:32px; padding:0 9px; }
    .table-wrap { overflow:auto; border:1px solid var(--line); border-radius:12px; background:var(--panel); }
    .section-title { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:16px; }
    .summary, .filter-panel { border:1px solid var(--line); border-radius:12px; padding:14px; margin-bottom:14px; background:var(--panel); }
    .filter-panel { background:var(--panel-2); }
    .member-filter { display:flex; gap:12px; align-items:flex-end; justify-content:space-between; flex-wrap:wrap; }
    .filter-field { display:grid; gap:6px; color:var(--muted); font-size:12px; font-weight:500; min-width:0; }
    .store-chips { display:flex; gap:8px; flex-wrap:wrap; }
    .store-chip { min-height:34px; background:var(--panel); color:var(--ink); border-color:var(--line); }
    .store-chip:hover:not(:disabled) { background:var(--panel-3); border-color:var(--line-strong); }
    .store-chip.active { background:#242747; border-color:var(--accent); color:#fff; }
    .store-chip.active:hover:not(:disabled) { background:#2b2f58; border-color:var(--accent-2); color:#fff; }
    .summary-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:10px; }
    .summary-grid.attendance-metrics { grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); }
    .summary-card { min-width:0; border:1px solid var(--line); border-radius:12px; padding:12px; background:var(--soft); }
    .summary-card[data-status-tone="warning"] { border-color:rgba(255,180,80,.35); }
    .summary-card[data-status-tone="danger"] { border-color:rgba(255,107,107,.35); }
    .summary-card[data-status-tone="success"] { border-color:rgba(39,166,68,.30); }
    .summary-card strong { display:block; color:var(--muted); font-size:12px; margin-bottom:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .summary-value { color:var(--ink); font-size:20px; font-weight:600; }
    .summary-detail { margin-top:4px; font-size:12px; line-height:1.45; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .employee-name-cell { min-width:160px; font-weight:600; }
    .metric-cell { text-align:right; font-variant-numeric:tabular-nums; }
    .staging-banner { padding:10px 24px; background:#7f1d1d; color:#fff; font-weight:700; text-align:center; letter-spacing:.04em; }
    @media (max-width: 720px) { main { padding:12px; } table { min-width:820px; } header { align-items:flex-start; flex-direction:column; padding:14px 12px; } .toolbar, .member-filter { align-items:stretch; } .member-filter > * { width:100%; } input, select, button { min-height:44px; } nav button { min-height:40px; } }
  </style>
</head>
<body>
  ${stagingBanner}
  <header>
    <h1>StaffBot Admin</h1>
    <div class="row">
      <select id="uiLang" aria-label="Language">
        <option value="zh">中文</option>
        <option value="en">English</option>
        <option value="vi">Tiếng Việt</option>
        <option value="ru">Русский</option>
      </select>
      <span id="me" class="muted"></span>
      <button id="logout" class="secondary" data-i18n="logout">退出</button>
    </div>
  </header>
  <main>
    <section id="login" class="panel">
      <h2 data-i18n="login">登录</h2>
      <div class="grid">
        <label><span data-i18n="telegram_id">Telegram ID</span><input id="loginId" inputmode="numeric"></label>
        <label><span data-i18n="code">验证码</span><input id="loginCode" inputmode="numeric"></label>
      </div>
      <div class="row" style="margin-top:10px">
        <button id="sendCode" data-i18n="send_code">发送验证码</button>
        <button id="verifyCode" class="secondary" data-i18n="verify_login">验证登录</button>
      </div>
      <p class="status" id="loginStatus"></p>
    </section>
    <section id="app" class="hidden">
      <section class="panel">
        <div class="toolbar">
          <div class="exports">
            <a id="exportMembers" data-i18n="members_csv">员工 CSV</a>
            <a id="exportIncome" data-i18n="income_csv">收入 CSV</a>
            <a id="exportSalary" data-i18n="salary_csv">工资 CSV</a>
            <a id="exportAdvances" data-i18n="advances_csv">预支薪资 CSV</a>
            <a id="exportAttendance" data-i18n="attendance_csv">考勤 CSV</a>
            <a id="exportLeave" data-i18n="leave_csv">请假 CSV</a>
          </div>
        </div>
      </section>
      <nav>
        <button data-tab="stores" class="active" data-i18n="stores">店铺</button>
        <button data-tab="members" data-i18n="members">员工</button>
        <button data-tab="income" data-i18n="income">收入</button>
        <button data-tab="salary" data-i18n="salary">工资</button>
        <button data-tab="advances" data-i18n="advances">预支薪资</button>
        <button data-tab="attendance" data-i18n="attendance">考勤</button>
        <button data-tab="absence" data-i18n="absence_approvals">缺勤审批</button>
        <button data-tab="leave" data-i18n="leave">请假</button>
        <button data-tab="logs" data-i18n="logs">日志</button>
      </nav>
      <section id="tab-stores" class="panel"></section>
      <section id="tab-members" class="panel hidden"></section>
      <section id="tab-income" class="panel hidden"></section>
      <section id="tab-salary" class="panel hidden"></section>
      <section id="tab-advances" class="panel hidden"></section>
      <section id="tab-attendance" class="panel hidden"></section>
      <section id="tab-absence" class="panel hidden"></section>
      <section id="tab-leave" class="panel hidden"></section>
      <section id="tab-logs" class="panel hidden"></section>
    </section>
  </main>
  <script>
    ${resetAdminSortPages.toString()}
    const $ = (id) => document.getElementById(id);
    let stores = [];
    let currentTab = 'stores';
    let uiLang = localStorage.getItem('staffbot_admin_lang') || 'zh';
    const filters = {
      dateFrom: '',
      dateTo: '',
      employee: 'all',
      absenceStatus: 'all',
      stores: []
    };
    const pages = {
      stores: { stores_page: 1 },
      members: { members_page: 1 },
      income: { pending_page: 1, records_page: 1, rejected_page: 1 },
      salary: { requests_page: 1, records_page: 1, rejected_page: 1 },
      advances: { pending_page: 1, approved_page: 1, rejected_page: 1 },
      attendance: { pending_page: 1, approved_page: 1, rejected_page: 1 },
      absence: { absence_pending_page: 1, absence_history_page: 1 },
      leave: { pending_page: 1, approved_page: 1, rejected_page: 1 },
      logs: { logs_page: 1 }
    };
    const sorts = {
      stores: { stores: {} },
      members: { members: {} },
      income: { pending: {}, records: {}, rejected: {} },
      salary: { requests: {}, records: {}, rejected: {} },
      advances: { pending: {}, approved: {}, rejected: {} },
      attendance: { summary: {}, pending: {}, approved: {}, rejected: {} },
      absence: { pending: {}, history: {} },
      leave: { pending: {}, approved: {}, rejected: {} },
      logs: { logs: {} }
    };
    const moneyFields = new Set(['income','commission_income','fine','original_fine','amount','amount_snapshot','late_fine','early_leave_fine','absence_fine']);
    const timezones = ['Asia/Tokyo','Asia/Shanghai','Asia/Bangkok','Asia/Ho_Chi_Minh','Asia/Manila','Asia/Singapore','UTC'];
    const currencies = ['$', '¥', '₫', '฿', '₱', '€', '£'];
    const currencyLabels = { '$':'$ - USD', '¥':'¥ - JPY/CNY', '₫':'₫ - VND 越南盾', '฿':'฿ - THB', '₱':'₱ - PHP', '€':'€ - EUR', '£':'£ - GBP' };
    const I18N = {
      zh: {
        logout:'退出', login:'登录', telegram_id:'Telegram ID', code:'验证码', send_code:'发送验证码', verify_login:'验证登录',
        refresh:'刷新', members_csv:'员工 CSV', income_csv:'收入 CSV', salary_csv:'工资 CSV', advances_csv:'预支薪资 CSV', attendance_csv:'考勤 CSV', leave_csv:'请假 CSV',
        stores:'店铺', members:'员工', income:'收入', salary:'工资', advances:'预支薪资', attendance:'考勤', absence_approvals:'缺勤审批', leave:'请假', logs:'日志',
        store_id:'店铺 ID', name:'名称', timezone:'时区', currency:'货币', checkin_time:'签到时间', checkout_time:'签退时间',
        late_fine:'迟到罚款', early_leave_fine:'早退罚款', absence_fine_enabled:'缺勤罚款', absence_fine:'缺勤罚款金额', leave_min_notice_days:'最早提前天数', leave_max_notice_days:'最晚提前天数', leave_monthly_limit:'每月请假上限', leave_daily_limit:'同日请假人数上限', leave_same_day_cutoff_hour:'当天请假截止小时', status:'状态', save_store:'保存店铺', clear:'清空', edit:'编辑',
        disable:'禁用', enable:'启用', delete:'删除', action:'操作', new_store:'新建店铺', employee_name:'姓名',
        username:'用户名', role:'角色', commission_rate:'提成比例', commission_income:'提成收入', absence_check_enabled:'每日缺勤检查', save_member:'保存员工', telegram_name:'Telegram 名字', display_name:'员工姓名',
        cycle_start:'工资周期开始', joined_at:'加入时间', updated_at:'更新时间', decided_at:'决定时间', request_id:'请求 ID', record_id:'记录 ID',
        fine:'罚款', original_fine:'原始罚款', submitted_at:'提交时间', approved_at:'批准时间', admin_id:'管理员 ID', source:'来源',
        amount_snapshot:'申请金额', amount:'金额', requested_at:'申请时间', period_start:'周期开始', period_end:'周期结束',
        business_date:'营业日期', type:'类型', timestamp:'时间', latitude:'纬度', longitude:'经度', late:'迟到', early_leave:'早退',
        level:'级别', event:'事件', message_text:'消息', payload_json:'数据', created_at:'创建时间', leave_date:'请假日期',
        pending_income:'待审批收入', income_records:'收入记录', rejected_income:'拒绝记录', salary_requests:'待审批工资', salary_records:'工资记录', rejected_salary:'拒绝记录', pending_advances:'待审批预支', approved_advances:'已批准预支', rejected_advances:'已拒绝预支', pending_leave:'待审批请假', approved_leave:'已批准请假', rejected_leave:'已拒绝请假', pending_attendance:'待审批签退', approved_attendance:'已批准考勤', rejected_attendance:'已驳回签退',
        summary:'合计', work_days:'出勤天数', late_days:'迟到天数', absence_days:'缺勤天数', leave_days:'请假天数', attendance_fine_total:'考勤罚款合计', employee_attendance_summary:'员工考勤汇总', view_details:'查看明细', pending_total:'待审批合计', approved_total:'已批准合计', rejected_total:'已拒绝合计', pending_days:'待审批天数', approved_days:'已批准天数', rejected_days:'已拒绝天数', income_total:'收入合计', commission_income_total:'提成收入合计', fine_total:'罚款合计', net_total:'净额合计',
        btn_approve:'批准', btn_approve_fine:'批准并罚款', btn_approve_no_fine:'批准不罚款', btn_reject:'驳回',
        pending_absence:'待审批缺勤', absence_history:'审批历史', pending_absence_total:'待审批', approved_absence_total:'已批准', rejected_absence_total:'已拒绝', cancelled_absence_total:'已取消', approved_absence_fine_total:'已批准罚款总额', notification_status:'通知状态', notification_delivery:'通知送达', notification_sent:'已发送', notification_not_queued:'未入队', notification_retrying:'待重试', notification_recipients:'{count} 位管理员', notification_attempts:'最多尝试 {count} 次', notification_sent_total:'已发送 {sent}/{total}', btn_approve_absence_fine:'批准罚款', confirm_approve_absence_fine:'确定批准这笔缺勤罚款吗？', rejection_reason_required:'必须填写拒绝原因', absence_already_processed:'这条缺勤请求已被处理，请刷新后查看。', absence_action_failed:'操作失败，请稍后重试。', all_statuses:'全部状态', status_pending:'待审批', status_approved:'已批准', status_rejected:'已拒绝', status_cancelled:'已取消', decision_reason:'决定原因', income_record_id:'罚款记录 ID', actual_fine:'实际罚款',
        filter:'筛选', month:'月份', date_from:'开始日期', date_to:'结束日期', employee:'员工', all_employees:'全部员工', stores_filter:'店铺（可多选）', search:'查询', prev_page:'上一页', next_page:'下一页', page_status:'第 {page} / {total_pages} 页，共 {total} 条',
        sent_code:'验证码已发送到 Telegram。', sending:'发送中...', reject_reason:'驳回原因', no_data:'暂无数据',
        confirm_delete_member:'确定删除这个员工吗？', confirm_delete_store:'确定停用这个店铺吗？历史记录会保留。', default_store_cannot_be_deleted:'默认店铺不能删除。', confirm_delete_income:'确定删除这条收入记录吗？删除已批准收入会影响总收入和工资。', edit_fine:'修改罚款', prompt_fine:'请输入新的罚款金额'
      },
      en: {
        logout:'Log out', login:'Login', telegram_id:'Telegram ID', code:'Code', send_code:'Send code', verify_login:'Verify login',
        refresh:'Refresh', members_csv:'Members CSV', income_csv:'Income CSV', salary_csv:'Salary CSV', advances_csv:'Salary advances CSV', attendance_csv:'Attendance CSV', leave_csv:'Leave CSV',
        stores:'Stores', members:'Members', income:'Income', salary:'Salary', advances:'Salary advances', attendance:'Attendance', absence_approvals:'Absence approvals', leave:'Leave', logs:'Logs',
        store_id:'Store ID', name:'Name', timezone:'Timezone', currency:'Currency', checkin_time:'Check-in time', checkout_time:'Check-out time',
        late_fine:'Late fine', early_leave_fine:'Early leave fine', absence_fine_enabled:'Absence fine', absence_fine:'Absence fine amount', leave_min_notice_days:'Earliest leave days', leave_max_notice_days:'Latest leave days', leave_monthly_limit:'Monthly leave limit', leave_daily_limit:'Daily leave limit', leave_same_day_cutoff_hour:'Same-day leave cutoff hour', status:'Status', save_store:'Save store', clear:'Clear', edit:'Edit',
        disable:'Disable', enable:'Enable', delete:'Delete', action:'Action', new_store:'New store', employee_name:'Employee name',
        username:'Username', role:'Role', commission_rate:'Commission', commission_income:'Commission income', absence_check_enabled:'Daily absence check', save_member:'Save member', telegram_name:'Telegram name', display_name:'Display name',
        cycle_start:'Cycle start', joined_at:'Joined at', updated_at:'Updated at', decided_at:'Decided at', request_id:'Request ID', record_id:'Record ID',
        fine:'Fine', original_fine:'Original fine', submitted_at:'Submitted at', approved_at:'Approved at', admin_id:'Admin ID', source:'Source',
        amount_snapshot:'Requested amount', amount:'Amount', requested_at:'Requested at', period_start:'Period start', period_end:'Period end',
        business_date:'Business date', type:'Type', timestamp:'Time', latitude:'Latitude', longitude:'Longitude', late:'Late', early_leave:'Early leave',
        level:'Level', event:'Event', message_text:'Message', payload_json:'Payload', created_at:'Created at', leave_date:'Leave date',
        pending_income:'Pending income', income_records:'Income records', rejected_income:'Rejected records', salary_requests:'Pending salary', salary_records:'Salary records', rejected_salary:'Rejected records', pending_advances:'Pending advances', approved_advances:'Approved advances', rejected_advances:'Rejected advances', pending_leave:'Pending leave', approved_leave:'Approved leave', rejected_leave:'Rejected leave', pending_attendance:'Pending checkout', approved_attendance:'Approved attendance', rejected_attendance:'Rejected checkout',
        summary:'Summary', work_days:'Work days', late_days:'Late days', absence_days:'Absence days', leave_days:'Leave days', attendance_fine_total:'Attendance fines', employee_attendance_summary:'Employee attendance summary', view_details:'View details', pending_total:'Pending total', approved_total:'Approved total', rejected_total:'Rejected total', pending_days:'Pending days', approved_days:'Approved days', rejected_days:'Rejected days', income_total:'Income total', commission_income_total:'Commission income total', fine_total:'Fine total', net_total:'Net total',
        btn_approve:'Approve', btn_approve_fine:'Approve with fine', btn_approve_no_fine:'Approve no fine', btn_reject:'Reject',
        pending_absence:'Pending absences', absence_history:'Approval history', pending_absence_total:'Pending', approved_absence_total:'Approved', rejected_absence_total:'Rejected', cancelled_absence_total:'Cancelled', approved_absence_fine_total:'Approved fine total', notification_status:'Notification status', notification_delivery:'Notification delivery', notification_sent:'Sent', notification_not_queued:'Not queued', notification_retrying:'Retry pending', notification_recipients:'{count} admins', notification_attempts:'Up to {count} attempts', notification_sent_total:'{sent}/{total} sent', btn_approve_absence_fine:'Approve fine', confirm_approve_absence_fine:'Approve this absence fine?', rejection_reason_required:'Rejection reason is required', absence_already_processed:'This absence request was already processed. Refresh to see the latest state.', absence_action_failed:'The action failed. Please try again.', all_statuses:'All statuses', status_pending:'Pending', status_approved:'Approved', status_rejected:'Rejected', status_cancelled:'Cancelled', decision_reason:'Decision reason', income_record_id:'Fine record ID', actual_fine:'Actual fine',
        filter:'Filter', month:'Month', date_from:'From date', date_to:'To date', employee:'Employee', all_employees:'All employees', stores_filter:'Stores (multi-select)', search:'Search', prev_page:'Previous', next_page:'Next', page_status:'Page {page} / {total_pages}, {total} rows',
        sent_code:'Code sent to Telegram.', sending:'Sending...', reject_reason:'Reject reason', no_data:'No data',
        confirm_delete_member:'Delete this member?', confirm_delete_store:'Disable this store? History will be kept.', default_store_cannot_be_deleted:'The default store cannot be deleted.', confirm_delete_income:'Delete this income record? Deleting approved income changes totals and salary.', edit_fine:'Edit fine', prompt_fine:'Enter the new fine amount'
      },
      vi: {
        logout:'Đăng xuất', login:'Đăng nhập', telegram_id:'Telegram ID', code:'Mã', send_code:'Gửi mã', verify_login:'Xác minh',
        refresh:'Làm mới', members_csv:'Nhân viên CSV', income_csv:'Thu nhập CSV', salary_csv:'Lương CSV', advances_csv:'Ứng lương CSV', attendance_csv:'Chấm công CSV',
        stores:'Cửa hàng', members:'Nhân viên', income:'Thu nhập', salary:'Lương', advances:'Ứng lương', attendance:'Chấm công', absence_approvals:'Duyệt vắng mặt', logs:'Nhật ký',
        store_id:'ID cửa hàng', name:'Tên', timezone:'Múi giờ', currency:'Tiền tệ', checkin_time:'Giờ vào ca', checkout_time:'Giờ ra ca',
        late_fine:'Phạt đi muộn', early_leave_fine:'Phạt về sớm', absence_fine_enabled:'Phạt vắng mặt', absence_fine:'Mức phạt vắng mặt', status:'Trạng thái', save_store:'Lưu cửa hàng', clear:'Xóa form', edit:'Sửa',
        disable:'Tắt', enable:'Bật', delete:'Xóa', action:'Thao tác', new_store:'Cửa hàng mới', employee_name:'Tên nhân viên',
        username:'Tên người dùng', role:'Vai trò', commission_rate:'Tỷ lệ hoa hồng', commission_income:'Thu nhập hoa hồng', absence_check_enabled:'Kiểm tra vắng mặt hằng ngày', save_member:'Lưu nhân viên', telegram_name:'Tên Telegram', display_name:'Tên hiển thị',
        cycle_start:'Bắt đầu kỳ lương', joined_at:'Ngày tham gia', updated_at:'Cập nhật', decided_at:'Thời gian quyết định', request_id:'ID yêu cầu', record_id:'ID bản ghi',
        fine:'Phạt', original_fine:'Phạt ban đầu', submitted_at:'Ngày gửi', approved_at:'Ngày duyệt', admin_id:'ID quản trị', source:'Nguồn',
        amount_snapshot:'Số tiền yêu cầu', amount:'Số tiền', requested_at:'Ngày yêu cầu', period_start:'Bắt đầu kỳ', period_end:'Kết thúc kỳ',
        business_date:'Ngày kinh doanh', type:'Loại', timestamp:'Thời gian', latitude:'Vĩ độ', longitude:'Kinh độ', late:'Đi muộn', early_leave:'Về sớm',
        level:'Mức', event:'Sự kiện', message_text:'Tin nhắn', payload_json:'Dữ liệu', created_at:'Tạo lúc',
        pending_income:'Thu nhập chờ duyệt', income_records:'Bản ghi thu nhập', rejected_income:'Bản ghi từ chối', salary_requests:'Lương chờ duyệt', salary_records:'Bản ghi lương', rejected_salary:'Bản ghi từ chối', pending_advances:'Ứng lương chờ duyệt', approved_advances:'Ứng lương đã duyệt', rejected_advances:'Ứng lương bị từ chối', pending_attendance:'Ra ca chờ duyệt', approved_attendance:'Chấm công đã duyệt', rejected_attendance:'Ra ca bị từ chối',
        summary:'Tổng cộng', work_days:'Ngày làm việc', late_days:'Ngày đi muộn', absence_days:'Ngày vắng mặt', leave_days:'Ngày nghỉ phép', attendance_fine_total:'Tổng phạt chấm công', employee_attendance_summary:'Tổng hợp chấm công nhân viên', view_details:'Xem chi tiết', pending_total:'Tổng chờ duyệt', approved_total:'Tổng đã duyệt', rejected_total:'Tổng từ chối', income_total:'Tổng thu nhập', commission_income_total:'Tổng thu nhập hoa hồng', fine_total:'Tổng phạt', net_total:'Tổng ròng',
        btn_approve:'Duyệt', btn_approve_fine:'Duyệt kèm phạt', btn_approve_no_fine:'Duyệt không phạt', btn_reject:'Từ chối',
        pending_absence:'Vắng mặt chờ duyệt', absence_history:'Lịch sử duyệt', pending_absence_total:'Chờ duyệt', approved_absence_total:'Đã duyệt', rejected_absence_total:'Đã từ chối', cancelled_absence_total:'Đã hủy', approved_absence_fine_total:'Tổng phạt đã duyệt', notification_status:'Trạng thái thông báo', notification_delivery:'Gửi thông báo', notification_sent:'Đã gửi', notification_not_queued:'Chưa xếp hàng', notification_retrying:'Đang chờ thử lại', notification_recipients:'{count} quản trị viên', notification_attempts:'Tối đa {count} lần thử', notification_sent_total:'Đã gửi {sent}/{total}', btn_approve_absence_fine:'Duyệt tiền phạt', confirm_approve_absence_fine:'Duyệt khoản phạt vắng mặt này?', rejection_reason_required:'Bắt buộc nhập lý do từ chối', absence_already_processed:'Yêu cầu vắng mặt này đã được xử lý. Hãy làm mới để xem trạng thái mới nhất.', absence_action_failed:'Thao tác thất bại. Vui lòng thử lại.', all_statuses:'Tất cả trạng thái', status_pending:'Chờ duyệt', status_approved:'Đã duyệt', status_rejected:'Đã từ chối', status_cancelled:'Đã hủy', decision_reason:'Lý do quyết định', income_record_id:'ID bản ghi phạt', actual_fine:'Mức phạt thực tế',
        filter:'Lọc', month:'Tháng', date_from:'Từ ngày', date_to:'Đến ngày', employee:'Nhân viên', all_employees:'Tất cả nhân viên', stores_filter:'Cửa hàng (chọn nhiều)', search:'Tìm', prev_page:'Trang trước', next_page:'Trang sau', page_status:'Trang {page} / {total_pages}, tổng {total} dòng',
        sent_code:'Đã gửi mã đến Telegram.', sending:'Đang gửi...', reject_reason:'Lý do từ chối', no_data:'Không có dữ liệu',
        confirm_delete_member:'Xóa nhân viên này?', confirm_delete_store:'Tắt cửa hàng này? Lịch sử sẽ được giữ lại.', default_store_cannot_be_deleted:'Không thể xóa cửa hàng mặc định.', confirm_delete_income:'Xóa bản ghi thu nhập này? Xóa thu nhập đã duyệt sẽ ảnh hưởng tổng và lương.', edit_fine:'Sửa phạt', prompt_fine:'Nhập số tiền phạt mới'
      },
      ru: {
        logout:'Выйти', login:'Вход', telegram_id:'Telegram ID', code:'Код', send_code:'Отправить код', verify_login:'Проверить вход',
        refresh:'Обновить', members_csv:'Сотрудники CSV', income_csv:'Доход CSV', salary_csv:'Зарплата CSV', advances_csv:'Авансы CSV', attendance_csv:'Посещаемость CSV',
        stores:'Магазины', members:'Сотрудники', income:'Доход', salary:'Зарплата', advances:'Авансы зарплаты', attendance:'Посещаемость', absence_approvals:'Проверка отсутствий', logs:'Журналы',
        store_id:'ID магазина', name:'Название', timezone:'Часовой пояс', currency:'Валюта', checkin_time:'Начало смены', checkout_time:'Конец смены',
        late_fine:'Штраф за опоздание', early_leave_fine:'Штраф за ранний уход', absence_fine_enabled:'Штраф за отсутствие', absence_fine:'Размер штрафа за отсутствие', status:'Статус', save_store:'Сохранить магазин', clear:'Очистить', edit:'Редактировать',
        disable:'Отключить', enable:'Включить', delete:'Удалить', action:'Действие', new_store:'Новый магазин', employee_name:'Имя сотрудника',
        username:'Имя пользователя', role:'Роль', commission_rate:'Комиссия', commission_income:'Комиссионный доход', absence_check_enabled:'Ежедневная проверка отсутствия', save_member:'Сохранить сотрудника', telegram_name:'Имя Telegram', display_name:'Отображаемое имя',
        cycle_start:'Начало цикла', joined_at:'Дата вступления', updated_at:'Обновлено', decided_at:'Время решения', request_id:'ID запроса', record_id:'ID записи',
        fine:'Штраф', original_fine:'Исходный штраф', submitted_at:'Отправлено', approved_at:'Одобрено', admin_id:'ID администратора', source:'Источник',
        amount_snapshot:'Сумма запроса', amount:'Сумма', requested_at:'Время запроса', period_start:'Начало периода', period_end:'Конец периода',
        business_date:'Рабочая дата', type:'Тип', timestamp:'Время', latitude:'Широта', longitude:'Долгота', late:'Опоздание', early_leave:'Ранний уход',
        level:'Уровень', event:'Событие', message_text:'Сообщение', payload_json:'Данные', created_at:'Создано',
        pending_income:'Доход на проверке', income_records:'Записи дохода', rejected_income:'Отклоненные записи', salary_requests:'Зарплата на проверке', salary_records:'Записи зарплаты', rejected_salary:'Отклоненные записи', pending_advances:'Авансы на проверке', approved_advances:'Одобренные авансы', rejected_advances:'Отклоненные авансы', pending_attendance:'Завершение смены на проверке', approved_attendance:'Одобренная посещаемость', rejected_attendance:'Отклоненное завершение смены',
        summary:'Итого', work_days:'Рабочие дни', late_days:'Дни опозданий', absence_days:'Дни отсутствия', leave_days:'Дни отпуска', attendance_fine_total:'Штрафы за посещаемость', employee_attendance_summary:'Сводка посещаемости сотрудников', view_details:'Подробнее', pending_total:'Ожидает итого', approved_total:'Одобрено итого', rejected_total:'Отклонено итого', income_total:'Доход итого', commission_income_total:'Комиссионный доход итого', fine_total:'Штраф итого', net_total:'Чистый итог',
        btn_approve:'Одобрить', btn_approve_fine:'Одобрить со штрафом', btn_approve_no_fine:'Одобрить без штрафа', btn_reject:'Отклонить',
        pending_absence:'Ожидающие отсутствия', absence_history:'История решений', pending_absence_total:'Ожидают', approved_absence_total:'Одобрено', rejected_absence_total:'Отклонено', cancelled_absence_total:'Отменено', approved_absence_fine_total:'Одобренные штрафы', notification_status:'Статус уведомления', notification_delivery:'Доставка уведомления', notification_sent:'Отправлено', notification_not_queued:'Не поставлено в очередь', notification_retrying:'Ожидает повтора', notification_recipients:'Администраторов: {count}', notification_attempts:'До {count} попыток', notification_sent_total:'Отправлено {sent}/{total}', btn_approve_absence_fine:'Одобрить штраф', confirm_approve_absence_fine:'Одобрить этот штраф за отсутствие?', rejection_reason_required:'Укажите причину отклонения', absence_already_processed:'Этот запрос об отсутствии уже обработан. Обновите страницу, чтобы увидеть актуальное состояние.', absence_action_failed:'Не удалось выполнить действие. Повторите попытку.', all_statuses:'Все статусы', status_pending:'Ожидает', status_approved:'Одобрено', status_rejected:'Отклонено', status_cancelled:'Отменено', decision_reason:'Причина решения', income_record_id:'ID записи штрафа', actual_fine:'Фактический штраф',
        filter:'Фильтр', month:'Месяц', date_from:'С даты', date_to:'По дату', employee:'Сотрудник', all_employees:'Все сотрудники', stores_filter:'Магазины (можно несколько)', search:'Поиск', prev_page:'Предыдущая', next_page:'Следующая', page_status:'Страница {page} / {total_pages}, всего строк: {total}',
        sent_code:'Код отправлен в Telegram.', sending:'Отправка...', reject_reason:'Причина отклонения', no_data:'Нет данных',
        confirm_delete_member:'Удалить этого сотрудника?', confirm_delete_store:'Отключить этот магазин? История сохранится.', default_store_cannot_be_deleted:'Магазин по умолчанию нельзя удалить.', confirm_delete_income:'Удалить эту запись дохода? Удаление одобренного дохода изменит итоги и зарплату.', edit_fine:'Изменить штраф', prompt_fine:'Введите новый штраф'
      }
    };

    function L(key) { return (I18N[uiLang] && I18N[uiLang][key]) || I18N.zh[key] || key; }
    function applyI18n() {
      document.documentElement.lang = uiLang === 'zh' ? 'zh-CN' : uiLang;
      $('uiLang').value = uiLang;
      document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = L(el.dataset.i18n); });
    }
    function label(key) { return L(key); }
    function options(values, selected) {
      return values.map((value) => '<option value="' + esc(value) + '"' + (value === selected ? ' selected' : '') + '>' + esc(value) + '</option>').join('');
    }
    function currencyOptions(selected) {
      if (selected === 'VND') selected = '₫';
      return currencies.map((value) => '<option value="' + esc(value) + '"' + (value === selected ? ' selected' : '') + '>' + esc(currencyLabels[value] || value) + '</option>').join('');
    }

    async function api(path, options = {}) {
      const res = await fetch(path, {
        ...options,
        headers: { 'content-type': 'application/json', ...(options.headers || {}) },
        credentials: 'same-origin'
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'request_failed');
      return data;
    }

    async function withBusy(button, task) {
      if (!button || button.disabled) return;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      try {
        await task();
      } finally {
        button.disabled = false;
        button.removeAttribute('aria-busy');
      }
    }

    async function boot() {
      applyI18n();
      try {
        const me = await api('/api/admin/me');
        $('me').textContent = 'Telegram ID: ' + me.telegram_id;
        $('login').classList.add('hidden');
        $('app').classList.remove('hidden');
        await loadStores();
      } catch {
        $('login').classList.remove('hidden');
        $('app').classList.add('hidden');
      }
    }

    async function loadStores() {
      const data = await api('/api/admin/stores?' + pageQuery('stores'));
      stores = data.all_stores || data.stores || [];
      filters.stores = filters.stores.filter((id) => stores.some((store) => store.store_id === id));
      window.storeRows = data.stores || [];
      window.storePagination = data.pagination || {};
      updateExportLinks();
      await loadTab();
    }

    function storeId() { return currentAdminStoreId(stores, filters.stores); }
    function currentStore() { return stores.find((store) => store.store_id === storeId()) || {}; }
    function currentAdminStoreId(storeRows, selectedStoreIds) {
      return (selectedStoreIds && selectedStoreIds[0]) || (storeRows[0] && storeRows[0].store_id) || 'DEFAULT';
    }
    function activeFilterStores() {
      return filters.stores.length ? filters.stores : [storeId()];
    }
    function filterQuery() {
      const params = new URLSearchParams();
      if (filters.dateFrom) params.set('date_from', filters.dateFrom);
      if (filters.dateTo) params.set('date_to', filters.dateTo);
      if (filters.employee && filters.employee !== 'all') params.set('employee', filters.employee);
      params.set('stores', activeFilterStores().join(','));
      return params.toString();
    }
    function syncFilterInputs(root = $('tab-' + currentTab)) {
      const dateFrom = root && root.querySelector('[data-filter-date-from]');
      const dateTo = root && root.querySelector('[data-filter-date-to]');
      const employee = root && root.querySelector('[data-filter-employee]');
      const absenceStatus = root && root.querySelector('[data-absence-status]');
      if (dateFrom) filters.dateFrom = dateFrom.value;
      if (dateTo) filters.dateTo = dateTo.value;
      if (employee) filters.employee = employee.value || 'all';
      if (absenceStatus) filters.absenceStatus = absenceStatus.value || 'all';
      if (root && root.querySelector('[data-filter-stores]')) filters.stores = selectedFilterStores(root);
    }
    function pageQuery(tab) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(pages[tab] || {})) params.set(key, String(value || 1));
      appendSortParams(params, tab);
      return params.toString();
    }
    function queryWithPages(tab) {
      const params = new URLSearchParams(filterQuery());
      for (const [key, value] of Object.entries(pages[tab] || {})) {
        const queryKey = tab === 'absence' ? key.replace('absence_', '') : key;
        params.set(queryKey, String(value || 1));
      }
      if (tab === 'absence' && filters.absenceStatus !== 'all') params.set('status', filters.absenceStatus);
      appendSortParams(params, tab);
      return params.toString();
    }
    function memberListQuery(filterQueryText, pageQueryText) {
      return [filterQueryText, pageQueryText].filter(Boolean).join('&');
    }
    function appendSortParams(params, tab) {
      for (const [group, state] of Object.entries(sorts[tab] || {})) {
        if (!state.sort || !state.dir) continue;
        params.set(group + '_sort', state.sort);
        params.set(group + '_dir', state.dir);
      }
    }
    function resetPages(tab) {
      for (const key of Object.keys(pages[tab] || {})) pages[tab][key] = 1;
    }
    function resetAllPages() {
      Object.keys(pages).forEach(resetPages);
    }
    function updateExportLinks() {
      const base = '/api/admin/stores/' + encodeURIComponent(storeId()) + '/export/';
      const query = filterQuery();
      $('exportMembers').href = base + 'members.csv';
      $('exportIncome').href = base + 'income.csv?' + query;
      $('exportSalary').href = base + 'salary.csv?' + query;
      $('exportAdvances').href = base + 'advances.csv?' + query;
      $('exportAttendance').href = base + 'attendance.csv?' + query;
      $('exportLeave').href = base + 'leave.csv?' + query;
    }

    async function loadTab() {
      updateExportLinks();
      document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === currentTab));
      document.querySelectorAll('[id^="tab-"]').forEach((el) => el.classList.add('hidden'));
      $('tab-' + currentTab).classList.remove('hidden');
      if (currentTab === 'stores') return renderStores();
      if (currentTab === 'members') return renderMembers();
      if (currentTab === 'income') return renderIncome();
      if (currentTab === 'salary') return renderSalary();
      if (currentTab === 'advances') return renderSalaryAdvances();
      if (currentTab === 'attendance') return renderAttendance();
      if (currentTab === 'absence') return renderAbsence();
      if (currentTab === 'leave') return renderLeave();
      if (currentTab === 'logs') return renderRows('logs', '/api/admin/stores/' + encodeURIComponent(storeId()) + '/logs');
    }

    function renderStores() {
      const rows = (window.storeRows || stores).map((store) => ({
        ...store,
        absence_fine_enabled: store.absence_fine_enabled_at ? L('enable') : L('disable'),
        action: '<button data-store-edit="' + esc(store.store_id) + '">' + L('edit') + '</button> <button class="danger" data-store-delete="' + esc(store.store_id) + '">' + L('delete') + '</button>'
      }));
      $('tab-stores').innerHTML = '<h2>' + L('stores') + '</h2>' +
        '<div class="grid">' +
        '<label>' + L('store_id') + '<input id="storeIdInput"></label>' +
        '<label>' + L('name') + '<input id="storeNameInput"></label>' +
        '<label>' + L('timezone') + '<select id="storeTimezoneInput">' + options(timezones, 'Asia/Tokyo') + '</select></label>' +
        '<label>' + L('currency') + '<select id="storeCurrencyInput">' + currencyOptions('$') + '</select></label>' +
        '<label>' + L('checkin_time') + '<input id="storeCheckinInput" value="18:30"></label>' +
        '<label>' + L('checkout_time') + '<input id="storeCheckoutInput" value="01:30"></label>' +
        '<label>' + L('late_fine') + '<input id="storeLateFineInput" inputmode="decimal" value="0.5"></label>' +
        '<label>' + L('early_leave_fine') + '<input id="storeEarlyFineInput" inputmode="decimal" value="1.5"></label>' +
        '<label>' + L('leave_min_notice_days') + '<input id="storeLeaveMinInput" inputmode="numeric" value="1"></label>' +
        '<label>' + L('leave_max_notice_days') + '<input id="storeLeaveMaxInput" inputmode="numeric" value="5"></label>' +
        '<label>' + L('leave_monthly_limit') + '<input id="storeLeaveMonthlyInput" inputmode="numeric" value="4"></label>' +
        '<label>' + L('leave_daily_limit') + '<input id="storeLeaveDailyInput" inputmode="numeric" value="1"></label>' +
        '<label>' + L('leave_same_day_cutoff_hour') + '<input id="storeLeaveSameDayCutoffHourInput" inputmode="numeric" value="5"></label>' +
        '<label>' + L('absence_fine_enabled') +
          '<select id="storeAbsenceFineEnabledInput"><option value="false">' + L('disable') +
          '</option><option value="true">' + L('enable') + '</option></select></label>' +
        '<label>' + L('absence_fine') +
          '<input id="storeAbsenceFineInput" inputmode="decimal" value="1.5"></label>' +
        '<label>' + L('status') + '<select id="storeStatusInput"><option value="active">active</option><option value="disabled">disabled</option></select></label>' +
        '</div>' +
        '<div class="row" style="margin-top:10px"><button id="saveStore">' + L('save_store') + '</button><button id="clearStore" class="secondary">' + L('clear') + '</button></div>' +
        table(rows, ['store_id','name','status','timezone','currency','checkin_time','checkout_time','late_fine','early_leave_fine','absence_fine_enabled','absence_fine','leave_min_notice_days','leave_max_notice_days','leave_monthly_limit','leave_daily_limit','leave_same_day_cutoff_hour','action'], true, 'stores') +
        pager('stores', 'stores_page', window.storePagination && window.storePagination.stores, 'loadStores');
      $('saveStore').onclick = () => withBusy($('saveStore'), async () => {
        const id = $('storeIdInput').value.trim();
        const body = {
          store_id: id,
          name: $('storeNameInput').value,
          timezone: $('storeTimezoneInput').value,
          currency: $('storeCurrencyInput').value,
          checkin_time: $('storeCheckinInput').value,
          checkout_time: $('storeCheckoutInput').value,
          late_fine: $('storeLateFineInput').value,
          early_leave_fine: $('storeEarlyFineInput').value,
          leave_min_notice_days: $('storeLeaveMinInput').value,
          leave_max_notice_days: $('storeLeaveMaxInput').value,
          leave_monthly_limit: $('storeLeaveMonthlyInput').value,
          leave_daily_limit: $('storeLeaveDailyInput').value,
          leave_same_day_cutoff_hour: $('storeLeaveSameDayCutoffHourInput').value,
          absence_fine_enabled: $('storeAbsenceFineEnabledInput').value === 'true',
          absence_fine: $('storeAbsenceFineInput').value,
          status: $('storeStatusInput').value
        };
        const exists = stores.some((store) => store.store_id === id);
        await api(exists ? '/api/admin/stores/' + encodeURIComponent(id) : '/api/admin/stores', { method: exists ? 'PATCH' : 'POST', body: JSON.stringify(body) });
        await loadStores();
      });
      $('clearStore').onclick = () => fillStoreForm({});
      document.querySelectorAll('[data-store-edit]').forEach((btn) => {
        btn.onclick = () => fillStoreForm(stores.find((store) => store.store_id === btn.dataset.storeEdit) || {});
      });
      document.querySelectorAll('[data-store-delete]').forEach((btn) => {
        btn.onclick = () => withBusy(btn, async () => {
          if (!confirm(L('confirm_delete_store'))) return;
          try {
            await api('/api/admin/stores/' + encodeURIComponent(btn.dataset.storeDelete), { method:'DELETE' });
            await loadStores();
          } catch (error) {
            alert(L(error.message || 'default_store_cannot_be_deleted'));
          }
        });
      });
      bindPagers();
    }

    function fillStoreForm(store) {
      $('storeIdInput').value = store.store_id || '';
      $('storeIdInput').disabled = !!store.store_id;
      $('storeNameInput').value = store.name || '';
      $('storeTimezoneInput').value = store.timezone || 'Asia/Tokyo';
      $('storeCurrencyInput').value = store.currency || '$';
      $('storeCheckinInput').value = store.checkin_time || '18:30';
      $('storeCheckoutInput').value = store.checkout_time || '01:30';
      $('storeLateFineInput').value = store.late_fine ?? 0.5;
      $('storeEarlyFineInput').value = store.early_leave_fine ?? 1.5;
      $('storeLeaveMinInput').value = store.leave_min_notice_days ?? 1;
      $('storeLeaveMaxInput').value = store.leave_max_notice_days ?? 5;
      $('storeLeaveMonthlyInput').value = store.leave_monthly_limit ?? 4;
      $('storeLeaveDailyInput').value = store.leave_daily_limit ?? 1;
      $('storeLeaveSameDayCutoffHourInput').value = store.leave_same_day_cutoff_hour ?? 5;
      $('storeAbsenceFineEnabledInput').value = store.absence_fine_enabled_at ? 'true' : 'false';
      $('storeAbsenceFineInput').value = store.absence_fine ?? 1.5;
      $('storeStatusInput').value = store.status || 'active';
    }

    async function renderMembers() {
      const data = await api('/api/admin/stores/' + encodeURIComponent(storeId()) + '/members?' + memberListQuery(filterQuery(), pageQuery('members')));
      const members = (data.members || []).map((member) => ({
        ...member,
        absence_check_enabled: member.absence_check_enabled === 0 ? L('disable') : L('enable'),
        action: '<button data-member-edit="' + esc(member.telegram_id) + '">' + L('edit') + '</button> <button class="' + (member.status === 'active' ? 'danger' : '') + '" data-member-toggle="' + esc(member.telegram_id) + '">' + (member.status === 'active' ? L('disable') : L('enable')) + '</button> <button class="danger" data-member-delete="' + esc(member.telegram_id) + '">' + L('delete') + '</button>'
      }));
      $('tab-members').innerHTML = memberFilterPanel() + '<h2>' + L('members') + '</h2>' +
        '<div class="grid"><label>' + L('telegram_id') + '<input id="memberId"></label><label>' + L('employee_name') + '<input id="memberName"></label><label>' + L('username') + '<input id="memberUsername"></label><label>' + L('role') + '<select id="memberRole"><option>employee</option><option>admin</option><option>owner</option></select></label><label>' + L('status') + '<select id="memberStatus"><option>active</option><option>pending</option><option>disabled</option></select></label><label>' + L('commission_rate') + '<input id="memberCommission" inputmode="decimal" value="60"></label><label>' + L('absence_check_enabled') + '<select id="memberAbsenceCheck"><option value="true">' + L('enable') + '</option><option value="false">' + L('disable') + '</option></select></label></div>' +
        '<div class="row" style="margin-top:10px"><button id="saveMember">' + L('save_member') + '</button><button id="clearMember" class="secondary">' + L('clear') + '</button></div>' +
        table(members.map((member) => ({ ...member, commission_rate: percentForDisplay(member.commission_rate) })), ['store_id','telegram_id','display_name','username','role','status','commission_rate','absence_check_enabled','cycle_start','joined_at','action'], true, 'members') +
        pager('members', 'members_page', data.pagination && data.pagination.members);
      bindFilterControls();
      $('saveMember').onclick = () => withBusy($('saveMember'), async () => {
        await api('/api/admin/stores/' + encodeURIComponent(storeId()) + '/members', { method:'POST', body: JSON.stringify({ telegram_id:$('memberId').value, name:$('memberName').value, username:$('memberUsername').value, role:$('memberRole').value, status:$('memberStatus').value, commission_rate: Number($('memberCommission').value || 60) / 100, absence_check_enabled: $('memberAbsenceCheck').value === 'true' }) });
        await renderMembers();
      });
      $('clearMember').onclick = () => fillMemberForm({});
      document.querySelectorAll('[data-member-edit]').forEach((btn) => {
        btn.onclick = () => {
          const member = (data.members || []).find((item) => item.telegram_id === btn.dataset.memberEdit);
          fillMemberForm(member || {});
          $('memberName').focus();
        };
      });
      document.querySelectorAll('[data-member-toggle]').forEach((btn) => {
        btn.onclick = () => withBusy(btn, async () => {
          const member = (data.members || []).find((item) => item.telegram_id === btn.dataset.memberToggle);
          if (!member) return;
          await api('/api/admin/stores/' + encodeURIComponent(storeId()) + '/members', {
            method:'POST',
            body: JSON.stringify({
              telegram_id: member.telegram_id,
              name: member.display_name,
              username: member.username,
              role: member.role,
              status: member.status === 'active' ? 'disabled' : 'active',
              commission_rate: member.commission_rate,
              absence_check_enabled: member.absence_check_enabled !== 0
            })
          });
          await renderMembers();
        });
      });
      document.querySelectorAll('[data-member-delete]').forEach((btn) => {
        btn.onclick = () => withBusy(btn, async () => {
          if (!confirm(L('confirm_delete_member'))) return;
          await api('/api/admin/stores/' + encodeURIComponent(storeId()) + '/members/' + encodeURIComponent(btn.dataset.memberDelete), { method:'DELETE' });
          await renderMembers();
        });
      });
      bindPagers();
    }

    function fillMemberForm(member) {
      $('memberId').value = member.telegram_id || '';
      $('memberName').value = member.display_name || member.telegram_name || '';
      $('memberUsername').value = member.username || '';
      $('memberRole').value = member.role || 'employee';
      $('memberStatus').value = member.status || 'active';
      $('memberCommission').value = percentForInput(member.commission_rate);
      $('memberAbsenceCheck').value =
        member.absence_check_enabled === 0 ? 'false' : 'true';
    }

    async function renderIncome() {
      const data = await api('/api/admin/stores/' + encodeURIComponent(storeId()) + '/income?' + queryWithPages('income'));
      $('tab-income').innerHTML = await filterPanel() +
        incomeSummaryPanel(data) +
        sectionTitle('pending_income') + incomeActionTable(data.pending, ['request_id','telegram_id','display_name','income','commission_rate','commission_income','fine','status','submitted_at'], 'pending', 'request_id', true, 'pending') + pager('income', 'pending_page', data.pagination && data.pagination.pending) +
        sectionTitle('income_records') + incomeActionTable(data.records, ['record_id','telegram_id','display_name','type','income','commission_rate','commission_income','original_fine','fine','submitted_at','approved_at','admin_id'], 'records', 'record_id', false, 'records') + pager('income', 'records_page', data.pagination && data.pagination.records) +
        sectionTitle('rejected_income') + incomeActionTable(data.rejected, ['request_id','telegram_id','display_name','income','commission_rate','commission_income','fine','status','submitted_at','decided_at','admin_id','reject_reason'], 'pending', 'request_id', false, 'rejected') + pager('income', 'rejected_page', data.pagination && data.pagination.rejected);
      bindFilterControls();
      bindActions('income');
      bindIncomeDeletes();
      bindPagers();
    }

    async function renderSalary() {
      const data = await api('/api/admin/stores/' + encodeURIComponent(storeId()) + '/salary?' + queryWithPages('salary'));
      $('tab-salary').innerHTML = await filterPanel() +
        salarySummaryPanel(data) +
        sectionTitle('salary_requests') + actionTable(data.requests, ['request_id','telegram_id','display_name','amount_snapshot','status','requested_at'], 'salary', 'requests') + pager('salary', 'requests_page', data.pagination && data.pagination.requests) +
        sectionTitle('salary_records') + table(data.records, ['record_id','telegram_id','display_name','amount','period_start','period_end','approved_at','admin_id'], false, 'records') + pager('salary', 'records_page', data.pagination && data.pagination.records) +
        sectionTitle('rejected_salary') + table(data.rejected, ['request_id','telegram_id','display_name','amount_snapshot','status','requested_at','decided_at','admin_id','reject_reason'], false, 'rejected') + pager('salary', 'rejected_page', data.pagination && data.pagination.rejected);
      bindFilterControls();
      bindActions('salary');
      bindPagers();
    }

    async function renderSalaryAdvances() {
      const data = await api('/api/admin/stores/' + encodeURIComponent(storeId()) + '/advances?' + queryWithPages('advances'));
      $('tab-advances').innerHTML = await filterPanel() +
        advanceSummaryPanel(data) +
        sectionTitle('pending_advances') + actionTable(data.pending, ['request_id','telegram_id','display_name','amount','status','requested_at'], 'advances', 'pending') + pager('advances', 'pending_page', data.pagination && data.pagination.pending) +
        sectionTitle('approved_advances') + table(data.approved, ['request_id','telegram_id','display_name','amount','status','requested_at','decided_at','admin_id'], false, 'approved') + pager('advances', 'approved_page', data.pagination && data.pagination.approved) +
        sectionTitle('rejected_advances') + table(data.rejected, ['request_id','telegram_id','display_name','amount','status','requested_at','decided_at','admin_id','reject_reason'], false, 'rejected') + pager('advances', 'rejected_page', data.pagination && data.pagination.rejected);
      bindFilterControls();
      bindActions('advances');
      bindPagers();
    }

    async function renderRows(id, path) {
      const data = await api(path + '?' + pageQuery('logs'));
      $('tab-' + id).innerHTML = '<h2>' + L(id) + '</h2>' + table(data.rows, Object.keys((data.rows || [])[0] || {}), false, 'logs') + pager('logs', 'logs_page', data.pagination && data.pagination.rows);
      bindPagers();
    }

    async function renderAttendance() {
      const data = await api('/api/admin/stores/' + encodeURIComponent(storeId()) + '/attendance?' + queryWithPages('attendance'));
      $('tab-attendance').innerHTML = await filterPanel() +
        attendanceSummaryPanel(data) +
        sectionTitle('employee_attendance_summary') + attendanceEmployeeSummaryTable(data) +
        sectionTitle('pending_attendance') + attendanceActionTable(data.pending, ['request_id','telegram_id','display_name','business_date','timestamp','early_leave','original_fine','status','submitted_at'], 'pending') + pager('attendance', 'pending_page', data.pagination && data.pagination.pending) +
        sectionTitle('approved_attendance') + table(data.approved, ['record_id','telegram_id','display_name','business_date','type','timestamp','late','early_leave','original_fine','fine'], false, 'approved') + pager('attendance', 'approved_page', data.pagination && data.pagination.approved) +
        sectionTitle('rejected_attendance') + table(data.rejected, ['request_id','telegram_id','display_name','business_date','timestamp','early_leave','original_fine','status','submitted_at','decided_at','admin_id','reject_reason'], false, 'rejected') + pager('attendance', 'rejected_page', data.pagination && data.pagination.rejected);
      bindFilterControls();
      document.querySelectorAll('[data-attendance-detail]').forEach((btn) => {
        btn.onclick = () => withBusy(btn, async () => {
          filters.employee = btn.dataset.attendanceDetail;
          const employeeSelect = $('tab-attendance').querySelector('[data-filter-employee]');
          if (employeeSelect) employeeSelect.value = filters.employee;
          resetPages('attendance');
          await renderAttendance();
        });
      });
      bindActions('attendance');
      bindPagers();
    }

    async function renderAbsence() {
      const data = await api('/api/admin/stores/' + encodeURIComponent(storeId()) + '/absence?' + queryWithPages('absence'));
      const pending = (data.pending || []).map((row) => ({
        ...row,
        fine: formatCurrencyAmount(row.currency, row.fine),
        notification_status: notificationStatusLabel(row.notification_status),
        notification_delivery: notificationDeliveryLabel(row),
        action: '<button data-absence-action="approve" data-store="' + esc(row.store_id) + '" data-id="' + esc(row.request_id) + '">' + L('btn_approve_absence_fine') + '</button> ' +
          '<button class="danger" data-absence-action="reject" data-store="' + esc(row.store_id) + '" data-id="' + esc(row.request_id) + '">' + L('btn_reject') + '</button>'
      }));
      const history = (data.history || []).map((row) => ({
        ...row,
        status: absenceStatusLabel(row.status),
        original_fine: formatCurrencyAmount(row.currency, row.original_fine),
        actual_fine: row.actual_fine === null || row.actual_fine === undefined ? '' : formatCurrencyAmount(row.currency, row.actual_fine),
        decision_reason: row.reject_reason || row.cancellation_reason || ''
      }));
      $('tab-absence').innerHTML = await filterPanel(true, true) +
        absenceSummaryPanel(data) +
        sectionTitle('pending_absence') +
        table(pending, ${JSON.stringify(ABSENCE_PENDING_COLUMNS)}, true, 'pending') +
        pager('absence', 'absence_pending_page', data.pagination && data.pagination.pending) +
        sectionTitle('absence_history') +
        table(history, ${JSON.stringify(ABSENCE_HISTORY_COLUMNS)}, false, 'history') +
        pager('absence', 'absence_history_page', data.pagination && data.pagination.history);
      bindFilterControls();
      bindAbsenceActions();
      bindPagers();
    }

    function bindAbsenceActions() {
      document.querySelectorAll('[data-absence-action]').forEach((btn) => {
        btn.onclick = () => withBusy(btn, async () => {
          let body = {};
          if (btn.dataset.absenceAction === 'approve') {
            if (!confirm(L('confirm_approve_absence_fine'))) return;
          } else {
            const reasonInput = prompt(L('reject_reason'));
            if (reasonInput === null) return;
            const reason = reasonInput.trim();
            if (!reason) {
              alert(L('rejection_reason_required'));
              return;
            }
            body = { reason };
          }
          try {
            await api('/api/admin/stores/' + encodeURIComponent(btn.dataset.store) + '/absence/' + encodeURIComponent(btn.dataset.id) + '/' + btn.dataset.absenceAction, {
              method:'POST',
              body: JSON.stringify(body)
            });
            await renderAbsence();
          } catch (error) {
            alert(L(error && error.message === 'already_decided' ? 'absence_already_processed' : 'absence_action_failed'));
          }
        });
      });
    }

    async function renderLeave() {
      const data = await api('/api/admin/stores/' + encodeURIComponent(storeId()) + '/leave?' + queryWithPages('leave'));
      $('tab-leave').innerHTML = await filterPanel() +
        leaveSummaryPanel(data) +
        sectionTitle('pending_leave') + actionTable(data.pending, ['request_id','telegram_id','display_name','leave_date','status','requested_at'], 'leave', 'pending') + pager('leave', 'pending_page', data.pagination && data.pagination.pending) +
        sectionTitle('approved_leave') + table(data.approved, ['request_id','telegram_id','display_name','leave_date','status','requested_at','decided_at','admin_id'], false, 'approved') + pager('leave', 'approved_page', data.pagination && data.pagination.approved) +
        sectionTitle('rejected_leave') + table(data.rejected, ['request_id','telegram_id','display_name','leave_date','status','requested_at','decided_at','admin_id','reject_reason'], false, 'rejected') + pager('leave', 'rejected_page', data.pagination && data.pagination.rejected);
      bindFilterControls();
      bindActions('leave');
      bindPagers();
    }

    function incomeSummaryPanel(data) {
      const pending = sumIncomeRows(data.pending || []);
      const approved = sumIncomeRows(data.records || []);
      const rejected = sumIncomeRows(data.rejected || []);
      return summaryPanel([
        { label: L('pending_total'), value: summaryMoney(pending.net), detail: L('income_total') + ': ' + summaryMoney(pending.income) + ' / ' + L('commission_income_total') + ': ' + summaryMoney(pending.commissionIncome) + ' / ' + L('fine_total') + ': ' + summaryMoney(pending.fine) },
        { label: L('approved_total'), value: summaryMoney(approved.net), detail: L('income_total') + ': ' + summaryMoney(approved.income) + ' / ' + L('commission_income_total') + ': ' + summaryMoney(approved.commissionIncome) + ' / ' + L('fine_total') + ': ' + summaryMoney(approved.fine) },
        { label: L('rejected_total'), value: summaryMoney(rejected.net), detail: L('income_total') + ': ' + summaryMoney(rejected.income) + ' / ' + L('commission_income_total') + ': ' + summaryMoney(rejected.commissionIncome) + ' / ' + L('fine_total') + ': ' + summaryMoney(rejected.fine) }
      ]);
    }

    function salarySummaryPanel(data) {
      const pending = sumRows(data.requests || [], 'amount_snapshot');
      const approved = sumRows(data.records || [], 'amount');
      const rejected = sumRows(data.rejected || [], 'amount_snapshot');
      return summaryPanel([
        { label: L('pending_total'), value: summaryMoney(pending) },
        { label: L('approved_total'), value: summaryMoney(approved) },
        { label: L('rejected_total'), value: summaryMoney(rejected) }
      ]);
    }

    function advanceSummaryPanel(data) {
      return summaryPanel([
        { label: L('pending_total'), value: summaryMoney(sumRows(data.pending || [], 'amount')) },
        { label: L('approved_total'), value: summaryMoney(sumRows(data.approved || [], 'amount')) },
        { label: L('rejected_total'), value: summaryMoney(sumRows(data.rejected || [], 'amount')) }
      ]);
    }

    function leaveSummaryPanel(data) {
      return summaryPanel([
        { label: L('pending_days'), value: String((data.pagination && data.pagination.pending && data.pagination.pending.total) || 0) },
        { label: L('approved_days'), value: String((data.pagination && data.pagination.approved && data.pagination.approved.total) || 0) },
        { label: L('rejected_days'), value: String((data.pagination && data.pagination.rejected && data.pagination.rejected.total) || 0) }
      ]);
    }

    function absenceSummaryPanel(data) {
      const statusCounts = (data.summary && data.summary.status_counts) || {};
      const fineTotals = ((data.summary && data.summary.fine_totals) || [])
        .map((item) => formatCurrencyAmount(item.currency, item.amount))
        .join(' · ') || '0';
      return summaryPanel([
        { label: L('pending_absence_total'), value: String(statusCounts.pending || 0) },
        { label: L('approved_absence_total'), value: String(statusCounts.approved || 0) },
        { label: L('rejected_absence_total'), value: String(statusCounts.rejected || 0) },
        { label: L('cancelled_absence_total'), value: String(statusCounts.cancelled || 0) },
        { label: L('approved_absence_fine_total'), value: fineTotals }
      ]);
    }

    function absenceStatusLabel(status) {
      return L('status_' + status);
    }

    function notificationStatusLabel(status) {
      return L('notification_' + status);
    }

    function notificationDeliveryLabel(row) {
      if (row.notification_status === 'not_queued') return L('notification_not_queued');
      const progress = L('notification_sent_total')
        .replace('{sent}', String(row.notification_sent_total || 0))
        .replace('{total}', String(row.notification_total || 0));
      if (row.notification_status === 'retrying') {
        return progress + ' · ' + L('notification_attempts').replace('{count}', String(row.notification_attempts || 0));
      }
      return progress;
    }

    function attendanceSummaryPanel(data) {
      const summary = data.summary || {};
      const fineTotal = (summary.fine_totals || []).length > 1
        ? summary.fine_totals.map((item) => formatCurrencyAmount(item.currency, item.amount)).join(' / ')
        : formatCurrencyAmount(summary.currency || '', summary.fine_total || 0);
      return '<div class="summary"><h2>' + L('summary') + '</h2>' +
        '<div class="summary-grid attendance-metrics">' + [
          { label:L('work_days'), value:String(summary.work_days || 0), tone:'success' },
          { label:L('late_days'), value:String(summary.late_days || 0), tone:'warning' },
          { label:L('absence_days'), value:String(summary.absence_days || 0), tone:'danger' },
          { label:L('leave_days'), value:String(summary.leave_days || 0), tone:'' },
          { label:L('attendance_fine_total'), value:fineTotal, tone:'warning' }
        ].map((item) => '<div class="summary-card" data-status-tone="' + esc(item.tone) + '">' +
          '<strong>' + esc(item.label) + '</strong><div class="summary-value">' + esc(item.value) + '</div></div>').join('') +
        '</div></div>';
    }

    function attendanceEmployeeSummaryTable(data) {
      const rows = [...(data.employee_stats || [])];
      const state = sorts.attendance.summary || {};
      const numericColumns = new Set(['work_days', 'late_days', 'absence_days', 'leave_days', 'fine_total']);
      if (state.sort) {
        rows.sort((a, b) => {
          const comparison = numericColumns.has(state.sort)
            ? Number(a[state.sort] || 0) - Number(b[state.sort] || 0)
            : String(a[state.sort] || '').localeCompare(String(b[state.sort] || ''));
          return state.dir === 'desc' ? -comparison : comparison;
        });
      }
      const cols = activeFilterStores().length > 1
        ? ['store_id', 'display_name', 'work_days', 'late_days', 'absence_days', 'leave_days', 'fine_total', 'action']
        : ['display_name', 'work_days', 'late_days', 'absence_days', 'leave_days', 'fine_total', 'action'];
      return '<div class="table-wrap"><table><thead><tr>' + cols.map((key) => tableHeader(key, 'summary')).join('') + '</tr></thead><tbody>' +
        rows.map((row) => '<tr>' + cols.map((key) => {
          if (key === 'action') return '<td><button class="secondary" data-attendance-detail="' + esc(row.telegram_id) + '">' + L('view_details') + '</button></td>';
          const value = key === 'fine_total' ? formatCurrencyAmount(row.currency || '', row[key] || 0) : String(row[key] || 0);
          const className = key === 'display_name' ? 'employee-name-cell' : numericColumns.has(key) ? 'metric-cell' : key === 'store_id' ? 'id-cell' : '';
          return '<td' + (className ? ' class="' + className + '"' : '') + ' title="' + esc(value) + '">' + esc(value) + '</td>';
        }).join('') + '</tr>').join('') +
        '</tbody></table></div>';
    }

    function summaryPanel(items) {
      return '<div class="summary">' +
        '<h2>' + L('summary') + '</h2>' +
        '<div class="summary-grid">' + items.map((item) => '<div class="summary-card"><strong>' + esc(item.label) + '</strong><div class="summary-value">' + esc(item.value) + '</div>' + (item.detail ? '<div class="muted summary-detail">' + esc(item.detail) + '</div>' : '') + '</div>').join('') + '</div>' +
        '</div>';
    }

    function sectionTitle(key) {
      return '<div class="section-title"><h2>' + L(key) + '</h2></div>';
    }

    function sumIncomeRows(rows) {
      const income = sumRows(rows, 'income');
      const commissionIncome = sumRows(rows, 'commission_income');
      const fine = sumRows(rows, 'fine');
      return { income, commissionIncome, fine, net: commissionIncome - fine };
    }

    function sumRows(rows, key) {
      return rows.reduce((total, row) => total + Number(row[key] || 0), 0);
    }

    function summaryMoney(value) {
      return formatAdminMoneyForUi(Number(value || 0).toFixed(2));
    }

    async function filterPanel(includeEmployeeFilters = true, includeAbsenceStatus = false) {
      const selectedStores = new Set(activeFilterStores());
      const members = includeEmployeeFilters ? await loadFilterMembers(Array.from(selectedStores)) : [];
      return '<div class="filter-panel">' +
        '<h2>' + L('filter') + '</h2>' +
        '<div class="grid">' +
        (includeEmployeeFilters ? '<label>' + L('date_from') + '<input data-filter-date-from type="date" value="' + esc(filters.dateFrom) + '"></label>' +
        '<label>' + L('date_to') + '<input data-filter-date-to type="date" value="' + esc(filters.dateTo) + '"></label>' +
        '<label>' + L('employee') + '<select data-filter-employee><option value="all">' + L('all_employees') + '</option>' + members.map((member) => '<option value="' + esc(member.telegram_id) + '"' + (filters.employee === member.telegram_id ? ' selected' : '') + '>' + esc(member.display_name + ' (' + member.telegram_id + ')') + '</option>').join('') + '</select></label>' : '') +
        (includeAbsenceStatus ? '<label>' + L('status') + '<select data-absence-status>' + absenceStatusOptions() + '</select></label>' : '') +
        '<label>' + L('stores_filter') + '<select data-filter-stores multiple size="' + Math.min(Math.max(stores.length, 2), 6) + '">' + stores.map((store) => '<option value="' + esc(store.store_id) + '"' + (selectedStores.has(store.store_id) ? ' selected' : '') + '>' + esc(store.name) + '</option>').join('') + '</select></label>' +
        '</div>' +
        '<div class="row" style="margin-top:10px"><button data-apply-filters>' + L('search') + '</button></div>' +
        '</div>';
    }

    function absenceStatusOptions() {
      return ['all','pending','approved','rejected','cancelled'].map((value) => {
        const key = value === 'all' ? 'all_statuses' : 'status_' + value;
        return '<option value="' + value + '"' + (filters.absenceStatus === value ? ' selected' : '') + '>' + esc(L(key)) + '</option>';
      }).join('');
    }

    function memberFilterPanel() {
      const selectedStores = new Set(activeFilterStores());
      return '<div class="filter-panel member-filter">' +
        '<div><h2>' + L('filter') + '</h2>' +
        '<div class="filter-field"><span>' + L('stores_filter') + '</span><div class="store-chips" data-filter-stores>' +
        stores.map((store) => '<button type="button" class="store-chip' + (selectedStores.has(store.store_id) ? ' active' : '') + '" data-store-filter="' + esc(store.store_id) + '" aria-pressed="' + (selectedStores.has(store.store_id) ? 'true' : 'false') + '">' + esc(store.name) + '</button>').join('') +
        '</div></div></div>' +
        '<button data-apply-filters>' + L('search') + '</button>' +
        '</div>';
    }

    async function loadFilterMembers(storeIds) {
      const byId = new Map();
      for (const id of storeIds) {
        const data = await api('/api/admin/stores/' + encodeURIComponent(id) + '/members?all=1');
        for (const member of data.members || []) {
          if (member.status !== 'active') continue;
          byId.set(member.telegram_id, {
            telegram_id: member.telegram_id,
            display_name: member.display_name || member.telegram_name || member.username || member.telegram_id
          });
        }
      }
      return Array.from(byId.values()).sort((a, b) => a.display_name.localeCompare(b.display_name));
    }

    function bindFilterControls() {
      const root = $('tab-' + currentTab);
      const applyButton = root && root.querySelector('[data-apply-filters]');
      const storeFilter = root && root.querySelector('[data-filter-stores]');
      if (!applyButton || !storeFilter) return;
      applyButton.onclick = () => withBusy(applyButton, async () => {
        syncFilterInputs(root);
        resetPages(currentTab);
        updateExportLinks();
        await loadTab();
      });
      if (storeFilter.tagName === 'SELECT') {
        storeFilter.onchange = async () => {
          syncFilterInputs(root);
          filters.employee = 'all';
          resetPages(currentTab);
          updateExportLinks();
          await loadTab();
        };
      } else {
        document.querySelectorAll('[data-store-filter]').forEach((btn) => {
          btn.onclick = () => {
            btn.classList.toggle('active');
            btn.setAttribute('aria-pressed', btn.classList.contains('active') ? 'true' : 'false');
          };
        });
      }
    }

    function selectedFilterStores(root = $('tab-' + currentTab)) {
      const storeFilter = root && root.querySelector('[data-filter-stores]');
      if (!storeFilter) return [];
      if (storeFilter.tagName === 'SELECT') return Array.from(storeFilter.selectedOptions).map((option) => option.value);
      return Array.from(root.querySelectorAll('[data-store-filter].active')).map((btn) => btn.dataset.storeFilter);
    }

    function actionTable(rows, cols, type, sortGroup) {
      const withActions = (rows || []).map((row) => ({ ...row, action: row.status === 'pending' ? '<button data-act="approve" data-type="' + type + '" data-id="' + esc(row.request_id) + '" data-store="' + esc(row.store_id || storeId()) + '">' + L('btn_approve') + '</button> <button class="danger" data-act="reject" data-type="' + type + '" data-id="' + esc(row.request_id) + '" data-store="' + esc(row.store_id || storeId()) + '">' + L('btn_reject') + '</button>' : '' }));
      return table(withActions, [...cols, 'action'], true, sortGroup);
    }

    function attendanceActionTable(rows, cols, sortGroup) {
      const withActions = (rows || []).map((row) => {
        const actionNames = Number(row.fine || 0) > 0 ? ['approve_fine', 'approve_no_fine', 'reject'] : ['approve', 'reject'];
        const actions = actionNames.map((act) => {
          const labelKey = act === 'approve_fine' ? 'btn_approve_fine' : act === 'approve_no_fine' ? 'btn_approve_no_fine' : act === 'approve' ? 'btn_approve' : 'btn_reject';
          const className = act === 'reject' ? ' class="danger"' : '';
          return '<button' + className + ' data-act="' + esc(act) + '" data-type="attendance" data-id="' + esc(row.request_id) + '" data-store="' + esc(row.store_id || storeId()) + '">' + L(labelKey) + '</button>';
        }).join(' ');
        return { ...row, action: row.status === 'pending' ? actions : '' };
      });
      return table(withActions, [...cols, 'action'], true, sortGroup);
    }

    function incomeActionTable(rows, cols, deleteKind, idKey, includeApproval, sortGroup) {
      const withActions = (rows || []).map((row) => {
        const approval = includeApproval && row.status === 'pending'
          ? '<button data-act="approve" data-type="income" data-id="' + esc(row.request_id) + '" data-store="' + esc(row.store_id || storeId()) + '">' + L('btn_approve') + '</button> <button class="danger" data-act="reject" data-type="income" data-id="' + esc(row.request_id) + '" data-store="' + esc(row.store_id || storeId()) + '">' + L('btn_reject') + '</button> '
          : '';
        return {
          ...row,
          commission_rate: percentForDisplay(row.commission_rate),
          action: approval + (row.type === 'fine' && deleteKind === 'records' ? '<button data-income-fine-id="' + esc(row[idKey]) + '" data-store="' + esc(row.store_id || storeId()) + '" data-fine="' + esc(row.fine) + '">' + L('edit_fine') + '</button> ' : '') + '<button class="danger" data-income-delete-kind="' + esc(deleteKind) + '" data-income-delete-id="' + esc(row[idKey]) + '" data-store="' + esc(row.store_id || storeId()) + '">' + L('delete') + '</button>'
        };
      });
      return table(withActions, [...cols, 'action'], true, sortGroup);
    }

    function bindActions(type) {
      document.querySelectorAll('[data-type="' + type + '"]').forEach((btn) => {
        btn.onclick = () => withBusy(btn, async () => {
          const reason = btn.dataset.act === 'reject' ? prompt(L('reject_reason')) || 'Rejected from admin page' : undefined;
          await api('/api/admin/stores/' + encodeURIComponent(btn.dataset.store || storeId()) + '/' + type + '/' + encodeURIComponent(btn.dataset.id) + '/' + btn.dataset.act, { method:'POST', body: JSON.stringify({ reason }) });
          await loadTab();
        });
      });
    }

    function bindIncomeDeletes() {
      document.querySelectorAll('[data-income-fine-id]').forEach((btn) => {
        btn.onclick = () => withBusy(btn, async () => {
          const fine = prompt(L('prompt_fine'), btn.dataset.fine || '0');
          if (fine === null) return;
          await api('/api/admin/stores/' + encodeURIComponent(btn.dataset.store || storeId()) + '/income/records/' + encodeURIComponent(btn.dataset.incomeFineId), { method:'PATCH', body: JSON.stringify({ fine }) });
          await loadTab();
        });
      });
      document.querySelectorAll('[data-income-delete-id]').forEach((btn) => {
        btn.onclick = () => withBusy(btn, async () => {
          if (!confirm(L('confirm_delete_income'))) return;
          await api('/api/admin/stores/' + encodeURIComponent(btn.dataset.store || storeId()) + '/income/' + encodeURIComponent(btn.dataset.incomeDeleteKind) + '/' + encodeURIComponent(btn.dataset.incomeDeleteId), { method:'DELETE' });
          await loadTab();
        });
      });
    }

    function percentForInput(value) {
      const rate = Number(value);
      if (!Number.isFinite(rate) || rate <= 0) return '60';
      const percent = rate > 1 ? rate : rate * 100;
      return String(Math.round(percent * 100) / 100);
    }

    function percentForDisplay(value) {
      return percentForInput(value) + '%';
    }

    function table(rows, cols, html = false, sortGroup = '') {
      if (!cols.length) return '<p class="muted">' + L('no_data') + '</p>';
      return '<div class="table-wrap"><table><thead><tr>' + cols.map((c) => tableHeader(c, sortGroup)).join('') + '</tr></thead><tbody>' +
        (rows || []).map((r) => '<tr>' + cols.map((c) => tableCell(c, r, html)).join('') + '</tr>').join('') +
        '</tbody></table></div>';
    }

    function tableHeader(key, sortGroup) {
      if (!sortGroup || key === 'action') return '<th>' + esc(label(key)) + '</th>';
      const state = (sorts[currentTab] && sorts[currentTab][sortGroup]) || {};
      const mark = state.sort === key ? (state.dir === 'asc' ? ' ↑' : ' ↓') : '';
      return '<th><button class="sort-btn" data-sort-group="' + esc(sortGroup) + '" data-sort-col="' + esc(key) + '">' + esc(label(key) + mark) + '</button></th>';
    }

    function tableCell(key, row, html) {
      if (html && key === 'action') return '<td>' + (row[key] || '') + '</td>';
      const value = formatDisplayValue(key, row[key], row);
      const compact = isCompactIdField(key);
      return '<td' + (compact ? ' class="id-cell"' : '') + ' title="' + esc(value) + '">' + esc(compact ? compactId(value) : value) + '</td>';
    }

    function formatDisplayValue(key, value, row = {}) {
      if (moneyFields.has(key)) return formatAdminMoneyForUi(value);
      if (key === 'submitted_at' || key === 'approved_at') return formatAdminShortDateHourForUi(value, currentStore().timezone || 'Asia/Tokyo');
      if (isTimeField(key)) return formatAdminDateTimeForUi(value, row.timezone || currentStore().timezone || 'Asia/Tokyo');
      return value;
    }

    function isCompactIdField(key) {
      return key === 'request_id' || key === 'record_id' || key === 'store_id' || key === 'admin_id';
    }

    function compactId(value) {
      const text = String(value || '');
      if (text.length <= 10) return text;
      return text.slice(0, 4) + '…' + text.slice(-4);
    }

    function formatAdminMoneyForUi(value) {
      if (value === null || value === undefined || value === '') return '';
      const number = Number(value);
      if (!Number.isFinite(number)) return String(value);
      return number.toLocaleString('en-US', { maximumFractionDigits: 20 });
    }

    function formatCurrencyAmount(currency, value) {
      const amount = formatAdminMoneyForUi(value);
      return currency ? String(currency) + amount : amount;
    }

    function isTimeField(key) {
      return key === 'timestamp' || key === 'business_date' || key === 'leave_date' || key === 'period_start' || key === 'period_end' || key === 'cycle_start' || key === 'joined_at' || key.endsWith('_at');
    }

    function formatAdminDateTimeForUi(value, timezone) {
      const text = String(value || '').trim();
      if (!text) return '';
      if (/^\\d{4}-\\d{2}-\\d{2}$/.test(text)) return text.replaceAll('-', '/') + ' 00:00:00';
      const date = new Date(text);
      if (Number.isNaN(date.getTime())) return text;
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone || 'Asia/Tokyo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      }).formatToParts(date);
      const map = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
      return map.year + '/' + map.month + '/' + map.day + ' ' + map.hour + ':' + map.minute + ':' + map.second;
    }

    function formatAdminShortDateHourForUi(value, timezone) {
      const text = String(value || '').trim();
      if (!text) return '';
      const date = new Date(text);
      if (Number.isNaN(date.getTime())) return text;
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone || 'Asia/Tokyo',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hour12: false
      }).formatToParts(date);
      const map = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
      return map.month + '/' + map.day + ' ' + map.hour + '点';
    }

    function pager(tab, key, meta, reloadName = 'loadTab') {
      if (!meta) return '';
      const status = L('page_status')
        .replace('{page}', meta.page)
        .replace('{total_pages}', meta.total_pages)
        .replace('{total}', meta.total);
      return '<div class="pager" data-tab-page="' + esc(tab) + '" data-page-key="' + esc(key) + '" data-reload="' + esc(reloadName) + '">' +
        '<span>' + esc(status) + '</span>' +
        '<button class="secondary" data-page-dir="prev"' + (!meta.has_prev ? ' disabled' : '') + '>' + L('prev_page') + '</button>' +
        '<button class="secondary" data-page-dir="next"' + (!meta.has_next ? ' disabled' : '') + '>' + L('next_page') + '</button>' +
        '</div>';
    }

    function bindPagers() {
      document.querySelectorAll('[data-sort-col]').forEach((btn) => {
        btn.onclick = () => withBusy(btn, async () => {
          syncFilterInputs();
          const group = btn.dataset.sortGroup;
          const col = btn.dataset.sortCol;
          const state = sorts[currentTab][group] || (sorts[currentTab][group] = {});
          if (state.sort === col) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
          else {
            state.sort = col;
            state.dir = 'asc';
          }
          resetAdminSortPages(pages, currentTab, group);
          updateExportLinks();
          if (currentTab === 'stores') await loadStores();
          else await loadTab();
        });
      });
      document.querySelectorAll('[data-page-dir]').forEach((btn) => {
        btn.onclick = () => withBusy(btn, async () => {
          syncFilterInputs();
          const box = btn.closest('[data-tab-page]');
          const tab = box.dataset.tabPage;
          const key = box.dataset.pageKey;
          pages[tab][key] = Math.max(1, Number(pages[tab][key] || 1) + (btn.dataset.pageDir === 'next' ? 1 : -1));
          if (box.dataset.reload === 'loadStores') await loadStores();
          else await loadTab();
        });
      });
    }

    function esc(value) {
      return String(value ?? '').replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    }

    $('sendCode').onclick = () => withBusy($('sendCode'), async () => {
      $('loginStatus').textContent = L('sending');
      await api('/api/admin/login/start', { method:'POST', body: JSON.stringify({ telegram_id:$('loginId').value }) });
      $('loginStatus').textContent = L('sent_code');
    });
    $('verifyCode').onclick = () => withBusy($('verifyCode'), async () => {
      await api('/api/admin/login/verify', { method:'POST', body: JSON.stringify({ telegram_id:$('loginId').value, code:$('loginCode').value }) });
      await boot();
    });
    $('logout').onclick = () => withBusy($('logout'), async () => { await api('/api/admin/logout', { method:'POST' }); location.reload(); });
    $('uiLang').onchange = async () => {
      uiLang = $('uiLang').value;
      localStorage.setItem('staffbot_admin_lang', uiLang);
      applyI18n();
      if (!$('app').classList.contains('hidden')) await loadTab();
    };
    document.querySelectorAll('nav button').forEach((b) => b.onclick = () => { syncFilterInputs(); currentTab = b.dataset.tab; loadTab(); });
    boot();
  </script>
</body>
</html>`;
}
