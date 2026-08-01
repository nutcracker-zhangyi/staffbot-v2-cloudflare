export const MANAGE_CLIENT = String.raw`const app = document.getElementById('app');

const state = {
  session: null,
  csrfToken: '',
  stores: [],
  storeId: '',
  taskType: '',
  tasks: [],
  payroll: [],
  payrollListGeneration: 0,
  activeNav: 'tasks',
  currentTask: null,
  currentPayroll: null,
  payrollMode: 'dossier',
  paymentAmounts: { bank: '', usdt: '', cash: '' },
  paymentErrors: { bank: '', usdt: '', cash: '' },
  proofUploads: [],
  paymentBusy: false,
  submitKey: '',
  submitAttemptId: '',
  claimTimer: 0,
  online: navigator.onLine,
  decisionMode: '',
  message: '',
  requestGeneration: 0,
  taskListGeneration: 0,
  mutationBusy: false,
  authorityStale: false,
  renewRetry: null
};

const approvalTypes = new Set(['income', 'leave', 'absence', 'advance']);
const taskLabels = {
  income: '收入',
  leave: '请假',
  absence: '缺勤罚款',
  advance: '预支工资',
  payroll: '工资付款'
};
const statusLabels = {
  pending: '待处理',
  approved: '已通过',
  rejected: '已拒绝',
  disputed: '员工反馈问题',
  awaiting_admin_payment: '等待付款'
};

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function api(path, options = {}) {
  const method = options.method || 'GET';
  const multipart = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const headers = { ...(multipart ? {} : { 'content-type': 'application/json' }), ...(options.headers || {}) };
  if (method !== 'GET' && state.csrfToken && path.startsWith('/api/manage/')) {
    headers['x-csrf-token'] = state.csrfToken;
  }
  const response = await fetch(path, { ...options, method, headers });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || 'request_failed');
    error.status = response.status;
    error.result = result;
    throw error;
  }
  return result;
}

function loginView() {
  stopClaimTimer();
  app.innerHTML = '<section class="auth-card">'
    + '<p class="eyebrow">StaffBot</p>'
    + '<h1>管理端登录</h1>'
    + '<p>验证码将发送到管理员的 Telegram。</p>'
    + '<label for="telegram-id">Telegram 管理员 ID</label>'
    + '<input id="telegram-id" autocomplete="username" inputmode="numeric">'
    + '<button id="send-code" type="button">发送验证码</button>'
    + '<label for="login-code">验证码</label>'
    + '<input id="login-code" autocomplete="one-time-code" inputmode="numeric">'
    + '<button id="verify-code" type="button">登录</button>'
    + '<p id="login-status" role="status"></p>'
    + '</section>';

  document.getElementById('send-code').onclick = async () => {
    const telegramId = document.getElementById('telegram-id').value;
    try {
      await api('/api/admin/login/start', {
        method: 'POST',
        body: JSON.stringify({ telegram_id: telegramId })
      });
      document.getElementById('login-status').textContent = '验证码已发送';
    } catch (error) {
      document.getElementById('login-status').textContent = error.message;
    }
  };

  document.getElementById('verify-code').onclick = async () => {
    const telegramId = document.getElementById('telegram-id').value;
    const code = document.getElementById('login-code').value;
    try {
      await api('/api/admin/login/verify', {
        method: 'POST',
        body: JSON.stringify({ telegram_id: telegramId, code })
      });
      await boot();
    } catch (error) {
      document.getElementById('login-status').textContent = error.message;
    }
  };
}

function resetAuthenticatedState() {
  stopClaimTimer();
  state.requestGeneration += 1;
  state.session = null;
  state.csrfToken = '';
  state.stores = [];
  state.storeId = '';
  state.taskType = '';
  state.tasks = [];
  state.payroll = [];
  state.payrollListGeneration = 0;
  state.activeNav = 'tasks';
  state.currentTask = null;
  clearPayrollState();
  state.online = navigator.onLine;
  state.decisionMode = '';
  state.message = '';
  state.taskListGeneration = 0;
  state.mutationBusy = false;
  state.authorityStale = false;
  state.renewRetry = null;
}

function shell(content) {
  app.innerHTML = '<header class="app-header">'
    + '<div><p class="eyebrow">StaffBot</p><h1>移动管理端</h1></div>'
    + '<span class="account">' + escapeHtml(state.session.telegram_id) + '</span>'
    + '</header>'
    + '<div id="offline-banner" class="offline" role="status"'
    + (state.online ? ' hidden' : '')
    + '>当前离线，只能查看已加载内容</div>'
    + '<p id="app-message" class="app-message" role="status">'
    + escapeHtml(state.message) + '</p>'
    + '<section class="content">' + content + '</section>'
    + '<nav class="bottom-nav" aria-label="Bottom navigation">'
    + navButton('tasks', '待办')
    + navButton('approvals', '审批')
    + navButton('payroll', '工资')
    + navButton('more', '更多')
    + '</nav>';

  for (const [name, id] of [['tasks', 'nav-tasks'], ['approvals', 'nav-approvals'], ['payroll', 'nav-payroll'], ['more', 'nav-more']]) {
    document.getElementById(id).onclick = () => {
      state.requestGeneration += 1;
      state.activeNav = name;
      state.currentTask = null;
      clearPayrollState();
      state.decisionMode = '';
      state.message = '';
      state.authorityStale = false;
      state.renewRetry = null;
      stopClaimTimer();
      if (name === 'payroll') loadPayroll();
      else renderCurrent();
    };
  }
}

function navButton(name, label) {
  return '<button id="nav-' + name + '" type="button"'
    + (state.activeNav === name ? ' aria-current="page"' : '')
    + '>' + label + '</button>';
}

function renderCurrent() {
  if (state.currentTask) return renderTaskDetail();
  if (state.currentPayroll) return renderPayrollDetail();
  if (state.activeNav === 'tasks' || state.activeNav === 'approvals') {
    return renderTaskList();
  }
  if (state.activeNav === 'payroll') {
    return renderPayrollList();
  }
  shell('<div class="more-panel"><h2>更多</h2>'
    + '<p id="session-admin">已登录：' + escapeHtml(state.session.telegram_id) + '</p>'
    + '<button id="logout" class="secondary" type="button">退出登录</button></div>');
  document.getElementById('logout').onclick = async () => {
    try {
      await api('/api/admin/logout', { method: 'POST' });
    } finally {
      resetAuthenticatedState();
      loginView();
    }
  };
}

function taskListFilters() {
  const stores = ['<option value="">全部店铺</option>'].concat(state.stores.map((store) => (
    '<option value="' + escapeHtml(store.store_id) + '"'
      + (state.storeId === store.store_id ? ' selected' : '')
      + '>' + escapeHtml(store.name) + '</option>'
  ))).join('');
  return '<div class="filters">'
    + '<label for="store-filter">店铺</label><select id="store-filter">' + stores + '</select>'
    + '<label for="type-filter">类型</label><select id="type-filter">'
    + '<option value="">全部类型</option>'
    + '<option value="income">收入</option><option value="leave">请假</option>'
    + '<option value="absence">缺勤罚款</option><option value="advance">预支工资</option>'
    + '</select></div>';
}

function renderTaskList() {
  stopClaimTimer();
  const approvalOnly = state.activeNav === 'approvals';
  const tasks = approvalOnly
    ? state.tasks.filter((task) => approvalTypes.has(task.task_type))
    : state.tasks;
  const cards = tasks.length ? tasks.map(taskCard).join('')
    : '<div class="empty-state"><h3>暂无待办</h3><p>新的任务会显示在这里。</p></div>';
  shell('<div class="section-heading"><div><p class="eyebrow">'
    + (approvalOnly ? '审批中心' : '任务中心') + '</p><h2>'
    + (approvalOnly ? '审批' : '待办任务') + '</h2></div><span>' + tasks.length + ' 项</span></div>'
    + taskListFilters()
    + '<div id="task-list" class="task-list">' + cards + '</div>');

  const storeFilter = document.getElementById('store-filter');
  const typeFilter = document.getElementById('type-filter');
  storeFilter.onchange = async () => {
    state.storeId = storeFilter.value;
    await loadTasks();
  };
  typeFilter.value = state.taskType;
  typeFilter.onchange = async () => {
    state.taskType = typeFilter.value;
    await loadTasks();
  };
  tasks.forEach((task, index) => {
    const button = document.getElementById('open-task-' + index);
    if (button) button.onclick = () => openTask(task.task_type, task.task_id);
  });
}

function taskCard(task, index) {
  const amount = task.amount_micros !== null && task.amount_micros !== undefined
    ? formatMoney(task.amount_micros, task.currency)
    : escapeHtml(task.business_date || '无金额');
  const handler = claimIsActive(task.claim)
    ? '处理人：' + escapeHtml(task.claim.claimed_by)
    : '未领取';
  const action = approvalTypes.has(task.task_type)
    ? '<button id="open-task-' + index + '" class="secondary" type="button">查看详情</button>'
    : '<span class="muted">请到工资页处理</span>';
  return '<article class="task-card">'
    + '<div class="task-card-top"><span class="type-badge">'
    + escapeHtml(taskLabels[task.task_type] || task.task_type)
    + '</span><span class="urgency">' + urgencyLabel(task.urgency) + '</span></div>'
    + '<h3>' + escapeHtml(task.employee_name) + '</h3>'
    + '<p>' + escapeHtml(task.store_name) + ' · ' + amount + '</p>'
    + '<p class="meta">' + escapeHtml(statusLabels[task.status] || task.status)
    + ' · ' + handler + '</p>'
    + '<p class="meta">业务日期：' + escapeHtml(task.business_date || '—') + '</p>'
    + '<p class="meta">提交：' + escapeHtml(formatDateTime(task.submitted_at)) + '</p>'
    + action + '</article>';
}

function clearPayrollState() {
  clearAttemptTransientState();
  state.currentPayroll = null;
  state.payrollMode = 'dossier';
  state.paymentAmounts = { bank: '', usdt: '', cash: '' };
  state.paymentErrors = { bank: '', usdt: '', cash: '' };
  state.paymentBusy = false;
}

function clearAttemptTransientState() {
  clearProofUploadState();
  state.submitKey = '';
  state.submitAttemptId = '';
}

function clearProofUploadState() {
  for (const upload of state.proofUploads || []) {
    if (upload.previewUrl) URL.revokeObjectURL(upload.previewUrl);
  }
  state.proofUploads = [];
}

function draftAttemptId(detail = state.currentPayroll) {
  const draft = detail && detail.attempts.find((attempt) => attempt.status === 'draft');
  return draft ? draft.attempt_id : '';
}

function adoptPayrollDossier(detail) {
  const previousAttemptId = draftAttemptId();
  for (const attempt of detail.attempts || []) {
    for (const proof of attempt.proofs || []) {
      if (!proof.attempt_id) proof.attempt_id = attempt.attempt_id;
    }
  }
  const nextAttemptId = draftAttemptId(detail);
  const transientAttemptIds = new Set([
    ...state.proofUploads.map((upload) => upload.attemptId),
    state.submitAttemptId
  ].filter(Boolean));
  if (
    (previousAttemptId && previousAttemptId !== nextAttemptId)
    || Array.from(transientAttemptIds).some((attemptId) => attemptId !== nextAttemptId)
  ) {
    clearAttemptTransientState();
  }
  state.currentPayroll = detail;
}

function payrollStoreOptions() {
  return ['<option value="">全部店铺</option>'].concat(state.stores.map((store) => (
    '<option value="' + escapeHtml(store.store_id) + '"'
      + (state.storeId === store.store_id ? ' selected' : '')
      + '>' + escapeHtml(store.name) + '</option>'
  ))).join('');
}

function renderPayrollList() {
  stopClaimTimer();
  const cards = state.payroll.length ? state.payroll.map((item, index) => {
    const store = state.stores.find((entry) => entry.store_id === item.store_id);
    const handler = claimIsActive(item.claim)
      ? '处理人：' + escapeHtml(item.claim.claimed_by)
      : '未领取';
    return '<article class="task-card"><div class="task-card-top">'
      + '<span class="type-badge">工资付款</span><span class="meta">版本 '
      + escapeHtml(item.current_attempt ? item.current_attempt.version : '—') + '</span></div>'
      + '<h3>' + escapeHtml(item.employee_name) + '</h3>'
      + '<p>' + escapeHtml(store ? store.name : item.store_id) + ' · '
      + formatMoney(item.amount_snapshot_micros, item.currency) + '</p>'
      + '<p class="meta">' + escapeHtml(statusLabels[item.status] || item.status)
      + ' · ' + handler + '</p>'
      + '<p class="meta">截止：' + escapeHtml(formatDateTime(item.cutoff_at)) + '</p>'
      + '<button id="open-payroll-' + index + '" class="secondary" type="button">查看工资档案</button>'
      + '</article>';
  }).join('') : '<div class="empty-state"><h3>暂无工资记录</h3><p>工资记录会显示在这里。</p></div>';
  shell('<div class="section-heading"><div><p class="eyebrow">工资中心</p><h2>工资</h2></div>'
    + '<span>' + state.payroll.length + ' 项</span></div>'
    + '<div class="filters payroll-filter"><label for="payroll-store-filter">店铺</label>'
    + '<select id="payroll-store-filter">' + payrollStoreOptions() + '</select></div>'
    + '<div class="task-list">' + cards + '</div>');
  const filter = document.getElementById('payroll-store-filter');
  filter.onchange = async () => {
    state.storeId = filter.value;
    await loadPayroll();
  };
  state.payroll.forEach((item, index) => {
    document.getElementById('open-payroll-' + index).onclick = () => openPayroll(item.payroll_id);
  });
}

async function loadPayroll({ render = true, generation = state.requestGeneration } = {}) {
  const listGeneration = state.payrollListGeneration + 1;
  state.payrollListGeneration = listGeneration;
  const storeIds = state.storeId
    ? [state.storeId]
    : state.stores.map((store) => store.store_id);
  try {
    const results = await Promise.all(storeIds.map((storeId) => api('/api/manage/stores/'
      + encodeURIComponent(storeId) + '/payroll')));
    if (
      !requestIsCurrent(generation)
      || listGeneration !== state.payrollListGeneration
      || state.activeNav !== 'payroll'
    ) return state.payroll;
    state.payroll = results.flatMap((result) => result.payroll || []);
    state.message = '';
  } catch {
    if (!requestIsCurrent(generation) || state.activeNav !== 'payroll') return state.payroll;
    state.payroll = [];
    state.message = '暂时无法加载工资记录';
  }
  if (render) renderCurrent();
  return state.payroll;
}

function payrollKey(detail = state.currentPayroll) {
  const payroll = detail && detail.payroll;
  return payroll ? payroll.store_id + ':' + payroll.payroll_id : '';
}

function payrollRequestIsCurrent(generation, key) {
  return Boolean(
    state.session
    && generation === state.requestGeneration
    && key === payrollKey()
  );
}

async function openPayroll(payrollId) {
  const item = state.payroll.find((row) => row.payroll_id === payrollId);
  if (!item) {
    state.message = '工资记录不存在或无权查看';
    renderCurrent();
    return;
  }
  const generation = state.requestGeneration + 1;
  state.requestGeneration = generation;
  clearPayrollState();
  const key = item.store_id + ':' + item.payroll_id;
  try {
    const detail = await api(payrollPath(item.store_id, item.payroll_id));
    if (generation !== state.requestGeneration || !state.session) return;
    if (!detail.payroll || detail.payroll.store_id + ':' + detail.payroll.payroll_id !== key) return;
    adoptPayrollDossier(detail);
    state.message = '';
    renderPayrollDetail();
  } catch (error) {
    if (generation !== state.requestGeneration || !state.session) return;
    state.message = error.status === 403 || error.status === 404
      ? '工资记录不存在或无权查看'
      : '暂时无法加载工资档案';
    renderCurrent();
  }
}

function payrollPath(storeId, payrollId) {
  return '/api/manage/stores/' + encodeURIComponent(storeId)
    + '/payroll/' + encodeURIComponent(payrollId);
}

function renderPayrollDetail() {
  const detail = state.currentPayroll;
  const payroll = detail.payroll;
  const store = state.stores.find((item) => item.store_id === payroll.store_id);
  const payment = state.payrollMode === 'payment' ? paymentForm(detail) : '';
  const handler = claimIsActive(payroll.claim)
    ? '当前处理人：' + escapeHtml(payroll.claim.claimed_by)
    : '当前未领取';
  shell('<button id="back-to-payroll" class="text-button" type="button">← 返回工资</button>'
    + '<article class="detail-card payroll-dossier"><div class="task-card-top">'
    + '<span class="type-badge">工资档案</span><span>'
    + escapeHtml(statusLabels[payroll.status] || payroll.status) + '</span></div>'
    + '<h2>' + escapeHtml(payroll.employee_name) + '</h2>'
    + '<p class="meta">店铺：' + escapeHtml(store ? store.name : payroll.store_id) + '</p>'
    + '<p id="claim-status" class="claim-status">' + handler + '</p>'
    + '<section><h3>固定工资事实</h3><dl class="facts">'
    + '<div><dt>工资总额</dt><dd>' + formatMoney(payroll.amount_snapshot_micros, payroll.currency) + '</dd></div>'
    + '<div><dt>工资周期</dt><dd>' + escapeHtml(formatDateTime(payroll.period_start))
    + ' — ' + escapeHtml(formatDateTime(payroll.cutoff_at)) + '</dd></div>'
    + '<div><dt>银行卡</dt><dd>' + escapeHtml(payroll.payment_profile.bank || '未提供') + '</dd></div>'
    + '<div><dt>USDT</dt><dd>' + escapeHtml(payroll.payment_profile.usdt || '未提供') + '</dd></div>'
    + '</dl>' + (payroll.payment_profile.has_usdt_qr
      ? '<figure class="proof-card payment-qr"><img src="'
        + escapeHtml(payroll.payment_profile.usdt_qr_url)
        + '" alt="员工 USDT 收款二维码" loading="lazy"><figcaption>USDT 收款二维码</figcaption></figure>'
      : '') + '</section>'
    + payrollAttemptsSection(detail.attempts)
    + historySection(detail.history)
    + (state.payrollMode === 'dossier' && payrollCanStart(payroll)
      ? '<button id="start-payroll-payment" type="button"'
        + disabled(!state.online || state.paymentBusy || claimOwnedByOther(payroll.claim))
        + '>领取并开始付款</button>' : '')
    + payment + '</article>');
  document.getElementById('back-to-payroll').onclick = () => {
    state.requestGeneration += 1;
    clearPayrollState();
    state.message = '';
    stopClaimTimer();
    renderCurrent();
  };
  const start = document.getElementById('start-payroll-payment');
  if (start) start.onclick = startPayrollPayment;
  bindPaymentControls();
  startPayrollClaimTimer();
}

function payrollCanStart(payroll) {
  return ['awaiting_admin_payment', 'disputed'].includes(payroll.status);
}

function claimOwnedByOther(claim) {
  return claimIsActive(claim) && claim.claimed_by !== state.session.telegram_id;
}

function payrollAttemptsSection(attempts) {
  const rows = Array.isArray(attempts) ? attempts : [];
  if (!rows.length) return '<section><h3>付款版本</h3><p class="empty-copy">暂无付款版本</p></section>';
  return '<section><h3>全部付款版本</h3><div class="attempt-history">'
    + rows.map((attempt) => '<article class="attempt-card"><div class="task-card-top"><strong>版本 '
      + escapeHtml(attempt.version) + '</strong><span>' + escapeHtml(attempt.status) + '</span></div>'
      + '<p>银行卡 ' + formatMoney(attempt.bank_micros, state.currentPayroll.payroll.currency)
      + ' · USDT ' + formatMoney(attempt.usdt_micros, state.currentPayroll.payroll.currency)
      + ' · 现金 ' + formatMoney(attempt.cash_micros, state.currentPayroll.payroll.currency) + '</p>'
      + (attempt.submitted_at
        ? '<p class="meta">提交：' + escapeHtml(attempt.submitted_by || '—') + ' · '
          + escapeHtml(formatDateTime(attempt.submitted_at)) + '</p>' : '')
      + (attempt.employee_response
        ? '<p class="meta">员工反馈：' + escapeHtml(attempt.employee_response) + ' · '
          + escapeHtml(formatDateTime(attempt.employee_responded_at)) + '</p>' : '')
      + '<div class="proof-grid">' + (attempt.proofs || []).map((proof) => (
        '<figure class="proof-card"><img src="' + escapeHtml(proof.url || privateProofUrl(proof.proof_id))
          + '" alt="' + escapeHtml(paymentMethodLabel(proof.method)) + '付款回执" loading="lazy">'
          + '<figcaption>' + escapeHtml(paymentMethodLabel(proof.method)) + ' · '
          + escapeHtml(formatDateTime(proof.uploaded_at)) + '</figcaption>'
          + (attempt.status === 'draft' && state.payrollMode === 'payment' && proof.superseded_at == null
            ? '<button id="delete-proof-' + escapeHtml(proof.proof_id)
              + '" class="danger" type="button">删除回执</button>' : '')
          + '</figure>'
      )).join('') + '</div></article>').join('')
    + '</div></section>';
}

function privateProofUrl(proofId) {
  const payroll = state.currentPayroll.payroll;
  return '/api/manage/stores/' + encodeURIComponent(payroll.store_id)
    + '/payroll/proofs/' + encodeURIComponent(proofId);
}

function paymentMethodLabel(method) {
  return { bank: '银行卡', usdt: 'USDT', cash: '现金' }[method] || method;
}

function currentDraft() {
  return state.currentPayroll && state.currentPayroll.attempts.find((attempt) => attempt.status === 'draft');
}

function paymentForm(detail) {
  const payroll = detail.payroll;
  const draft = currentDraft();
  if (!draft) return '<section class="payment-form"><p class="error">付款草稿不可用，当前页面只读。</p></section>';
  const totals = paymentTotals();
  const methods = ['bank', 'usdt', 'cash'].filter((method) => (
    payroll.payment_profile['accepts_' + method]
  ));
  return '<section class="payment-form"><h3>本次付款</h3>'
    + '<p class="meta">草稿版本 ' + escapeHtml(draft.version) + '</p>'
    + methods.map((method) => paymentMethodControl(method, draft)).join('')
    + '<dl class="payment-summary facts">'
    + '<div><dt>已分配</dt><dd id="payment-allocated">' + formatMoney(totals.allocated, payroll.currency) + '</dd></div>'
    + '<div><dt>工资总额</dt><dd id="payment-total">' + formatMoney(payroll.amount_snapshot_micros, payroll.currency) + '</dd></div>'
    + '<div><dt>差额</dt><dd id="payment-difference">' + formatMoney(totals.difference, payroll.currency) + '</dd></div>'
    + '</dl><p id="payment-error" class="error" role="alert"></p>'
    + '<button id="save-payment-draft" class="secondary" type="button"'
    + disabled(!canSavePaymentSplit()) + '>保存付款拆分</button>'
    + '<button id="submit-payroll-payment" type="button"'
    + disabled(!canSubmitPayment()) + '>提交付款并通知员工</button></section>';
}

function paymentMethodControl(method, draft) {
  const uploaded = (draft.proofs || []).filter((proof) => (
    proof.method === method && proof.superseded_at == null
  ));
  const pending = state.proofUploads.filter((upload) => (
    upload.attemptId === draft.attempt_id && upload.method === method
  ));
  return '<div class="payment-method"><label for="' + method + '-amount">'
    + paymentMethodLabel(method) + '金额</label>'
    + '<input id="' + method + '-amount" inputmode="decimal" value="'
    + escapeHtml(state.paymentAmounts[method]) + '" aria-describedby="' + method + '-amount-error">'
    + '<p id="' + method + '-amount-error" class="error">'
    + escapeHtml(state.paymentErrors[method]) + '</p>'
    + '<div class="upload-actions"><label class="file-action">拍照上传'
    + '<input id="' + method + '-camera" class="file-input" type="file"'
    + ' accept="image/jpeg,image/png,image/webp" capture="environment"></label>'
    + '<label class="file-action">从相册选择'
    + '<input id="' + method + '-library" class="file-input" type="file"'
    + ' accept="image/jpeg,image/png,image/webp" multiple></label></div>'
    + '<p class="meta">已保存 ' + uploaded.length + ' 张回执</p>'
    + '<div class="upload-list">' + pending.map(uploadStatus).join('') + '</div></div>';
}

function uploadStatus(upload) {
  const status = upload.status === 'uploading' ? '上传中'
    : upload.status === 'uploaded' ? '已上传' : '上传失败';
  return '<div class="upload-item"><span>' + escapeHtml(upload.file.name) + ' · ' + status + '</span>'
    + (upload.status === 'error'
      ? '<button id="retry-upload-' + upload.id + '" class="secondary" type="button">重试 '
        + escapeHtml(upload.file.name) + '</button>' : '') + '</div>';
}

function bindPaymentControls() {
  if (state.payrollMode !== 'payment') return;
  for (const method of ['bank', 'usdt', 'cash']) {
    const amount = document.getElementById(method + '-amount');
    if (amount) amount.oninput = () => {
      state.paymentAmounts[method] = amount.value;
      state.paymentErrors[method] = decimalToMicros(amount.value).error;
      updatePaymentValidation();
    };
    for (const source of ['camera', 'library']) {
      const input = document.getElementById(method + '-' + source);
      if (input) input.onchange = () => uploadProof(method, input.files);
    }
  }
  const save = document.getElementById('save-payment-draft');
  if (save) save.onclick = savePaymentDraft;
  const submit = document.getElementById('submit-payroll-payment');
  if (submit) submit.onclick = submitPayrollPayment;
  const draft = currentDraft();
  for (const proof of draft ? draft.proofs || [] : []) {
    const remove = document.getElementById('delete-proof-' + proof.proof_id);
    if (remove) remove.onclick = () => deleteDraftProof(proof.proof_id);
  }
  for (const upload of state.proofUploads) {
    if (!draft || upload.attemptId !== draft.attempt_id) continue;
    const retry = document.getElementById('retry-upload-' + upload.id);
    if (retry) retry.onclick = () => retryProofUpload(upload.id);
  }
}

function updatePaymentValidation() {
  const totals = paymentTotals();
  const payroll = state.currentPayroll.payroll;
  for (const method of ['bank', 'usdt', 'cash']) {
    const error = document.getElementById(method + '-amount-error');
    if (error) error.textContent = state.paymentErrors[method];
  }
  const allocated = document.getElementById('payment-allocated');
  if (allocated) allocated.textContent = formatMoney(totals.allocated, payroll.currency);
  const difference = document.getElementById('payment-difference');
  if (difference) difference.textContent = formatMoney(totals.difference, payroll.currency);
  const save = document.getElementById('save-payment-draft');
  if (save) save.disabled = !canSavePaymentSplit();
  const submit = document.getElementById('submit-payroll-payment');
  if (submit) submit.disabled = !canSubmitPayment();
}

function decimalToMicros(value) {
  const normalized = String(value == null ? '' : value).trim();
  if (normalized === '') return { micros: 0, error: '' };
  const match = normalized.match(/^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/);
  if (!match) return { micros: null, error: '请输入非负、最多 6 位小数的有效金额' };
  const micros = BigInt(match[1]) * 1000000n
    + BigInt((match[2] || '').padEnd(6, '0'));
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { micros: null, error: '请输入非负、最多 6 位小数的有效金额' };
  }
  return { micros: Number(micros), error: '' };
}

function paymentSplit() {
  const split = {};
  let valid = true;
  for (const method of ['bank', 'usdt', 'cash']) {
    const result = decimalToMicros(state.paymentAmounts[method]);
    split[method + '_micros'] = result.micros;
    state.paymentErrors[method] = result.error;
    if (result.error) valid = false;
  }
  return { split, valid };
}

function paymentTotals() {
  const parsed = paymentSplit();
  const values = Object.values(parsed.split);
  const allocated = parsed.valid
    ? values.reduce((sum, value) => sum + BigInt(value), 0n)
    : 0n;
  const total = state.currentPayroll
    ? BigInt(state.currentPayroll.payroll.amount_snapshot_micros)
    : 0n;
  return { allocated, difference: total - allocated, valid: parsed.valid, split: parsed.split };
}

function canMutatePayment() {
  return Boolean(
    state.online
    && !state.paymentBusy
    && !state.authorityStale
    && currentDraft()
    && ownsActiveClaim(state.currentPayroll.payroll)
  );
}

function canSubmitPayment() {
  if (!canMutatePayment()) return false;
  const totals = paymentTotals();
  if (!totals.valid || totals.difference !== 0n) return false;
  const draft = currentDraft();
  if (state.proofUploads.some((upload) => (
    upload.attemptId === draft.attempt_id && upload.status === 'uploading'
  ))) return false;
  return ['bank', 'usdt', 'cash'].every((method) => {
    const amount = totals.split[method + '_micros'];
    return amount === 0 || (draft.proofs || []).some((proof) => (
      proof.method === method
      && proof.attempt_id === draft.attempt_id
      && proof.superseded_at == null
    ));
  });
}

function canSavePaymentSplit() {
  if (!canMutatePayment()) return false;
  const totals = paymentTotals();
  return totals.valid && totals.difference === 0n;
}

async function startPayrollPayment() {
  if (!state.currentPayroll || !state.online || state.paymentBusy || state.authorityStale) return;
  const generation = state.requestGeneration;
  const key = payrollKey();
  const payroll = state.currentPayroll.payroll;
  state.paymentBusy = true;
  renderPayrollDetail();
  try {
    if (!ownsActiveClaim(payroll)) {
      const claimed = await api('/api/manage/tasks/payroll/'
        + encodeURIComponent(payroll.payroll_id) + '/claim', { method: 'POST' });
      if (!payrollRequestIsCurrent(generation, key)) return;
      payroll.claim = claimed.claim;
    }
    const result = await api(payrollPath(payroll.store_id, payroll.payroll_id)
      + '/attempts/draft', { method: 'POST' });
    if (!payrollRequestIsCurrent(generation, key)) return;
    const dossier = await api(payrollPath(payroll.store_id, payroll.payroll_id));
    if (!payrollRequestIsCurrent(generation, key)) return;
    const mergedDossier = {
      ...dossier,
      attempts: Array.from(dossier.attempts || [], (attempt) => ({
        ...attempt,
        proofs: Array.from(attempt.proofs || [])
      }))
    };
    const returnedIndex = mergedDossier.attempts.findIndex(
      (attempt) => attempt.attempt_id === result.attempt.attempt_id
    );
    mergedDossier.attempts = mergedDossier.attempts.map((attempt) => (
      attempt.attempt_id !== result.attempt.attempt_id && attempt.status === 'draft'
        ? { ...attempt, status: 'abandoned' }
        : attempt
    ));
    if (returnedIndex >= 0) {
      mergedDossier.attempts[returnedIndex] = {
        ...mergedDossier.attempts[returnedIndex],
        ...result.attempt,
        proofs: mergedDossier.attempts[returnedIndex].proofs
      };
    } else {
      mergedDossier.attempts.unshift({ ...result.attempt, proofs: result.attempt.proofs || [] });
    }
    adoptPayrollDossier(mergedDossier);
    const draft = state.currentPayroll.attempts.find(
      (attempt) => attempt.attempt_id === result.attempt.attempt_id
    );
    state.payrollMode = 'payment';
    state.paymentAmounts = {
      bank: microsToInput(draft.bank_micros),
      usdt: microsToInput(draft.usdt_micros),
      cash: microsToInput(draft.cash_micros)
    };
    state.message = '付款草稿已准备';
  } catch (error) {
    if (!payrollRequestIsCurrent(generation, key)) return;
    await payrollFailureRefresh(error, generation, key);
  } finally {
    if (payrollRequestIsCurrent(generation, key)) {
      state.paymentBusy = false;
      renderPayrollDetail();
    }
  }
}

function microsToInput(micros) {
  const value = BigInt(micros || 0);
  const whole = value / 1000000n;
  const fraction = (value % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? whole + '.' + fraction : String(whole);
}

async function savePaymentDraft() {
  const totals = paymentTotals();
  if (!totals.valid || totals.difference !== 0n || !canMutatePayment()) {
    updatePaymentValidation();
    return null;
  }
  const generation = state.requestGeneration;
  const key = payrollKey();
  const payroll = state.currentPayroll.payroll;
  const draft = currentDraft();
  state.paymentBusy = true;
  renderPayrollDetail();
  try {
    const result = await api(payrollPath(payroll.store_id, payroll.payroll_id)
      + '/attempts/' + encodeURIComponent(draft.attempt_id) + '/split', {
      method: 'PUT', body: JSON.stringify(totals.split)
    });
    if (!payrollRequestIsCurrent(generation, key)) return null;
    Object.assign(draft, result.attempt);
    state.message = '付款拆分已保存';
    return result.attempt;
  } catch (error) {
    if (payrollRequestIsCurrent(generation, key)) {
      if (error.status === 400) state.message = '付款拆分无效，请核对金额';
      else await payrollFailureRefresh(error, generation, key);
    }
    return null;
  } finally {
    if (payrollRequestIsCurrent(generation, key)) {
      state.paymentBusy = false;
      renderPayrollDetail();
    }
  }
}

async function uploadProof(method, files) {
  if (!canMutatePayment()) return;
  const totals = paymentTotals();
  if (!totals.valid || totals.difference !== 0n) {
    updatePaymentValidation();
    return;
  }
  const draft = currentDraft();
  const splitChanged = ['bank', 'usdt', 'cash'].some((name) => (
    Number(draft[name + '_micros']) !== totals.split[name + '_micros']
  ));
  if (splitChanged && !await savePaymentDraft()) return;
  const accepted = Array.from(files || []);
  const attemptId = currentDraft().attempt_id;
  const uploads = accepted.map((file) => ({
      id: Date.now() + '-' + Math.random().toString(36).slice(2),
      attemptId, method, file, status: 'uploading', previewUrl: URL.createObjectURL(file)
    }));
  state.proofUploads.push(...uploads);
  renderPayrollDetail();
  await Promise.allSettled(uploads.map((upload) => performProofUpload(upload)));
}

async function performProofUpload(upload) {
  const generation = state.requestGeneration;
  const key = payrollKey();
  const payroll = state.currentPayroll.payroll;
  const draft = currentDraft();
  if (!draft || draft.attempt_id !== upload.attemptId) return;
  upload.status = 'uploading';
  renderPayrollDetail();
  const form = new FormData();
  form.append('method', upload.method);
  form.append('proof', upload.file);
  try {
    const result = await api(payrollPath(payroll.store_id, payroll.payroll_id)
      + '/attempts/' + encodeURIComponent(draft.attempt_id) + '/proofs', {
      method: 'POST', body: form
    });
    if (!payrollRequestIsCurrent(generation, key)) return;
    const proof = { ...result.proof, url: privateProofUrl(result.proof.proof_id) };
    draft.proofs = (draft.proofs || []).concat(proof);
    upload.status = 'uploaded';
    if (upload.previewUrl) URL.revokeObjectURL(upload.previewUrl);
    upload.previewUrl = '';
  } catch (error) {
    if (!payrollRequestIsCurrent(generation, key)) return;
    upload.status = 'error';
    upload.error = error.message;
    if (error.status === 409) await payrollFailureRefresh(error, generation, key);
  }
  if (payrollRequestIsCurrent(generation, key)) renderPayrollDetail();
}

async function retryProofUpload(uploadId) {
  const upload = state.proofUploads.find((item) => item.id === uploadId && item.status === 'error');
  const draft = currentDraft();
  if (!upload || !draft || upload.attemptId !== draft.attempt_id || !canMutatePayment()) return;
  await performProofUpload(upload);
}

async function deleteDraftProof(proofId) {
  if (!canMutatePayment() || !window.confirm('确定删除这张草稿回执？')) return;
  const generation = state.requestGeneration;
  const key = payrollKey();
  const payroll = state.currentPayroll.payroll;
  const draft = currentDraft();
  state.paymentBusy = true;
  renderPayrollDetail();
  try {
    await api(payrollPath(payroll.store_id, payroll.payroll_id)
      + '/attempts/' + encodeURIComponent(draft.attempt_id)
      + '/proofs/' + encodeURIComponent(proofId), { method: 'DELETE' });
    if (!payrollRequestIsCurrent(generation, key)) return;
    draft.proofs = (draft.proofs || []).filter((proof) => proof.proof_id !== proofId);
    state.message = '草稿回执已删除';
  } catch (error) {
    if (payrollRequestIsCurrent(generation, key)) await payrollFailureRefresh(error, generation, key);
  } finally {
    if (payrollRequestIsCurrent(generation, key)) {
      state.paymentBusy = false;
      renderPayrollDetail();
    }
  }
}

async function submitPayrollPayment() {
  if (!canSubmitPayment()) return;
  const saved = await savePaymentDraft();
  if (!saved || !state.currentPayroll || !canSubmitPayment()) return;
  const generation = state.requestGeneration;
  const key = payrollKey();
  const payroll = state.currentPayroll.payroll;
  const draft = currentDraft();
  state.paymentBusy = true;
  if (state.submitAttemptId !== draft.attempt_id) {
    state.submitKey = '';
    state.submitAttemptId = draft.attempt_id;
  }
  state.submitKey = state.submitKey || payroll.payroll_id + ':' + draft.attempt_id + ':' + Date.now();
  renderPayrollDetail();
  try {
    await api(payrollPath(payroll.store_id, payroll.payroll_id)
      + '/attempts/' + encodeURIComponent(draft.attempt_id) + '/submit', {
      method: 'POST', headers: { 'Idempotency-Key': state.submitKey }
    });
    if (!payrollRequestIsCurrent(generation, key)) return;
    await refreshPayrollDossier('付款已提交，员工通知处理中', generation, key);
    state.payrollMode = 'dossier';
    state.submitKey = '';
    state.submitAttemptId = '';
  } catch (error) {
    if (payrollRequestIsCurrent(generation, key)) {
      await payrollFailureRefresh(error, generation, key, { retryAttemptId: draft.attempt_id });
    }
  } finally {
    if (payrollRequestIsCurrent(generation, key)) {
      state.paymentBusy = false;
      renderPayrollDetail();
    }
  }
}

async function refreshPayrollDossier(message, generation = state.requestGeneration, key = payrollKey()) {
  const payroll = state.currentPayroll.payroll;
  const detail = await api(payrollPath(payroll.store_id, payroll.payroll_id));
  if (!payrollRequestIsCurrent(generation, key)) return;
  if (!detail.payroll || detail.payroll.store_id + ':' + detail.payroll.payroll_id !== key) {
    throw new Error('invalid_payroll_detail');
  }
  adoptPayrollDossier(detail);
  state.message = message;
}

async function payrollFailureRefresh(error, generation, key, { retryAttemptId = '' } = {}) {
  const submitResultUnknown = Boolean(retryAttemptId && (!error.status || error.status >= 500));
  try {
    await refreshPayrollDossier(
      error.status === 409 ? '工资状态已更新，当前页面已切换为只读' : '网络操作失败，已刷新最新工资档案',
      generation,
      key
    );
  } catch {
    if (!payrollRequestIsCurrent(generation, key)) return;
    state.authorityStale = true;
    state.message = '最新工资状态加载失败，当前页面已锁定，请返回工资列表刷新';
  }
  if (!payrollRequestIsCurrent(generation, key)) return;
  const sameUnknownAttempt = Boolean(
    submitResultUnknown
    && !state.authorityStale
    && draftAttemptId() === retryAttemptId
    && state.submitAttemptId === retryAttemptId
  );
  if (sameUnknownAttempt) {
    state.payrollMode = 'payment';
    state.message = '提交结果未知，已刷新当前草稿；重试会使用同一提交编号';
  } else {
    if (!submitResultUnknown && state.submitAttemptId === retryAttemptId) {
      state.submitKey = '';
      state.submitAttemptId = '';
    }
    state.payrollMode = 'dossier';
  }
}

function startPayrollClaimTimer() {
  stopClaimTimer();
  if (!state.currentPayroll) return;
  const payroll = state.currentPayroll.payroll;
  const claim = payroll.claim;
  if (!claimIsActive(claim) || state.authorityStale) return;
  const remaining = new Date(claim.lease_expires_at).getTime() - Date.now();
  const generation = state.requestGeneration;
  const key = payrollKey();
  if (claim.claimed_by === state.session.telegram_id && state.online && !state.paymentBusy) {
    const renewIn = Math.min(5 * 60 * 1000, Math.max(0, remaining - 30 * 1000));
    state.claimTimer = setTimeout(async () => {
      state.claimTimer = 0;
      if (!payrollRequestIsCurrent(generation, key)) return;
      try {
        const result = await api('/api/manage/tasks/payroll/'
          + encodeURIComponent(payroll.payroll_id) + '/renew', { method: 'POST' });
        if (!payrollRequestIsCurrent(generation, key)) return;
        payroll.claim = result.claim;
      } catch (error) {
        if (payrollRequestIsCurrent(generation, key)) await payrollFailureRefresh(error, generation, key);
      }
      if (payrollRequestIsCurrent(generation, key)) renderPayrollDetail();
    }, renewIn);
    return;
  }
  state.claimTimer = setTimeout(() => {
    state.claimTimer = 0;
    if (payrollRequestIsCurrent(generation, key)) renderPayrollDetail();
  }, Math.max(0, remaining) + 1);
}

function urgencyLabel(value) {
  const urgency = Number(value || 0);
  if (urgency >= 500) return '紧急';
  if (urgency >= 300) return '优先';
  return '普通';
}

function compareManageTasks(left, right) {
  const leftUrgency = Number(left && left.urgency);
  const rightUrgency = Number(right && right.urgency);
  const normalizedLeftUrgency = Number.isFinite(leftUrgency) ? leftUrgency : 0;
  const normalizedRightUrgency = Number.isFinite(rightUrgency) ? rightUrgency : 0;
  if (normalizedLeftUrgency !== normalizedRightUrgency) {
    return normalizedRightUrgency - normalizedLeftUrgency;
  }
  const leftSubmittedAt = String(left && left.submitted_at);
  const rightSubmittedAt = String(right && right.submitted_at);
  if (leftSubmittedAt !== rightSubmittedAt) {
    return leftSubmittedAt < rightSubmittedAt ? -1 : 1;
  }
  const leftTaskId = String(left && left.task_id);
  const rightTaskId = String(right && right.task_id);
  if (leftTaskId === rightTaskId) return 0;
  return leftTaskId < rightTaskId ? -1 : 1;
}

function formatMoney(micros, currency) {
  const amount = BigInt(micros || 0);
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const whole = (absolute / 1000000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = (absolute % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return escapeHtml(currency || '') + (negative ? '-' : '') + whole
    + (fraction ? '.' + fraction : '');
}

function formatDateTime(value) {
  return String(value || '').replace('T', ' ').slice(0, 16);
}

function ownsActiveClaim(task) {
  const claim = task && task.claim;
  return Boolean(
    state.online
    && claim
    && claimIsActive(claim)
    && claim.claimed_by === state.session.telegram_id
  );
}

function ownsClaim(task) {
  const claim = task && task.claim;
  return Boolean(
    claim
    && claimIsActive(claim)
    && claim.claimed_by === state.session.telegram_id
  );
}

function claimIsActive(claim) {
  return Boolean(
    claim
    && claim.active !== false
    && new Date(claim.lease_expires_at).getTime() > Date.now()
  );
}

function renderTaskDetail() {
  const detail = state.currentTask;
  const task = detail.task;
  const claim = task.claim;
  const owned = ownsActiveClaim(task);
  const pending = task.status === 'pending';
  const canDecide = owned && pending && !state.mutationBusy && !state.authorityStale;
  const handler = claimIsActive(claim)
    ? '当前处理人：' + escapeHtml(claim.claimed_by)
    : '当前未领取';
  const result = statusLabels[task.status] || task.status;
  let decision = '';
  if (pending && state.decisionMode === 'approve') {
    decision = '<div class="confirm-panel" role="alert"><p>确认批准这项申请？</p>'
      + '<button id="approve-confirm" type="button"' + disabled(!canDecide) + '>确认批准</button>'
      + '<button id="decision-cancel" class="secondary" type="button">取消</button></div>';
  } else if (pending && state.decisionMode === 'reject') {
    decision = '<div class="confirm-panel"><label for="reject-reason">拒绝原因（必填）</label>'
      + '<textarea id="reject-reason" rows="3"></textarea>'
      + '<p id="decision-error" class="error" role="alert"></p>'
      + '<button id="reject-confirm" type="button"' + disabled(!canDecide) + '>确认拒绝</button>'
      + '<button id="decision-cancel" class="secondary" type="button">取消</button></div>';
  }
  const claimAction = !pending ? '' : owned
    ? '<button id="release" class="secondary" type="button"'
      + disabled(!state.online || state.mutationBusy || state.authorityStale) + '>释放</button>'
    : '<button id="claim" type="button"'
      + disabled(
        !state.online || state.mutationBusy || state.authorityStale || claimIsActive(claim)
      ) + '>领取</button>';
  const requestFacts = Object.entries(detail.request || {}).map(([key, value]) => (
    '<div><dt>' + escapeHtml(factLabel(key)) + '</dt><dd>' + escapeHtml(factValue(key, value)) + '</dd></div>'
  )).join('');

  shell('<button id="back-to-tasks" class="text-button" type="button">← 返回待办</button>'
    + '<article class="detail-card"><div class="task-card-top"><span class="type-badge">'
    + escapeHtml(taskLabels[task.task_type] || task.task_type)
    + '</span><span class="urgency">' + urgencyLabel(task.urgency) + '</span></div>'
    + '<h2>' + escapeHtml(task.employee_name) + '</h2>'
    + '<p>' + escapeHtml(task.store_name)
    + (task.amount_micros !== null && task.amount_micros !== undefined
      ? ' · ' + formatMoney(task.amount_micros, task.currency) : '')
    + '</p><p>业务日期：' + escapeHtml(task.business_date || '—') + '</p>'
    + '<p>提交：' + escapeHtml(formatDateTime(task.submitted_at)) + '</p>'
    + '<p id="claim-status" class="claim-status">' + handler + '</p>'
    + '<p id="decision-status" class="decision-status">' + escapeHtml(result) + '</p>'
    + '<div class="claim-actions">' + claimAction + '</div>'
    + '<section><h3>申请信息</h3><dl class="facts">' + requestFacts + '</dl></section>'
    + employeeSection(detail.employee)
    + attachmentSection(detail.attachments)
    + historySection(detail.history)
    + '<div id="approval-actions" class="approval-actions" aria-disabled="' + (!canDecide) + '">'
    + '<button id="approve" type="button"' + disabled(!canDecide) + '>批准</button>'
    + '<button id="reject" class="danger" type="button"' + disabled(!canDecide) + '>拒绝</button></div>'
    + decision + '</article>');

  document.getElementById('back-to-tasks').onclick = () => {
    state.requestGeneration += 1;
    state.currentTask = null;
    state.decisionMode = '';
    state.message = '';
    state.authorityStale = false;
    state.renewRetry = null;
    stopClaimTimer();
    renderCurrent();
  };
  const claimButton = document.getElementById('claim');
  if (claimButton) claimButton.onclick = claimCurrentTask;
  const releaseButton = document.getElementById('release');
  if (releaseButton) releaseButton.onclick = releaseCurrentTask;
  document.getElementById('approve').onclick = () => {
    if (!canDecide) return;
    state.decisionMode = 'approve';
    renderTaskDetail();
  };
  document.getElementById('reject').onclick = () => {
    if (!canDecide) return;
    state.decisionMode = 'reject';
    renderTaskDetail();
    document.getElementById('reject-reason').focus();
  };
  const approveConfirm = document.getElementById('approve-confirm');
  if (approveConfirm) approveConfirm.onclick = () => submitApproval('approve');
  const rejectConfirm = document.getElementById('reject-confirm');
  if (rejectConfirm) rejectConfirm.onclick = () => submitApproval('reject');
  const cancel = document.getElementById('decision-cancel');
  if (cancel) cancel.onclick = () => {
    state.decisionMode = '';
    renderTaskDetail();
  };
  startClaimTimer();
}

function disabled(value) {
  return value ? ' disabled aria-disabled="true"' : '';
}

function factLabel(key) {
  const labels = {
    request_id: '申请编号', store_id: '店铺编号', telegram_id: '员工编号',
    income: '收入', commission_income: '计薪金额', fine: '罚款',
    commission_rate: '提成比例', original_fine: '原罚款',
    leave_date: '请假日期', business_date: '业务日期', amount: '金额',
    requested_at: '申请时间', submitted_at: '提交时间', status: '状态',
    created_at: '创建时间', decided_at: '处理时间', admin_id: '处理人',
    reject_reason: '拒绝原因', cancellation_reason: '取消原因'
  };
  return labels[key] || key;
}

function factValue(key, value) {
  if (value == null || value === '') return '—';
  if (key === 'status') return statusLabels[value] || value;
  return value;
}

function employeeSection(employee = {}) {
  return '<section><h3>员工信息</h3><dl class="facts">'
    + '<div><dt>姓名</dt><dd>' + escapeHtml(employee.display_name || '—') + '</dd></div>'
    + '<div><dt>Telegram ID</dt><dd>' + escapeHtml(employee.telegram_id || '—') + '</dd></div>'
    + '<div><dt>语言</dt><dd>' + escapeHtml(employee.language || '—') + '</dd></div>'
    + '</dl></section>';
}

function attachmentSection(attachments) {
  const count = Array.isArray(attachments) ? attachments.length : 0;
  return '<section><h3>附件</h3><p class="empty-copy">'
    + (count ? '共有 ' + count + ' 个附件' : '暂无附件')
    + '</p></section>';
}

function historySection(history) {
  const rows = Array.isArray(history) ? history : [];
  if (!rows.length) {
    return '<section><h3>处理时间线</h3><p class="empty-copy">暂无处理记录</p></section>';
  }
  return '<section><h3>处理时间线</h3><ol class="timeline">'
    + rows.map((item) => '<li><strong>' + escapeHtml(item.action || '处理') + '</strong>'
      + '<span>' + escapeHtml(item.admin_id || '—') + ' · '
      + escapeHtml(formatDateTime(item.created_at)) + '</span>'
      + (item.details && item.details.reason
        ? '<span>原因：' + escapeHtml(item.details.reason) + '</span>' : '')
      + '</li>').join('')
    + '</ol></section>';
}

function currentTaskKey() {
  const task = state.currentTask && state.currentTask.task;
  return task ? task.task_type + ':' + task.task_id : '';
}

function requestIsCurrent(generation, key = '') {
  return Boolean(
    state.session
    && generation === state.requestGeneration
    && (!key || key === currentTaskKey())
  );
}

function taskQueryPath() {
  const query = new URLSearchParams();
  if (state.storeId) query.set('store_id', state.storeId);
  if (state.taskType) query.set('type', state.taskType);
  return '/api/manage/tasks?' + query.toString();
}

async function loadTasks({ render = true, generation = state.requestGeneration } = {}) {
  const queryPath = taskQueryPath();
  const listGeneration = state.taskListGeneration + 1;
  state.taskListGeneration = listGeneration;
  const result = await api(queryPath);
  if (
    !requestIsCurrent(generation)
    || listGeneration !== state.taskListGeneration
    || queryPath !== taskQueryPath()
  ) return state.tasks;
  state.tasks = (result.tasks || []).slice().sort(compareManageTasks);
  if (render) renderCurrent();
  return state.tasks;
}

async function openTask(type, id) {
  if (!approvalTypes.has(type)) return;
  const task = state.tasks.find((item) => item.task_type === type && item.task_id === id);
  if (!task) {
    state.message = '任务不存在或无权查看';
    renderCurrent();
    return;
  }
  const generation = state.requestGeneration + 1;
  state.requestGeneration = generation;
  state.mutationBusy = false;
  state.authorityStale = false;
  state.renewRetry = null;
  const key = type + ':' + id;
  try {
    const detail = await api('/api/manage/stores/'
      + encodeURIComponent(task.store_id) + '/approvals/'
      + encodeURIComponent(type) + '/' + encodeURIComponent(id));
    if (generation !== state.requestGeneration || !state.session) return;
    if (
      !detail.task
      || detail.task.task_type + ':' + detail.task.task_id !== key
    ) return;
    state.currentTask = detail;
    state.decisionMode = '';
    state.message = '';
    renderTaskDetail();
  } catch (error) {
    if (generation !== state.requestGeneration || !state.session) return;
    state.message = error.status === 403 || error.status === 404
      ? '任务不存在或无权查看'
      : '暂时无法加载任务';
    renderCurrent();
  }
}

async function mutateClaim(action) {
  if (
    !state.currentTask
    || !state.online
    || state.mutationBusy
    || state.authorityStale
  ) return;
  const task = state.currentTask.task;
  const generation = state.requestGeneration;
  const key = currentTaskKey();
  state.mutationBusy = true;
  renderTaskDetail();
  try {
    const result = await api('/api/manage/tasks/'
      + encodeURIComponent(task.task_type) + '/'
      + encodeURIComponent(task.task_id) + '/' + action, { method: 'POST' });
    if (!requestIsCurrent(generation, key)) return null;
    task.claim = result.claim;
    state.renewRetry = null;
    state.message = action === 'release'
      ? '任务已释放'
      : action === 'renew' ? '领取状态已续期' : '任务已领取';
    return result.claim;
  } catch (error) {
    if (!requestIsCurrent(generation, key)) return null;
    if (error.status === 409) {
      try {
        await refreshCurrentTask('任务状态已更新', generation, key);
      } catch {
        if (requestIsCurrent(generation, key)) markAuthorityStale();
      }
      return null;
    }
    if (action === 'renew') recordRenewFailure(key, task.claim);
    state.message = '操作失败，请稍后重试';
    return null;
  } finally {
    if (requestIsCurrent(generation, key)) {
      state.mutationBusy = false;
      renderTaskDetail();
    }
  }
}

function claimCurrentTask() {
  return mutateClaim('claim');
}

function renewCurrentClaim() {
  return mutateClaim('renew');
}

function releaseCurrentTask() {
  return mutateClaim('release');
}

async function submitApproval(decision) {
  if (
    !state.currentTask
    || !ownsActiveClaim(state.currentTask.task)
    || state.mutationBusy
    || state.authorityStale
  ) return;
  let reason = '';
  if (decision === 'reject') {
    reason = document.getElementById('reject-reason').value.trim();
    if (!reason) {
      document.getElementById('decision-error').textContent = '请填写拒绝原因';
      return;
    }
  }
  const task = state.currentTask.task;
  const generation = state.requestGeneration;
  const key = currentTaskKey();
  state.mutationBusy = true;
  renderTaskDetail();
  try {
    const result = await api('/api/manage/stores/'
      + encodeURIComponent(task.store_id) + '/approvals/'
      + encodeURIComponent(task.task_type) + '/'
      + encodeURIComponent(task.task_id) + '/' + decision, {
      method: 'POST',
      body: decision === 'reject' ? JSON.stringify({ reason }) : undefined
    });
    if (!requestIsCurrent(generation, key)) return;
    state.decisionMode = '';
    const committedMessage = result.notification && result.notification.status === 'failed'
      ? '审批已保存，Telegram 通知发送失败，可稍后重试'
      : '审批已完成';
    state.message = committedMessage;
    try {
      await refreshCurrentTask(committedMessage, generation, key);
    } catch {
      if (!requestIsCurrent(generation, key)) return;
      state.currentTask = null;
      state.tasks = [];
      state.decisionMode = '';
      state.message = '审批已保存，但最新状态加载失败，请刷新待办';
      state.mutationBusy = false;
      renderCurrent();
    }
  } catch (error) {
    if (!requestIsCurrent(generation, key)) return;
    if (error.status === 409) {
      try {
        await refreshCurrentTask('任务已由其他管理员处理', generation, key);
      } catch {
        if (requestIsCurrent(generation, key)) markAuthorityStale();
      }
      return;
    }
    state.message = error.message === 'rejection_reason_required'
      ? '请填写拒绝原因'
      : '审批失败，请稍后重试';
  } finally {
    if (requestIsCurrent(generation, key)) {
      state.mutationBusy = false;
      renderTaskDetail();
    }
  }
}

async function refreshCurrentTask(
  message,
  generation = state.requestGeneration,
  key = currentTaskKey()
) {
  const task = state.currentTask.task;
  const queryPath = taskQueryPath();
  const listGeneration = state.taskListGeneration + 1;
  state.taskListGeneration = listGeneration;
  const [detail, tasks] = await Promise.all([
    api('/api/manage/stores/'
      + encodeURIComponent(task.store_id) + '/approvals/'
      + encodeURIComponent(task.task_type) + '/' + encodeURIComponent(task.task_id)),
    api(queryPath)
  ]);
  if (
    !requestIsCurrent(generation, key)
    || listGeneration !== state.taskListGeneration
    || queryPath !== taskQueryPath()
  ) return;
  if (
    !detail.task
    || detail.task.task_type + ':' + detail.task.task_id !== key
  ) throw new Error('invalid_task_detail');
  state.currentTask = detail;
  state.tasks = tasks.tasks || [];
  state.decisionMode = '';
  state.message = message;
  renderTaskDetail();
}

function markAuthorityStale() {
  state.authorityStale = true;
  state.mutationBusy = false;
  state.decisionMode = '';
  state.message = '最新状态加载失败，当前任务已锁定，请返回待办刷新';
  stopClaimTimer();
  renderTaskDetail();
}

function recordRenewFailure(key, claim) {
  const prior = state.renewRetry && state.renewRetry.key === key
    ? state.renewRetry.attempts : 0;
  const attempts = prior + 1;
  const delay = Math.min(30 * 1000 * (2 ** (attempts - 1)), 5 * 60 * 1000);
  const expiry = new Date(claim.lease_expires_at).getTime();
  state.renewRetry = {
    key,
    attempts,
    nextAt: Math.min(Date.now() + delay, expiry)
  };
}

function startClaimTimer() {
  stopClaimTimer();
  if (!state.currentTask) return;
  const task = state.currentTask.task;
  const claim = task.claim;
  if (!claimIsActive(claim) || state.authorityStale) return;
  const remaining = new Date(claim.lease_expires_at).getTime() - Date.now();
  const generation = state.requestGeneration;
  const key = currentTaskKey();

  if (ownsClaim(task) && state.online && !state.mutationBusy) {
    const retry = state.renewRetry && state.renewRetry.key === key
      ? state.renewRetry : null;
    if (retry && retry.nextAt > Date.now()) {
      const retryAtExpiry = retry.nextAt >= new Date(claim.lease_expires_at).getTime();
      state.claimTimer = setTimeout(() => {
        state.claimTimer = 0;
        if (!requestIsCurrent(generation, key)) return;
        if (retryAtExpiry || !claimIsActive(state.currentTask.task.claim)) {
          renderTaskDetail();
        } else {
          renewCurrentClaim();
        }
      }, retry.nextAt - Date.now() + (retryAtExpiry ? 1 : 0));
      return;
    }
    if (remaining <= 5 * 60 * 1000) {
      renewCurrentClaim();
      return;
    }
    const renewIn = Math.min(5 * 60 * 1000, Math.max(0, remaining - 30 * 1000));
    state.claimTimer = setTimeout(() => {
      state.claimTimer = 0;
      if (requestIsCurrent(generation, key)) renewCurrentClaim();
    }, renewIn);
    return;
  }

  state.claimTimer = setTimeout(() => {
    state.claimTimer = 0;
    if (requestIsCurrent(generation, key)) renderTaskDetail();
  }, Math.max(0, remaining) + 1);
}

function stopClaimTimer() {
  if (state.claimTimer) clearTimeout(state.claimTimer);
  state.claimTimer = 0;
}

async function openReturnPath() {
  const path = String(location.pathname || '');
  if (!path.startsWith('/manage/')) return;
  const match = path.match(/^\/manage\/approvals\/([^/]+)\/([^/]+)$/);
  if (!match) return;
  let type;
  let id;
  try {
    type = decodeURIComponent(match[1]);
    id = decodeURIComponent(match[2]);
  } catch {
    return;
  }
  await openTask(type, id);
}

async function refreshPayrollAfterReconnect() {
  if (!state.currentPayroll) return;
  const payroll = state.currentPayroll.payroll;
  const key = payrollKey();
  const priorMode = state.payrollMode;
  const priorAttemptId = draftAttemptId();
  const generation = state.requestGeneration + 1;
  state.requestGeneration = generation;
  clearProofUploadState();
  state.authorityStale = true;
  state.paymentBusy = true;
  state.message = '已恢复网络，正在刷新最新工资状态';
  stopClaimTimer();
  renderPayrollDetail();
  try {
    const [detail, tasks, payrollList] = await Promise.all([
      api(payrollPath(payroll.store_id, payroll.payroll_id)),
      api('/api/manage/tasks?store_id=' + encodeURIComponent(payroll.store_id) + '&type=payroll'),
      api('/api/manage/stores/' + encodeURIComponent(payroll.store_id) + '/payroll')
    ]);
    if (!payrollRequestIsCurrent(generation, key)) return;
    if (!detail.payroll || detail.payroll.store_id + ':' + detail.payroll.payroll_id !== key) {
      throw new Error('invalid_payroll_detail');
    }
    const listItem = (payrollList.payroll || []).find((item) => item.payroll_id === payroll.payroll_id);
    const taskRows = tasks.tasks || [];
    if (taskRows.some((item) => (
      item.task_type !== 'payroll' || item.store_id !== payroll.store_id
    ))) {
      throw new Error('inconsistent_payroll_task_scope');
    }
    const taskItem = taskRows.find((item) => (
      item.task_type === 'payroll' && item.task_id === payroll.payroll_id
    ));
    const editable = payrollCanStart(detail.payroll);
    if (
      !listItem
      || listItem.store_id !== detail.payroll.store_id
      || listItem.status !== detail.payroll.status
      || claimSignature(listItem.claim) !== claimSignature(detail.payroll.claim)
    ) {
      throw new Error('inconsistent_payroll_authority');
    }
    if (editable && !taskItem) throw new Error('missing_editable_payroll_task');
    if (taskItem && (
      taskItem.store_id !== detail.payroll.store_id
      || taskItem.status !== detail.payroll.status
      || claimSignature(taskItem.claim) !== claimSignature(detail.payroll.claim)
    )) {
      throw new Error('inconsistent_payroll_authority');
    }
    adoptPayrollDossier(detail);
    state.tasks = state.tasks.filter((task) => !(
      task.task_type === 'payroll' && task.store_id === payroll.store_id
    )).concat(taskRows).sort(compareManageTasks);
    state.payroll = state.payroll.filter((item) => item.store_id !== payroll.store_id)
      .concat(payrollList.payroll || []);
    const sameEditableAttempt = Boolean(
      priorMode === 'payment'
      && priorAttemptId
      && draftAttemptId() === priorAttemptId
      && payrollCanStart(state.currentPayroll.payroll)
      && ownsActiveClaim(state.currentPayroll.payroll)
    );
    state.payrollMode = sameEditableAttempt ? 'payment' : 'dossier';
    state.authorityStale = false;
    state.paymentBusy = false;
    state.message = '最新工资状态已刷新';
    renderPayrollDetail();
  } catch {
    if (!payrollRequestIsCurrent(generation, key)) return;
    state.authorityStale = true;
    state.paymentBusy = false;
    state.message = '工资状态刷新失败，当前档案保持只读，请稍后重试';
    stopClaimTimer();
    renderPayrollDetail();
  }
}

function claimSignature(claim) {
  if (!claim) return '';
  return [
    String(claim.claimed_by || ''),
    String(claim.claimed_at || ''),
    String(claim.lease_expires_at || ''),
    claimIsActive(claim) ? 'active' : 'expired'
  ].join('|');
}

async function boot() {
  resetAuthenticatedState();
  try {
    await api('/api/admin/me');
  } catch {
    resetAuthenticatedState();
    loginView();
    return;
  }
  try {
    state.session = await api('/api/manage/session');
    state.csrfToken = state.session.csrf_token || '';
    const stores = await api('/api/manage/stores');
    state.stores = stores.stores || [];
    await loadTasks();
    await openReturnPath();
  } catch {
    resetAuthenticatedState();
    loginView();
  }
}

window.addEventListener('online', async () => {
  state.online = true;
  if (!state.session) return;
  if (state.currentPayroll) await refreshPayrollAfterReconnect();
  else renderCurrent();
});
window.addEventListener('offline', () => {
  state.online = false;
  if (state.session) renderCurrent();
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/manage/sw.js');
}

boot();
`;
