import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { handleAdminApi } from '../src/admin-api.js';
import worker from '../src/index.js';
import routerWorker, { processScheduledWork } from '../src/router.js';
import { createD1 } from './helpers/d1.js';

const schema = readFileSync(
  new URL('../db/schema.sql', import.meta.url),
  'utf8'
);
function context() {
  const promises = [];
  return {
    promises,
    waitUntil(promise) {
      promises.push(Promise.resolve(promise));
    }
  };
}

function normalizedHtml(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function inlineAdminScript(document) {
  const match = String(document).match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, 'admin document should contain an inline script');
  return match[1];
}

test('keeps the Worker entrypoint as a compatibility facade', async () => {
  assert.equal(worker, routerWorker);

  const response = await worker.fetch(
    new Request('https://staffbot.test/'),
    { ENVIRONMENT: 'staging' },
    context()
  );
  assert.deepEqual(await response.json(), {
    ok: true,
    service: 'staffbot-v2',
    environment: 'staging',
    admin: '/admin'
  });
});

test('preserves the complete admin document contract', async () => {
  const response = await worker.fetch(
    new Request('https://staffbot.test/admin'),
    { ENVIRONMENT: 'staging' },
    context()
  );
  const document = normalizedHtml(await response.text());

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get('content-security-policy'),
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  );
  assert.match(document, /STAGING 测试环境/);

  for (const tab of [
    'stores',
    'members',
    'income',
    'salary',
    'advances',
    'attendance',
    'absence',
    'leave',
    'logs'
  ]) {
    assert.match(document, new RegExp(`data-tab="${tab}"`));
    assert.match(document, new RegExp(`id="tab-${tab}"`));
  }

  for (const selector of [
    'data-filter-date-from',
    'data-filter-date-to',
    'data-filter-employee',
    'data-filter-stores',
    'data-absence-status',
    'data-apply-filters',
    'data-absence-action',
    'data-income-delete-id',
    'data-income-fine-id',
    'data-attendance-detail'
  ]) {
    assert.match(document, new RegExp(selector));
  }

  for (const id of [
    'sendCode',
    'verifyCode',
    'logout',
    'saveStore',
    'saveMember'
  ]) {
    assert.match(document, new RegExp(`id="${id}"`));
  }
  assert.match(document, /USDT 二维码：已提供/);
  assert.match(document, /USDT 二维码：未提供/);
  assert.match(document, /查看 USDT 二维码/);
  assert.match(document, /usdt_qr_url/);
  assert.match(document, /target="_blank" rel="noopener"/);
});

