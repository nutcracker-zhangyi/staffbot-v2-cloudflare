export const MANAGE_CLIENT = String.raw`const app = document.getElementById('app');

const state = {
  session: null,
  csrfToken: '',
  stores: [],
  storeId: '',
  taskType: '',
  tasks: [],
  activeNav: 'tasks',
  currentTask: null,
  claimTimer: 0,
  online: navigator.onLine,
  decisionMode: '',
  message: ''
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
  const headers = {
    'content-type': 'application/json',
    ...(options.headers || {})
  };
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
      state.activeNav = name;
      state.currentTask = null;
      state.decisionMode = '';
      state.message = '';
      stopClaimTimer();
      renderCurrent();
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
  if (state.activeNav === 'tasks' || state.activeNav === 'approvals') {
    return renderTaskList();
  }
  if (state.activeNav === 'payroll') {
    shell('<div class="empty-state"><h2>工资</h2><p>工资任务将在下一阶段开放。</p></div>');
    return;
  }
  shell('<div class="more-panel"><h2>更多</h2>'
    + '<p id="session-admin">已登录：' + escapeHtml(state.session.telegram_id) + '</p>'
    + '<button id="logout" class="secondary" type="button">退出登录</button></div>');
  document.getElementById('logout').onclick = async () => {
    await api('/api/admin/logout', { method: 'POST' });
    state.session = null;
    state.csrfToken = '';
    loginView();
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
  const amount = task.amount_micros
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

function urgencyLabel(value) {
  const urgency = Number(value || 0);
  if (urgency >= 500) return '紧急';
  if (urgency >= 300) return '优先';
  return '普通';
}

function formatMoney(micros, currency) {
  const amount = Number(micros || 0) / 1000000;
  return escapeHtml(currency || '') + amount.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
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
  const canDecide = owned && pending;
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
    ? '<button id="release" class="secondary" type="button"' + disabled(!state.online) + '>释放</button>'
    : '<button id="claim" type="button"' + disabled(!state.online || claimIsActive(claim)) + '>领取</button>';
  const requestFacts = Object.entries(detail.request || {}).map(([key, value]) => (
    '<div><dt>' + escapeHtml(factLabel(key)) + '</dt><dd>' + escapeHtml(value == null ? '—' : value) + '</dd></div>'
  )).join('');

  shell('<button id="back-to-tasks" class="text-button" type="button">← 返回待办</button>'
    + '<article class="detail-card"><div class="task-card-top"><span class="type-badge">'
    + escapeHtml(taskLabels[task.task_type] || task.task_type)
    + '</span><span class="urgency">' + urgencyLabel(task.urgency) + '</span></div>'
    + '<h2>' + escapeHtml(task.employee_name) + '</h2>'
    + '<p>' + escapeHtml(task.store_name)
    + (task.amount_micros ? ' · ' + formatMoney(task.amount_micros, task.currency) : '')
    + '</p><p>业务日期：' + escapeHtml(task.business_date || '—') + '</p>'
    + '<p>提交：' + escapeHtml(formatDateTime(task.submitted_at)) + '</p>'
    + '<p id="claim-status" class="claim-status">' + handler + '</p>'
    + '<p id="decision-status" class="decision-status">' + escapeHtml(result) + '</p>'
    + '<div class="claim-actions">' + claimAction + '</div>'
    + '<section><h3>申请信息</h3><dl class="facts">' + requestFacts + '</dl></section>'
    + '<div id="approval-actions" class="approval-actions" aria-disabled="' + (!canDecide) + '">'
    + '<button id="approve" type="button"' + disabled(!canDecide) + '>批准</button>'
    + '<button id="reject" class="danger" type="button"' + disabled(!canDecide) + '>拒绝</button></div>'
    + decision + '</article>');

  document.getElementById('back-to-tasks').onclick = () => {
    state.currentTask = null;
    state.decisionMode = '';
    state.message = '';
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

async function loadTasks() {
  const query = new URLSearchParams();
  if (state.storeId) query.set('store_id', state.storeId);
  if (state.taskType) query.set('type', state.taskType);
  const result = await api('/api/manage/tasks?' + query.toString());
  state.tasks = result.tasks || [];
  renderCurrent();
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
  try {
    state.currentTask = await api('/api/manage/stores/'
      + encodeURIComponent(task.store_id) + '/approvals/'
      + encodeURIComponent(type) + '/' + encodeURIComponent(id));
    state.decisionMode = '';
    state.message = '';
    renderTaskDetail();
  } catch (error) {
    state.message = error.status === 403 || error.status === 404
      ? '任务不存在或无权查看'
      : '暂时无法加载任务';
    renderCurrent();
  }
}

async function mutateClaim(action) {
  if (!state.currentTask || !state.online) return;
  const task = state.currentTask.task;
  try {
    const result = await api('/api/manage/tasks/'
      + encodeURIComponent(task.task_type) + '/'
      + encodeURIComponent(task.task_id) + '/' + action, { method: 'POST' });
    task.claim = result.claim;
    state.message = action === 'release'
      ? '任务已释放'
      : action === 'renew' ? '领取状态已续期' : '任务已领取';
    renderTaskDetail();
    return result.claim;
  } catch (error) {
    if (error.status === 409) {
      await refreshCurrentTask('任务状态已更新');
      return null;
    }
    state.message = '操作失败，请稍后重试';
    renderTaskDetail();
    return null;
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
  if (!state.currentTask || !ownsActiveClaim(state.currentTask.task)) return;
  let reason = '';
  if (decision === 'reject') {
    reason = document.getElementById('reject-reason').value.trim();
    if (!reason) {
      document.getElementById('decision-error').textContent = '请填写拒绝原因';
      return;
    }
  }
  const task = state.currentTask.task;
  try {
    const result = await api('/api/manage/stores/'
      + encodeURIComponent(task.store_id) + '/approvals/'
      + encodeURIComponent(task.task_type) + '/'
      + encodeURIComponent(task.task_id) + '/' + decision, {
      method: 'POST',
      body: decision === 'reject' ? JSON.stringify({ reason }) : undefined
    });
    task.status = decision === 'approve' ? 'approved' : 'rejected';
    task.claim = null;
    state.decisionMode = '';
    state.message = result.notification && result.notification.status === 'failed'
      ? '审批已保存，Telegram 通知发送失败，可稍后重试'
      : '审批已完成';
    renderTaskDetail();
  } catch (error) {
    if (error.status === 409) {
      await refreshCurrentTask('任务已由其他管理员处理');
      return;
    }
    state.message = error.message === 'rejection_reason_required'
      ? '请填写拒绝原因'
      : '审批失败，请稍后重试';
    renderTaskDetail();
  }
}

async function refreshCurrentTask(message) {
  const task = state.currentTask.task;
  const detail = await api('/api/manage/stores/'
    + encodeURIComponent(task.store_id) + '/approvals/'
    + encodeURIComponent(task.task_type) + '/' + encodeURIComponent(task.task_id));
  state.currentTask = detail;
  state.decisionMode = '';
  state.message = message;
  renderTaskDetail();
}

function startClaimTimer() {
  stopClaimTimer();
  if (!state.currentTask || !ownsActiveClaim(state.currentTask.task)) return;
  state.claimTimer = setInterval(() => {
    if (state.currentTask && ownsActiveClaim(state.currentTask.task)) {
      renewCurrentClaim();
    }
  }, 5 * 60 * 1000);
}

function stopClaimTimer() {
  if (state.claimTimer) clearInterval(state.claimTimer);
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

async function boot() {
  try {
    await api('/api/admin/me');
  } catch {
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
    loginView();
  }
}

window.addEventListener('online', () => {
  state.online = true;
  renderCurrent();
});
window.addEventListener('offline', () => {
  state.online = false;
  renderCurrent();
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/manage/sw.js');
}

boot();
`;
