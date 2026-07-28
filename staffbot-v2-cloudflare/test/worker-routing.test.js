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