test('serves the manage shell for encoded task deep links', async () => {
  const response = await worker.fetch(
    new Request(
      'https://staffbot.test/manage/tasks/payroll/PAYROLL-%2F1?store=STORE-1'
    ),
    { ENVIRONMENT: 'staging' },
    context()
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(await response.text(), /StaffBot 管理端/);
});

test('shows Dashboard only in staging and keeps production admin unchanged', async () => {
  const staging = await worker.fetch(
    new Request('https://staffbot.test/admin'),
    { ENVIRONMENT: 'staging' },
    context()
  );
  const production = await worker.fetch(
    new Request('https://staffbot.test/admin'),
    { ENVIRONMENT: 'production' },
    context()
  );
  const stagingDocument = normalizedHtml(await staging.text());
  const productionDocument = normalizedHtml(await production.text());
  const generalMobileCss = '@media (max-width: 720px) { main { padding:12px; } table { min-width:820px; } header { align-items:flex-start; flex-direction:column; padding:14px 12px; } .toolbar, .member-filter { align-items:stretch; } .member-filter > * { width:100%; } input, select, button { min-height:44px; } nav button { min-height:40px; } }';

  assert.match(stagingDocument, /data-tab="dashboard"/);
  assert.match(stagingDocument, /id="tab-dashboard"/);
  assert.match(stagingDocument, /data-dashboard-filter/);
  assert.match(stagingDocument, /data-dashboard-employee/);
  for (const marker of [
    'data-dashboard-chart="monthly"',
    'data-dashboard-chart="composition"',
    'data-dashboard-chart="employees"',
    'role="img"',
    'data-dashboard-table',
    'data-dashboard-entries',
    'data-dashboard-entry-page'
  ]) {
    assert.match(stagingDocument, new RegExp(marker));
  }
  assert.doesNotMatch(stagingDocument, /<script[^>]+src=/);
  assert.doesNotMatch(stagingDocument, /<link[^>]+cdn/i);
  assert.doesNotMatch(productionDocument, /data-tab="dashboard"/);
  assert.doesNotMatch(productionDocument, /id="tab-dashboard"/);
  for (const marker of [
    'data-dashboard-',
    '.dashboard-',
    'const dashboardFilters',
    'function dashboardQuery',
    'function renderDashboard',
    'function dashboardChartRange',
    'function dashboardLineChart',
    'function dashboardCompositionChart',
    'function dashboardEmployeeChart',
    'function renderDashboardEntries',
    '/dashboard/entries'
  ]) {
    assert.doesNotMatch(productionDocument, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(productionDocument, /dashboard/i);
  assert.ok(stagingDocument.includes(generalMobileCss));
  assert.ok(productionDocument.includes(generalMobileCss));
});

test('generated Dashboard client builds its independent query and formats signed micros', async () => {
  const response = await worker.fetch(
    new Request('https://staffbot.test/admin'),
    { ENVIRONMENT: 'staging' },
    context()
  );
  const script = inlineAdminScript(await response.text());
  new Function(script);

  const queryStart = script.indexOf('function dashboardQuery(');
  const queryEnd = script.indexOf('\n    async function renderDashboard', queryStart);
  const dashboardFilters = {
    dateFrom: '2026-07-01',
    dateTo: '2026-07-31',
    employee: 'all',
    stores: ['TOKYO', 'NEW_YORK'],
    employeeSort: 'fine_micros',
    employeeDir: 'asc',
    selectedEmployee: '',
    entriesPage: 3
  };
  const dashboardQuery = new Function(
    'dashboardFilters',
    'storeId',
    `${script.slice(queryStart, queryEnd)}; return dashboardQuery;`
  )(dashboardFilters, () => 'SHARED-STORE');
  const query = Object.fromEntries(new URLSearchParams(dashboardQuery({
    includeEntries: true,
    detailEmployeeId: 'EMP-1'
  })));

  assert.deepEqual(query, {
    stores: 'TOKYO,NEW_YORK',
    date_from: '2026-07-01',
    date_to: '2026-07-31',
    employee: 'EMP-1',
    employees_sort: 'fine_micros',
    employees_dir: 'asc',
    entries_page: '3'
  });

  const formatStart = script.indexOf('function formatDashboardMicros(');
  const formatEnd = script.indexOf('\n    function bindDashboardControls', formatStart);
  const formatDashboardMicros = new Function(
    'formatCurrencyAmount',
    `${script.slice(formatStart, formatEnd)}; return formatDashboardMicros;`
  )((currency, value) => `${currency}${value}`);

  assert.equal(formatDashboardMicros('¥', -2_500_000), '¥-2.5');
});

test('renders every payroll composition type in all four Dashboard languages', async () => {
  const response = await worker.fetch(
    new Request('https://staffbot.test/admin'),
    { ENVIRONMENT: 'staging' },
    context()
  );
  const script = inlineAdminScript(await response.text());
  const i18nStart = script.indexOf('const I18N = {');
  const i18nEnd = script.indexOf('\n\n    function L(', i18nStart);
  const compositionStart = script.indexOf('function dashboardCompositionTable(');
  const compositionEnd = script.indexOf('\n    function dashboardEmployeeTable', compositionStart);
  const composition = [
    'income',
    'fine',
    'advance',
    'bonus',
    'adjustment',
    'negative_carry',
    'reversal'
  ].map((type) => ({ type, amount_micros: 1_000_000 }));
  const expected = {
    zh: ['收入', '罚款', '预支薪资', '奖金', '调整', '负数结转', '冲正'],
    en: ['Income', 'Fine', 'Salary advances', 'Bonus', 'Adjustment', 'Negative carry', 'Reversal'],
    vi: ['Thu nhập', 'Phạt', 'Ứng lương', 'Thưởng', 'Điều chỉnh', 'Kết chuyển âm', 'Đảo bút toán'],
    ru: ['Доход', 'Штраф', 'Авансы зарплаты', 'Бонус', 'Корректировка', 'Перенос отрицательного остатка', 'Сторно']
  };

  for (const [language, labels] of Object.entries(expected)) {
    const renderComposition = new Function(
      'uiLang',
      `${script.slice(i18nStart, i18nEnd)}
      function L(key) { return (I18N[uiLang] && I18N[uiLang][key]) || I18N.zh[key] || key; }
      function esc(value) { return String(value); }
      function formatDashboardMicros(currency, micros) { return currency + micros; }
      ${script.slice(compositionStart, compositionEnd)}
      return dashboardCompositionTable;`
    )(language);
    const table = renderComposition({ currency: '¥', composition });

    for (const label of labels) assert.match(table, new RegExp(label));
    assert.doesNotMatch(table, /bonus|adjustment|negative_carry/);
  }
});

test('generated Dashboard client renders labelled signed SVG without truncating its data table', async () => {
  const response = await worker.fetch(
    new Request('https://staffbot.test/admin'),
    { ENVIRONMENT: 'staging' },
    context()
  );
  const script = inlineAdminScript(await response.text());
  const helperStart = script.indexOf('function dashboardChartRange(');
  const helperEnd = script.indexOf('\n    function formatDashboardMicros(', helperStart);

  assert.notEqual(helperStart, -1, 'Dashboard SVG helpers should be generated');
  assert.notEqual(helperEnd, -1, 'Dashboard SVG helper boundary should exist');

  const chartFilters = {
    employeeSort: 'net_payroll_micros',
    employeeDir: 'desc'
  };
  const renderCurrencySection = new Function(
    'dashboardFilters',
    'L',
    'esc',
    'formatDashboardMicros',
    'formatAdminMoneyForUi',
    'sectionTitle',
    `${script.slice(helperStart, helperEnd)}
    return dashboardCurrencySection;`
  )(
    chartFilters,
    (key) => key,
    (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[character]),
    (currency, micros) => `${currency}${Number(micros) / 1_000_000}`,
    String,
    (key) => `<div class="section-title"><h2>${key}</h2></div>`
  );
  const employees = Array.from({ length: 25 }, (_, index) => ({
    telegram_id: `EMP-${index}`,
    display_name: index === 24 ? '<Employee 24>' : `Employee ${index}`,
    gross_income_micros: index * 1_000_000,
    commission_micros: index * 500_000,
    fine_micros: -index * 10_000,
    advance_micros: 0,
    net_payroll_micros: (25 - index) * 1_000_000,
    paid_salary_micros: index * 250_000
  }));
  const output = renderCurrencySection({
    currency: '¥<unsafe>',
    summary: {},
    months: [
      {
        month_key: '2026-06<script>',
        gross_income_micros: 10_000_000,
        commission_micros: 4_000_000,
        fine_micros: -1_000_000,
        advance_micros: 0,
        net_payroll_micros: 3_000_000,
        paid_salary_micros: 2_000_000
      },
      {
        month_key: '2026-07',
        gross_income_micros: 12_000_000,
        commission_micros: 5_000_000,
        fine_micros: -2_000_000,
        advance_micros: 0,
        net_payroll_micros: 4_000_000,
        paid_salary_micros: 3_000_000
      }
    ],
    composition: [
      { type: 'income', amount_micros: 5_000_000 },
      { type: 'fine', amount_micros: -2_000_000 },
      { type: 'advance', amount_micros: -1_000_000 },
      { type: 'bonus', amount_micros: 500_000 },
      { type: 'adjustment', amount_micros: 0 },
      { type: 'negative_carry', amount_micros: -250_000 },
      { type: 'reversal', amount_micros: 250_000 }
    ],
    employees
  });

  assert.equal((output.match(/data-dashboard-series=/g) || []).length, 3);
  assert.equal((output.match(/data-dashboard-composition-bar=/g) || []).length, 7);
  assert.equal((output.match(/data-dashboard-employee-bar=/g) || []).length, 20);
  assert.match(output, /class="dashboard-negative"/);
  assert.match(output, /<title[^>]*>monthly_trend ¥&lt;unsafe&gt;<\/title>/);
  assert.match(output, /<desc[^>]*>/);
  assert.match(output, /&lt;Employee 24&gt;/);
  assert.doesNotMatch(output, /<Employee 24>|<script>/);

  chartFilters.employeeSort = 'display_name';
  const nameSortedOutput = renderCurrencySection({
    currency: '¥',
    summary: {
      gross_income_micros: 0,
      commission_micros: 0,
      employee_count: 0,
      net_payroll_micros: 0,
      fine_micros: 0,
      advance_micros: 0,
      paid_salary_micros: 0
    },
    months: [],
    composition: [],
    employees
  });
  assert.doesNotMatch(nameSortedOutput, /NaN/);
  assert.match(nameSortedOutput, /net_payroll_micros/);
});

test('generated Dashboard client hides all charts when active employees have only an all-zero month', async () => {
  const response = await worker.fetch(
    new Request('https://staffbot.test/admin'),
    { ENVIRONMENT: 'staging' },
    context()
  );
  const script = inlineAdminScript(await response.text());
  const helperStart = script.indexOf('function dashboardChartRange(');
  const helperEnd = script.indexOf('\n    function formatDashboardMicros(', helperStart);

  assert.notEqual(helperStart, -1, 'Dashboard SVG helpers should be generated');
  assert.notEqual(helperEnd, -1, 'Dashboard SVG helper boundary should exist');

  const charts = new Function(
    'dashboardFilters',
    'L',
    'esc',
    'formatDashboardMicros',
    `${script.slice(helperStart, helperEnd)}
    return {
      line: dashboardLineChart,
      composition: dashboardCompositionChart,
      employees: dashboardEmployeeChart
    };`
  )(
    {
      employeeSort: 'net_payroll_micros',
      employeeDir: 'desc'
    },
    (key) => key === 'dashboard_no_data' ? '该筛选范围没有数据' : key,
    String,
    (currency, micros) => `${currency}${Number(micros) / 1_000_000}`
  );
  const group = {
    currency: '¥',
    months: [{
      month_key: '2027-01',
      gross_income_micros: 0,
      commission_micros: 0,
      fine_micros: 0,
      advance_micros: 0,
      bonus_micros: 0,
      adjustment_micros: 0,
      negative_carry_micros: 0,
      reversal_micros: 0,
      net_payroll_micros: 0,
      paid_salary_micros: 0
    }],
    composition: [
      'income',
      'fine',
      'advance',
      'bonus',
      'adjustment',
      'negative_carry',
      'reversal'
    ].map((type) => ({ type, amount_micros: 0 })),
    employees: [{
      telegram_id: 'ACTIVE-EMPLOYEE',
      display_name: 'Active Employee',
      gross_income_micros: 0,
      commission_micros: 0,
      fine_micros: 0,
      advance_micros: 0,
      net_payroll_micros: 0,
      paid_salary_micros: 0
    }]
  };

  for (const chart of Object.values(charts)) {
    const output = chart(group);
    assert.equal(output, '<p class="muted">该筛选范围没有数据</p>');
    assert.doesNotMatch(output, /<svg\b/);
  }
});

test('generated Dashboard ledger interaction keeps comparison filters independent and paginates safely', async () => {
  const response = await worker.fetch(
    new Request('https://staffbot.test/admin'),
    { ENVIRONMENT: 'staging' },
    context()
  );
  const script = inlineAdminScript(await response.text());
  const queryStart = script.indexOf('function dashboardQuery(');
  const queryEnd = script.indexOf('\n    async function renderDashboard(', queryStart);
  const entriesStart = script.indexOf('async function renderDashboardEntries(');
  const entriesEnd = script.indexOf('\n    function bindDashboardControls(', entriesStart);

  assert.notEqual(entriesStart, -1, 'Dashboard ledger renderer should be generated');
  assert.notEqual(entriesEnd, -1, 'Dashboard ledger renderer boundary should exist');

  const dashboardFilters = {
    dateFrom: '2026-07-01',
    dateTo: '2026-07-31',
    employee: 'MAIN-FILTER',
    stores: ['TOKYO'],
    employeeSort: 'net_payroll_micros',
    employeeDir: 'desc',
    selectedEmployee: 'DETAIL-EMP',
    entriesPage: 1
  };
  const requested = [];
  const root = {
    innerHTML: '',
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const payload = {
    entries: [{
      entry_id: 'ENTRY-<1>',
      store_id: 'TOKYO',
      telegram_id: 'DETAIL-EMP',
      display_name: '<Alice>',
      type: 'reversal',
      amount_micros: -2_500_000,
      currency: '¥',
      effective_at: '2026-07-20T00:00:00.000Z',
      source: 'manual',
      source_id: 'SOURCE-1',
      created_at: '2026-07-20T01:00:00.000Z',
      reverses_entry_id: 'ENTRY-0',
      metadata_json: '<must-not-render>'
    }],
    pagination: {
      entries: {
        page: 1,
        total_pages: 2,
        total: 101,
        has_prev: false,
        has_next: true
      }
    }
  };
  const renderDashboardEntries = new Function(
    '$',
    'api',
    'storeId',
    'dashboardFilters',
    'L',
    'esc',
    'formatDashboardMicros',
    'dashboardLedgerType',
    'renderDashboard',
    'withBusy',
    `${script.slice(queryStart, queryEnd)}
    ${script.slice(entriesStart, entriesEnd)}
    return renderDashboardEntries;`
  )(
    () => root,
    async (path) => {
      requested.push(path);
      return payload;
    },
    () => 'TOKYO',
    dashboardFilters,
    (key) => ({
      ledger_entries: 'Ledger entries',
      refresh: 'Refresh',
      back_to_dashboard: 'Back to Dashboard',
      reversal: 'Reversal',
      page_status: 'Page {page} / {total_pages}, total {total}',
      prev_page: 'Previous',
      next_page: 'Next',
      dashboard_no_data: 'No data'
    })[key] || key,
    (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[character]),
    (currency, micros) => `${currency}${Number(micros) / 1_000_000}`,
    (type) => type,
    async () => {},
    async (_button, task) => task()
  );

  await renderDashboardEntries('DETAIL-EMP');

  assert.match(requested[0], /\/dashboard\/entries\?/);
  assert.deepEqual(
    Object.fromEntries(new URL(requested[0], 'https://staffbot.test').searchParams),
    {
      stores: 'TOKYO',
      date_from: '2026-07-01',
      date_to: '2026-07-31',
      employee: 'DETAIL-EMP',
      employees_sort: 'net_payroll_micros',
      employees_dir: 'desc',
      entries_page: '1'
    }
  );
  assert.equal(dashboardFilters.employee, 'MAIN-FILTER');
  assert.match(root.innerHTML, /class="badge dashboard-reversal">Reversal<\/span>/);
  assert.match(root.innerHTML, /¥-2\.5/);
  assert.match(root.innerHTML, /ENTRY-&lt;1&gt;/);
  assert.match(root.innerHTML, /&lt;Alice&gt;/);
  assert.match(root.innerHTML, /data-dashboard-entry-page="prev" disabled/);
  assert.match(root.innerHTML, /data-dashboard-entry-page="next"/);
  assert.doesNotMatch(root.innerHTML, /must-not-render|metadata_json|<Alice>/);
});

test('generated Dashboard detail controls update independent state and return to the overview', async () => {
  const response = await worker.fetch(
    new Request('https://staffbot.test/admin'),
    { ENVIRONMENT: 'staging' },
    context()
  );
  const script = inlineAdminScript(await response.text());
  const controlsStart = script.indexOf('function bindDashboardEntryControls(');
  const controlsEnd = script.indexOf('\n    function bindDashboardControls(', controlsStart);

  assert.notEqual(controlsStart, -1, 'Dashboard ledger controls should be generated');
  assert.notEqual(controlsEnd, -1, 'Dashboard ledger controls boundary should exist');

  const dashboardFilters = {
    employee: 'MAIN-FILTER',
    selectedEmployee: 'DETAIL-EMP',
    entriesPage: 1
  };
  const renderedPages = [];
  let overviewRenders = 0;
  const previous = { dataset: { dashboardEntryPage: 'prev' }, onclick: null };
  const next = { dataset: { dashboardEntryPage: 'next' }, onclick: null };
  const back = { onclick: null };
  const root = {
    querySelector(selector) {
      return selector === '[data-dashboard-back]' ? back : null;
    },
    querySelectorAll(selector) {
      return selector === '[data-dashboard-entry-page]' ? [previous, next] : [];
    }
  };
  const bindDashboardEntryControls = new Function(
    'dashboardFilters',
    'renderDashboardEntries',
    'renderDashboard',
    'withBusy',
    `${script.slice(controlsStart, controlsEnd)}
    return bindDashboardEntryControls;`
  )(
    dashboardFilters,
    async (employeeId) => {
      renderedPages.push([employeeId, dashboardFilters.entriesPage]);
    },
    async () => {
      overviewRenders += 1;
    },
    async (_button, task) => task()
  );

  bindDashboardEntryControls(root);
  await next.onclick();
  assert.deepEqual(renderedPages, [['DETAIL-EMP', 2]]);
  assert.equal(dashboardFilters.employee, 'MAIN-FILTER');

  await previous.onclick();
  assert.deepEqual(renderedPages.at(-1), ['DETAIL-EMP', 1]);

  await back.onclick();
  assert.equal(dashboardFilters.selectedEmployee, '');
  assert.equal(dashboardFilters.entriesPage, 1);
  assert.equal(dashboardFilters.employee, 'MAIN-FILTER');
  assert.equal(overviewRenders, 1);
});

test('Dashboard source keeps signed ledger values safe and retains full employee data', async () => {
  const response = await worker.fetch(
    new Request('https://staffbot.test/admin'),
    { ENVIRONMENT: 'staging' },
    context()
  );
  const script = inlineAdminScript(await response.text());
  const dashboardStart = script.indexOf('function dashboardQuery(');
  const dashboardEnd = script.indexOf('\n    function renderStores(', dashboardStart);
  const dashboardSource = script.slice(dashboardStart, dashboardEnd);
  const microsDivisions = [...dashboardSource.matchAll(/\/\s*1_000_000/g)];

  assert.equal(microsDivisions.length, 1);
  assert.match(dashboardSource, /function formatDashboardMicros[\s\S]*\/\s*1_000_000/);
  assert.doesNotMatch(dashboardSource, /metadata_json/);
  assert.match(dashboardSource, /entry\.type === 'reversal'/);
  assert.match(dashboardSource, /data-dashboard-entry-page/);
  assert.match(dashboardSource, /employees\.slice\(0,\s*20\)/);
  assert.match(dashboardSource, /employees\.map\(\(employee\) => '<tr>'/);
});

test('handles authenticated, unknown, and unauthorized admin API requests directly', async () => {
  const database = new DatabaseSync(':memory:');
  database.exec(schema);
  database.exec(`
    INSERT INTO admin_sessions (
      token, telegram_id, expires_at, created_at
    ) VALUES (
      'direct-handler-session',
      'ADMIN1',
      '2099-01-01T00:00:00.000Z',
      '2026-07-28T00:00:00.000Z'
    )
  `);
  const env = {
    DB: createD1(database),
    ADMIN_IDS: 'ADMIN1'
  };
  const authenticatedHeaders = {
    cookie: 'staffbot_admin_session=direct-handler-session'
  };

  const me = await handleAdminApi(
    new Request('https://staffbot.test/api/admin/me', {
      headers: authenticatedHeaders
    }),
    env,
    new URL('https://staffbot.test/api/admin/me'),
    context()
  );
  const unknown = await handleAdminApi(
    new Request('https://staffbot.test/api/admin/unknown', {
      headers: authenticatedHeaders
    }),
    env,
    new URL('https://staffbot.test/api/admin/unknown'),
    context()
  );
  const unauthorized = await handleAdminApi(
    new Request('https://staffbot.test/api/admin/me'),
    env,
    new URL('https://staffbot.test/api/admin/me'),
    context()
  );

  assert.equal(me.status, 200);
  assert.deepEqual(await me.json(), {
    ok: true,
    telegram_id: 'ADMIN1',
    global_admin: true
  });
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), {
    ok: false,
    error: 'not_found'
  });
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), {
    ok: false,
    error: 'unauthorized'
  });
});

test('routes health and admin pages with visible staging identity', async () => {
  const ctx = context();
  const env = { ENVIRONMENT: 'staging' };

  const health = await worker.fetch(
    new Request('https://staffbot.test/'),
    env,
    ctx
  );
  const admin = await worker.fetch(
    new Request('https://staffbot.test/admin'),
    env,
    ctx
  );

  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true,
    service: 'staffbot-v2',
    environment: 'staging',
    admin: '/admin'
  });
  assert.equal(admin.status, 200);
  assert.match(await admin.text(), /STAGING 测试环境/);
});

