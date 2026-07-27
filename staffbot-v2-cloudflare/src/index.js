import {
  currentAdminStoreId,
  memberListQuery,
  resetAdminSortPages
} from './admin-query.js';
import {
  ABSENCE_HISTORY_COLUMNS,
  ABSENCE_PENDING_COLUMNS,
  processAbsenceFines
} from './absence.js';
import { handleAdminApi } from './admin-api.js';
import { logEvent } from './audit.js';
import { completedAttendanceDate } from './dates.js';
import { html, json } from './http.js';
import {
  isWebhookConfigReady,
  scheduledTasksEnabled,
  serviceEnvironment,
  webhookSecretMatches
} from './security.js';
import { handleUpdate } from './telegram.js';

export * from './admin-query.js';
export * from './dates.js';
export * from './ids.js';
export * from './money.js';
export * from './security.js';
export {
  attendanceEmployeeStats,
  normalizeAbsenceFineSetting,
  normalizeEmployeeAbsenceCheck
} from './admin-api.js';
export { approveLeaveRequest } from './approvals.js';
export {
  ABSENCE_HISTORY_COLUMNS,
  ABSENCE_PENDING_COLUMNS,
  absenceApprovalKeyboard,
  absenceScanDates,
  approveAbsenceFineRequest,
  cancelAbsenceForApprovedLeave,
  completedAttendanceDate,
  deliverAbsenceNotification,
  processAbsenceFines,
  rejectAbsenceFineRequest
} from './absence.js';
export { sanitizeLogPayload } from './audit.js';
export { render } from './i18n.js';
export {
  attendanceActionReplyMarkup,
  checkoutApprovalKeyboard,
  compactCallbackData,
  handleUpdate,
  incomeAdminNotificationText
} from './telegram.js';
export { telegram } from './telegram-client.js';

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
