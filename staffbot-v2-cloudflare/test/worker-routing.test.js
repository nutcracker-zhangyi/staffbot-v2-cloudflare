import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

import { handleAdminApi } from '../src/admin-api.js';
import worker from '../src/index.js';
import { createD1 } from './helpers/d1.js';

const schema = readFileSync(
  new URL('../db/schema.sql', import.meta.url),
  'utf8'
);
const indexSource = await readFile(
  new URL('../src/index.js', import.meta.url),
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

test('keeps the Worker entrypoint as a compatibility facade', () => {
  assert.equal(indexSource.includes('async function handleAdminApi'), false);
  assert.equal(indexSource.includes('function adminHtml'), false);
  assert.equal(indexSource.includes('const TEXT ='), false);
  assert.ok(indexSource.split('\n').length < 120);
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