test('rejects incorrect webhook paths and header secrets', async () => {
  const env = {
    BOT_TOKEN: 'test-token',
    WEBHOOK_SECRET: 'correct-secret'
  };
  const ctx = context();

  const wrongPath = await worker.fetch(new Request(
    'https://staffbot.test/webhook/wrong-secret',
    { method: 'POST' }
  ), env, ctx);
  const wrongHeader = await worker.fetch(new Request(
    'https://staffbot.test/webhook/correct-secret',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'wrong-secret'
      },
      body: JSON.stringify({ update_id: 1 })
    }
  ), env, ctx);

  assert.equal(wrongPath.status, 404);
  assert.deepEqual(await wrongPath.json(), {
    ok: false,
    error: 'not_found'
  });
  assert.equal(wrongHeader.status, 403);
  assert.deepEqual(await wrongHeader.json(), {
    ok: false,
    error: 'forbidden'
  });
});

test('accepts a correctly authenticated webhook update', async () => {
  const database = new DatabaseSync(':memory:');
  database.exec(schema);
  const env = {
    DB: createD1(database),
    BOT_TOKEN: 'test-token',
    WEBHOOK_SECRET: 'correct-secret',
    ENVIRONMENT: 'staging'
  };
  const ctx = context();

  const response = await worker.fetch(new Request(
    'https://staffbot.test/webhook/correct-secret',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'correct-secret'
      },
      body: JSON.stringify({ update_id: 7 })
    }
  ), env, ctx);
  await Promise.all(ctx.promises);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(
    { ...database.prepare(`
      SELECT level, event, payload_json FROM bot_logs
    `).get() },
    {
      level: 'debug',
      event: 'telegram_update',
      payload_json: JSON.stringify({ update_id: 7 })
    }
  );
});

test('does not queue scheduled work when staging automation is disabled', async () => {
  const ctx = context();

  await worker.scheduled(
    { scheduledTime: Date.parse('2026-07-28T03:10:00.000Z') },
    { SCHEDULED_TASKS_ENABLED: 'false' },
    ctx
  );

  assert.equal(ctx.promises.length, 0);
});

test('runs scheduled work in accounting and delivery order when enabled', async () => {
  const database = new DatabaseSync(':memory:');
  database.exec(schema);
  database.exec(`
    INSERT INTO stores (
      store_id, name, status, timezone, currency, created_at, updated_at
    ) VALUES (
      'PAY-STORE', 'Payroll Store', 'active', 'Asia/Tokyo', '¥',
      '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
    );
    INSERT INTO store_members (
      store_id, telegram_id, display_name, role, status,
      commission_rate, cycle_start, joined_at,
      absence_check_enabled, absence_check_enabled_at,
      payroll_start_date, payroll_automation_started_at, updated_at
    ) VALUES (
      'PAY-STORE', 'EMP-1', 'Alice', 'employee', 'active',
      0.6, '2026-06-30T15:00:00.000Z',
      '2026-06-30T15:00:00.000Z',
      1, '2026-06-30T15:00:00.000Z',
      '2026-07-01', '2026-06-30T15:00:00.000Z',
      '2026-07-01T00:00:00.000Z'
    );
    INSERT INTO payroll_entries (
      entry_id, store_id, telegram_id, type, amount_micros, currency,
      effective_at, source, source_id, created_by, created_at,
      reverses_entry_id, metadata_json
    ) VALUES (
      'PAYDAY-INCOME', 'PAY-STORE', 'EMP-1', 'income',
      10000000, '¥', '2026-07-15T03:00:00.000Z',
      'test', 'PAYDAY-INCOME', 'ADMIN-1',
      '2026-07-15T03:00:00.000Z', NULL, '{}'
    );
  `);
  const reads = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    async json() {
      return { ok: true };
    }
  });
  try {
    const env = {
      DB: createD1(database, {
        beforeAll(sql) {
          reads.push(sql);
        }
      }),
      ENVIRONMENT: 'production',
      BOT_TOKEN: 'test-token',
      ADMIN_IDS: ''
    };
    const result = await processScheduledWork(
      env,
      new Date('2026-07-16T04:00:00.000Z')
    );
    const absenceRead = reads.findIndex((sql) =>
      /absence_fine_enabled_at/.test(sql)
    );
    const settlementRead = reads.findIndex((sql) =>
      /LEFT JOIN payroll_payment_profiles/.test(sql)
    );
    const notificationRead = reads.findIndex((sql) =>
      /FROM payroll_disbursements d/.test(sql)
    );
    const cleanupRead = reads.findIndex((sql) =>
      /FROM payroll_payment_proofs p/.test(sql)
    );
    const emailRead = reads.findIndex((sql) =>
      /FROM payroll_email_outbox/.test(sql)
    );

    assert.deepEqual(Object.keys(result), [
      'absence',
      'payroll',
      'cleanup',
      'notifications',
      'email'
    ]);
    assert.ok(absenceRead >= 0);
    assert.ok(settlementRead > absenceRead);
    assert.ok(cleanupRead > settlementRead);
    assert.ok(notificationRead > cleanupRead);
    assert.ok(notificationRead > settlementRead);
    assert.ok(emailRead > notificationRead);
    assert.equal(result.payroll.created, 1);
    assert.deepEqual(result.cleanup, { deleted: 0, failed: 0 });
    assert.equal(result.notifications.sent, 1);
    assert.deepEqual(result.email, {
      scanned: 0,
      sent: 0,
      failed: 0
    });
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});
