import test from 'node:test';
import assert from 'node:assert/strict';

import { MANAGE_CLIENT } from '../src/manage-client.js';
import { executeManageClient } from './helpers/manage-dom.js';

const task = {
  task_type: 'income',
  task_id: 'INC-1',
  store_id: 'STORE-1',
  store_name: 'Tokyo Club',
  employee_name: 'Alice',
  amount_micros: 60000000,
  currency: '₫',
  business_date: '2026-07-29',
  submitted_at: '2026-07-29T01:00:00.000Z',
  status: 'pending',
  urgency: 100,
  claim: null
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function fixture({
  initialTask = task,
  pathname = '/manage',
  now,
  decisionGate = null,
  claimGate = null,
  refreshFailsAfterDecision = false,
  decisionConflictRefreshFails = false,
  claimConflictRefreshFails = false,
  deferRenew = false,
  detailOverrides = {}
} = {}) {
  const requests = [];
  let currentTask = structuredClone(initialTask);
  let decisionMade = false;
  let authorityRefreshFails = false;
  const renewResolvers = [];
  const detail = () => ({
    task: structuredClone(currentTask),
    request: {
      request_id: currentTask.task_id,
      income: 100,
      commission_income: 60,
      status: currentTask.status
    },
    employee: { telegram_id: 'EMP-1', display_name: 'Alice', language: 'zh' },
    store: { store_id: 'STORE-1', name: 'Tokyo Club', currency: '₫', timezone: 'Asia/Tokyo' },
    attachments: [],
    history: currentTask.status === 'pending' ? [] : [{
      id: 1,
      admin_id: 'ADMIN-1',
      action: currentTask.status === 'approved' ? 'approve_income' : 'reject_income',
      details: currentTask.status === 'rejected' ? { reason: '金额不清楚' } : {},
      created_at: '2026-07-29T02:10:00.000Z'
    }],
    ...structuredClone(detailOverrides)
  });

  return {
    requests,
    renewResolvers,
    setTask(value) { currentTask = structuredClone(value); },
    async browser() {
      return executeManageClient(MANAGE_CLIENT, {
        pathname,
        now,
        async fetch(path, options = {}) {
          const method = options.method || 'GET';
          requests.push({
            method,
            path,
            csrf: options.headers && options.headers['x-csrf-token'],
            body: options.body ? JSON.parse(options.body) : null
          });
          if (path === '/api/admin/me') return json({ ok: true, telegram_id: 'ADMIN-1' });
          if (path === '/api/manage/session') {
            return json({ ok: true, telegram_id: 'ADMIN-1', global_admin: false, csrf_token: 'CSRF-1' });
          }
          if (path === '/api/manage/stores') {
            return json({ stores: [{ store_id: 'STORE-1', name: 'Tokyo Club', currency: '₫', timezone: 'Asia/Tokyo' }] });
          }
          if (path.startsWith('/api/manage/tasks?')) return json({ tasks: [structuredClone(currentTask)] });
          if (path === '/api/manage/stores/STORE-1/approvals/income/INC-1') {
            if ((refreshFailsAfterDecision && decisionMade) || authorityRefreshFails) {
              return json({ ok: false, error: 'refresh_failed' }, 503);
            }
            return json(detail());
          }
          if (path === '/api/manage/tasks/income/INC-1/claim') {
            if (claimGate) await claimGate.promise;
            if (claimConflictRefreshFails) {
              authorityRefreshFails = true;
              return json({ ok: false, error: 'task_claimed' }, 409);
            }
            if (currentTask.claim && currentTask.claim.active && currentTask.claim.claimed_by !== 'ADMIN-1') {
              return json({ ok: false, error: 'task_claimed' }, 409);
            }
            currentTask.claim = {
              claimed_by: 'ADMIN-1',
              claimed_at: '2026-07-29T02:00:00.000Z',
              lease_expires_at: '2099-07-29T02:15:00.000Z'
            };
            return json({ ok: true, claim: structuredClone(currentTask.claim) });
          }
          if (path === '/api/manage/tasks/income/INC-1/renew') {
            if (deferRenew) {
              return new Promise((resolve) => renewResolvers.push(resolve));
            }
            currentTask.claim = {
              ...currentTask.claim,
              lease_expires_at: '2099-07-29T02:15:00.000Z'
            };
            return json({ ok: true, claim: structuredClone(currentTask.claim) });
          }
          if (path === '/api/manage/tasks/income/INC-1/release') {
            currentTask.claim = null;
            return json({ ok: true, claim: null });
          }
          if (path.endsWith('/approve')) {
            if (decisionGate) await decisionGate.promise;
            if (decisionConflictRefreshFails) {
              authorityRefreshFails = true;
              return json({ ok: false, error: 'already_decided' }, 409);
            }
            currentTask.status = 'approved';
            currentTask.claim = null;
            decisionMade = true;
            return json({ ok: true, notification: { status: 'sent' } });
          }
          if (path.endsWith('/reject')) {
            if (decisionGate) await decisionGate.promise;
            currentTask.status = 'rejected';
            currentTask.claim = null;
            decisionMade = true;
            return json({ ok: true, notification: { status: 'sent' } });
          }
          return json({ ok: false, error: 'not_found' }, 404);
        }
      });
    }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('manage client renders task-first navigation and claims a task', async () => {
  const app = fixture();
  const browser = await app.browser();

  assert.deepEqual(browser.navigationLabels(), ['待办', '审批', '工资', '更多']);
  assert.match(browser.document.app.textContent, /Alice/);
  assert.match(browser.document.app.textContent, /Tokyo Club/);
  assert.match(browser.document.app.textContent, /60/);

  await browser.clickButton('查看详情');
  await browser.clickButton('领取');
  assert.deepEqual(app.requests.at(-1), {
    method: 'POST',
    path: '/api/manage/tasks/income/INC-1/claim',
    csrf: 'CSRF-1',
    body: null
  });
  assert.equal(browser.document.getElementById('approval-actions').getAttribute('aria-disabled'), 'false');
});

test('owned detail renews every five minutes and can be released', async () => {
  const app = fixture();
  const browser = await app.browser();
  await browser.clickButton('查看详情');
  await browser.clickButton('领取');

  await browser.advanceTimers(5 * 60 * 1000);
  assert.equal(app.requests.at(-1).path, '/api/manage/tasks/income/INC-1/renew');

  await browser.clickButton('释放');
  assert.equal(app.requests.at(-1).path, '/api/manage/tasks/income/INC-1/release');
  assert.equal(browser.document.getElementById('approve').disabled, true);
});

test('approval uses one confirmation step and rejection requires a reason', async () => {
  const app = fixture({
    initialTask: {
      ...task,
      claim: {
        claimed_by: 'ADMIN-1',
        claimed_at: '2026-07-29T02:00:00.000Z',
        lease_expires_at: '2099-07-29T02:15:00.000Z',
        active: true
      }
    }
  });
  const browser = await app.browser();
  await browser.clickButton('查看详情');

  await browser.clickButton('批准');
  assert.ok(browser.document.getElementById('approve-confirm'));
  assert.equal(app.requests.some((request) => request.path.endsWith('/approve')), false);
  await browser.clickButton('确认批准');
  assert.ok(app.requests.some((request) => (
    request.path === '/api/manage/stores/STORE-1/approvals/income/INC-1/approve'
  )));
  assert.equal(browser.document.getElementById('decision-status').textContent, '已通过');

  app.setTask({
    ...task,
    claim: {
      claimed_by: 'ADMIN-1',
      claimed_at: '2026-07-29T02:00:00.000Z',
      lease_expires_at: '2099-07-29T02:15:00.000Z',
      active: true
    }
  });
  await browser.call('openTask', 'income', 'INC-1');
  await browser.clickButton('拒绝');
  assert.ok(browser.document.getElementById('reject-reason'));
  await browser.clickButton('确认拒绝');
  assert.equal(browser.document.getElementById('decision-error').textContent, '请填写拒绝原因');
  browser.document.getElementById('reject-reason').value = '金额不清楚';
  await browser.clickButton('确认拒绝');
  assert.deepEqual(
    app.requests.find((request) => request.path.endsWith('/reject')).body,
    { reason: '金额不清楚' }
  );
});

test('offline, another owner, and an expired claim keep decision controls read-only', async () => {
  for (const claim of [
    null,
    { claimed_by: 'ADMIN-2', lease_expires_at: '2099-07-29T02:15:00.000Z', active: true },
    { claimed_by: 'ADMIN-1', lease_expires_at: '2020-07-29T02:15:00.000Z', active: true }
  ]) {
    const app = fixture({ initialTask: { ...task, claim } });
    const browser = await app.browser();
    await browser.clickButton('查看详情');
    assert.equal(browser.document.getElementById('approve').disabled, true);
  }

  const app = fixture({
    initialTask: {
      ...task,
      claim: { claimed_by: 'ADMIN-1', lease_expires_at: '2099-07-29T02:15:00.000Z', active: true }
    }
  });
  const browser = await app.browser();
  await browser.clickButton('查看详情');
  await browser.setOnline(false);
  assert.equal(browser.document.getElementById('offline-banner').getAttribute('hidden'), null);
  assert.equal(browser.document.getElementById('approve').disabled, true);
});

test('a conflict refreshes detail and shows the current handler or result', async () => {
  const app = fixture();
  const browser = await app.browser();
  await browser.clickButton('查看详情');

  app.setTask({
    ...task,
    claim: {
      claimed_by: 'ADMIN-2',
      claimed_at: '2026-07-29T02:00:00.000Z',
      lease_expires_at: '2099-07-29T02:15:00.000Z',
      active: true
    }
  });
  const originalFetch = app.requests;
  await browser.clickButton('领取');
  assert.ok(originalFetch.some((request) => request.path === '/api/manage/stores/STORE-1/approvals/income/INC-1'));
  assert.match(browser.document.getElementById('claim-status').textContent, /ADMIN-2/);
});

test('only a manage return path opens an approval detail after login', async () => {
  const safe = fixture({ pathname: '/manage/approvals/income/INC-1' });
  await safe.browser();
  assert.equal(safe.requests.at(-1).path, '/api/manage/stores/STORE-1/approvals/income/INC-1');

  const unsafe = fixture({ pathname: '/admin/approvals/income/INC-1' });
  await unsafe.browser();
  assert.equal(
    unsafe.requests.some((request) => request.path.includes('/approvals/income/INC-1')),
    false
  );
});

test('logout clears all tenant data and network events cannot revive it before another login', async () => {
  let admin = 'ADMIN-A';
  let failTasks = false;
  const browser = await executeManageClient(MANAGE_CLIENT, {
    async fetch(path) {
      if (path === '/api/admin/me') return json({ ok: true, telegram_id: admin });
      if (path === '/api/manage/session') {
        return json({ ok: true, telegram_id: admin, csrf_token: admin + '-CSRF' });
      }
      if (path === '/api/manage/stores') {
        return json({ stores: [{ store_id: admin + '-STORE', name: admin + ' 店铺' }] });
      }
      if (path === '/api/manage/tasks?') {
        if (failTasks) return json({ ok: false, error: 'network_failed' }, 503);
        return json({ tasks: [{ ...task, store_id: 'ADMIN-A-STORE', employee_name: 'Alice-A' }] });
      }
      if (path === '/api/admin/logout') return json({ ok: true });
      if (path === '/api/admin/login/start') return json({ ok: true });
      if (path === '/api/admin/login/verify') {
        admin = 'ADMIN-B';
        failTasks = true;
        return json({ ok: true });
      }
      return json({ ok: false, error: 'not_found' }, 404);
    }
  });
  assert.match(browser.document.app.textContent, /Alice-A/);

  await browser.clickButton('更多');
  await browser.clickButton('退出登录');
  assert.doesNotMatch(browser.document.app.textContent, /Alice-A|ADMIN-A 店铺/);
  await browser.setOnline(false);
  await browser.setOnline(true);
  assert.ok(browser.document.getElementById('telegram-id'));
  assert.doesNotMatch(browser.document.app.textContent, /Alice-A|ADMIN-A 店铺/);

  browser.document.getElementById('telegram-id').value = 'ADMIN-B';
  browser.document.getElementById('login-code').value = '123456';
  await browser.document.getElementById('verify-code').click();
  assert.ok(browser.document.getElementById('telegram-id'));
  assert.doesNotMatch(browser.document.app.textContent, /Alice-A|ADMIN-A 店铺/);
});

test('a committed approval reloads authoritative detail, history, and task list', async () => {
  const app = fixture({
    initialTask: {
      ...task,
      claim: {
        claimed_by: 'ADMIN-1',
        claimed_at: '2026-07-29T02:00:00.000Z',
        lease_expires_at: '2099-07-29T02:15:00.000Z',
        active: true
      }
    }
  });
  const browser = await app.browser();
  await browser.clickButton('查看详情');
  await browser.clickButton('批准');
  await browser.clickButton('确认批准');

  assert.equal(
    app.requests.filter((request) => request.path === '/api/manage/stores/STORE-1/approvals/income/INC-1').length,
    2
  );
  assert.equal(
    app.requests.filter((request) => request.path.startsWith('/api/manage/tasks?')).length,
    2
  );
  assert.match(browser.document.app.textContent, /处理时间线/);
  assert.match(browser.document.app.textContent, /ADMIN-1/);
});

test('a committed decision is never presented as retryable when authoritative refresh fails', async () => {
  const app = fixture({
    refreshFailsAfterDecision: true,
    initialTask: {
      ...task,
      claim: {
        claimed_by: 'ADMIN-1',
        claimed_at: '2026-07-29T02:00:00.000Z',
        lease_expires_at: '2099-07-29T02:15:00.000Z',
        active: true
      }
    }
  });
  const browser = await app.browser();
  await browser.clickButton('查看详情');
  await browser.clickButton('批准');
  await browser.clickButton('确认批准');

  assert.match(browser.document.app.textContent, /审批已保存/);
  assert.doesNotMatch(browser.document.app.textContent, /审批失败/);
  assert.equal(browser.document.getElementById('approve'), null);
});

test('stale detail responses cannot replace a newer task', async () => {
  const firstDetail = deferred();
  const secondDetail = deferred();
  const tasks = [
    { ...task, task_id: 'INC-1', employee_name: 'Alice' },
    { ...task, task_id: 'INC-2', employee_name: 'Bob' }
  ];
  const browser = await executeManageClient(MANAGE_CLIENT, {
    async fetch(path) {
      if (path === '/api/admin/me') return json({ ok: true });
      if (path === '/api/manage/session') return json({ telegram_id: 'ADMIN-1', csrf_token: 'CSRF-1' });
      if (path === '/api/manage/stores') return json({ stores: [{ store_id: 'STORE-1', name: 'Tokyo Club' }] });
      if (path === '/api/manage/tasks?') return json({ tasks });
      if (path.endsWith('/INC-1')) return firstDetail.promise;
      if (path.endsWith('/INC-2')) return secondDetail.promise;
      return json({ ok: false }, 404);
    }
  });

  const first = browser.call('openTask', 'income', 'INC-1');
  const second = browser.call('openTask', 'income', 'INC-2');
  secondDetail.resolve(json({ task: tasks[1], request: {}, employee: {}, store: {}, attachments: [], history: [] }));
  await second;
  assert.match(browser.document.app.textContent, /Bob/);
  firstDetail.resolve(json({ task: tasks[0], request: {}, employee: {}, store: {}, attachments: [], history: [] }));
  await first;
  assert.match(browser.document.app.textContent, /Bob/);
  assert.doesNotMatch(browser.document.app.textContent, /Alice/);
});

test('a stale claim response cannot reopen a task after navigation', async () => {
  const gate = deferred();
  const app = fixture({ claimGate: gate });
  const browser = await app.browser();
  await browser.clickButton('查看详情');
  const claim = browser.document.getElementById('claim').click();
  await new Promise((resolve) => setImmediate(resolve));
  await browser.clickButton('审批');
  gate.resolve();
  await claim;

  assert.equal(browser.document.getElementById('claim-status'), null);
  assert.match(browser.document.app.textContent, /审批中心/);
});

test('approval busy state blocks a double submit', async () => {
  const gate = deferred();
  const app = fixture({
    decisionGate: gate,
    initialTask: {
      ...task,
      claim: {
        claimed_by: 'ADMIN-1',
        claimed_at: '2026-07-29T02:00:00.000Z',
        lease_expires_at: '2099-07-29T02:15:00.000Z',
        active: true
      }
    }
  });
  const browser = await app.browser();
  await browser.clickButton('查看详情');
  await browser.clickButton('批准');
  const confirm = browser.document.getElementById('approve-confirm');
  const first = confirm.click();
  const second = confirm.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.requests.filter((request) => request.path.endsWith('/approve')).length, 1);
  gate.resolve();
  await Promise.all([first, second]);
});

test('a short lease renews before expiry and an external lease redraws at expiry', async () => {
  const now = '2026-07-29T02:00:00.000Z';
  const owned = fixture({
    now,
    initialTask: {
      ...task,
      claim: {
        claimed_by: 'ADMIN-1',
        claimed_at: now,
        lease_expires_at: '2026-07-29T02:02:00.000Z',
        active: true
      }
    }
  });
  const ownedBrowser = await owned.browser();
  await ownedBrowser.clickButton('查看详情');
  assert.ok(owned.requests.some((request) => request.path.endsWith('/renew')));

  const external = fixture({
    now,
    initialTask: {
      ...task,
      claim: {
        claimed_by: 'ADMIN-2',
        claimed_at: now,
        lease_expires_at: '2026-07-29T02:01:00.000Z',
        active: true
      }
    }
  });
  const externalBrowser = await external.browser();
  await externalBrowser.clickButton('查看详情');
  assert.equal(externalBrowser.document.getElementById('claim').disabled, true);
  await externalBrowser.advanceTimers(60 * 1000 + 1);
  assert.equal(externalBrowser.document.getElementById('claim').disabled, false);
});

test('detail safely renders employee, history, and attachment empty state', async () => {
  const attack = '<img src=x onerror=alert(1)>';
  const app = fixture({
    initialTask: { ...task, employee_name: attack },
    detailOverrides: {
      employee: { telegram_id: 'EMP-1', display_name: attack, language: 'zh' },
      attachments: [],
      history: [{
        id: 1,
        admin_id: attack,
        action: attack,
        details: {},
        created_at: '2026-07-29T02:10:00.000Z'
      }]
    }
  });
  const browser = await app.browser();
  await browser.clickButton('查看详情');

  assert.doesNotMatch(browser.document.app.innerHTML, /<img src=x/);
  assert.match(browser.document.app.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(browser.document.app.textContent, /员工信息/);
  assert.match(browser.document.app.textContent, /暂无附件/);
  assert.match(browser.document.app.textContent, /处理时间线/);
});

test('zero micros is rendered as a real amount', async () => {
  const app = fixture({ initialTask: { ...task, amount_micros: 0 } });
  const browser = await app.browser();
  assert.match(browser.document.app.textContent, /₫0/);
});

for (const conflict of ['decision', 'claim']) {
  test(`${conflict} conflict with failed authority refresh stays locked`, async () => {
    const app = fixture({
      decisionConflictRefreshFails: conflict === 'decision',
      claimConflictRefreshFails: conflict === 'claim',
      initialTask: {
        ...task,
        claim: conflict === 'decision' ? {
          claimed_by: 'ADMIN-1',
          claimed_at: '2026-07-29T02:00:00.000Z',
          lease_expires_at: '2099-07-29T02:15:00.000Z',
          active: true
        } : null
      }
    });
    const browser = await app.browser();
    await browser.clickButton('查看详情');
    if (conflict === 'decision') {
      await browser.clickButton('批准');
      await browser.clickButton('确认批准');
    } else {
      await browser.clickButton('领取');
    }

    assert.match(browser.document.app.textContent, /最新状态加载失败/);
    assert.equal(browser.document.getElementById('approve').disabled, true);
    const claim = browser.document.getElementById('claim');
    if (claim) assert.equal(claim.disabled, true);
  });
}

test('failed short-lease renewal backs off and becomes read-only at expiry', async () => {
  const now = '2026-07-29T02:00:00.000Z';
  const app = fixture({
    now,
    deferRenew: true,
    initialTask: {
      ...task,
      claim: {
        claimed_by: 'ADMIN-1',
        claimed_at: now,
        lease_expires_at: '2026-07-29T02:02:00.000Z',
        active: true
      }
    }
  });
  const browser = await app.browser();
  await browser.clickButton('查看详情');
  assert.equal(app.renewResolvers.length, 1);

  app.renewResolvers[0](json({ ok: false, error: 'renew_failed' }, 503));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.renewResolvers.length, 1);
  await browser.advanceTimers(30 * 1000 - 1);
  assert.equal(app.renewResolvers.length, 1);
  await browser.advanceTimers(1);
  assert.equal(app.renewResolvers.length, 2);

  app.renewResolvers[1](json({ ok: false, error: 'renew_failed' }, 503));
  await new Promise((resolve) => setImmediate(resolve));
  await browser.advanceTimers(60 * 1000);
  assert.equal(app.renewResolvers.length, 3);
  app.renewResolvers[2](json({ ok: false, error: 'renew_failed' }, 503));
  await new Promise((resolve) => setImmediate(resolve));
  await browser.advanceTimers(30 * 1000 + 1);

  assert.equal(app.renewResolvers.length, 3);
  assert.equal(browser.document.getElementById('approve').disabled, true);
});

test('stale store filter results cannot replace the latest query', async () => {
  const storeA = deferred();
  const storeB = deferred();
  const baseTask = { ...task, employee_name: 'Initial' };
  const browser = await executeManageClient(MANAGE_CLIENT, {
    async fetch(path) {
      if (path === '/api/admin/me') return json({ ok: true });
      if (path === '/api/manage/session') return json({ telegram_id: 'ADMIN-1', csrf_token: 'CSRF-1' });
      if (path === '/api/manage/stores') {
        return json({ stores: [
          { store_id: 'STORE-A', name: 'A店' },
          { store_id: 'STORE-B', name: 'B店' }
        ] });
      }
      if (path === '/api/manage/tasks?') return json({ tasks: [baseTask] });
      if (path === '/api/manage/tasks?store_id=STORE-A') return storeA.promise;
      if (path === '/api/manage/tasks?store_id=STORE-B') return storeB.promise;
      return json({ ok: false }, 404);
    }
  });

  const filter = browser.document.getElementById('store-filter');
  filter.value = 'STORE-A';
  const first = filter.onchange();
  filter.value = 'STORE-B';
  const second = filter.onchange();
  storeB.resolve(json({ tasks: [{ ...task, store_id: 'STORE-B', employee_name: 'Bob-B' }] }));
  await second;
  assert.match(browser.document.app.textContent, /Bob-B/);
  storeA.resolve(json({ tasks: [{ ...task, store_id: 'STORE-A', employee_name: 'Alice-A' }] }));
  await first;
  assert.match(browser.document.app.textContent, /Bob-B/);
  assert.doesNotMatch(browser.document.app.textContent, /Alice-A/);
});

const payrollListItem = {
  payroll_id: 'PAYROLL-1',
  store_id: 'STORE-1',
  employee_id: 'EMP-1',
  employee_name: 'Alice',
  period_start: '2026-07-01T03:00:00.000Z',
  cutoff_at: '2026-07-16T03:00:00.000Z',
  amount_snapshot_micros: 100_000_000,
  currency: '$',
  status: 'awaiting_admin_payment',
  current_attempt: { attempt_id: 'ATTEMPT-OLD', version: 1, status: 'submitted' },
  claim: null
};

function payrollDossier({ claim = null, draft = false } = {}) {
  return {
    payroll: {
      ...payrollListItem,
      payment_profile: {
        accepts_bank: true,
        accepts_usdt: true,
        accepts_cash: true,
        bank: '•••5678',
        usdt: '•••EFGH',
        has_usdt_qr: true,
        usdt_qr_url: '/api/manage/stores/STORE-1/payroll/PAYROLL-1/usdt-qr'
      },
      claim
    },
    attempts: [
      ...(draft ? [{
        attempt_id: 'ATTEMPT-DRAFT', version: 2, status: 'draft',
        bank_micros: 0, usdt_micros: 0, cash_micros: 0, proofs: []
      }] : []),
      {
        attempt_id: 'ATTEMPT-OLD', version: 1, status: 'submitted',
        bank_micros: 70_000_000, usdt_micros: 30_000_000, cash_micros: 0,
        submitted_by: 'ADMIN-0', submitted_at: '2026-07-16T04:00:00.000Z',
        proofs: [{
          proof_id: 'PROOF-OLD', method: 'bank', mime_type: 'image/jpeg',
          uploaded_at: '2026-07-16T03:55:00.000Z',
          url: '/api/manage/stores/STORE-1/payroll/proofs/PROOF-OLD'
        }]
      }
    ],
    history: [{
      id: 1, admin_id: 'ADMIN-0', action: 'submit_payroll_payment',
      details: { version: 1 }, created_at: '2026-07-16T04:00:00.000Z'
    }]
  };
}

function payrollFixture({
  uploadFailureAt = 0,
  uploadGate = null,
  splitConflict = false,
  confirm = () => true
} = {}) {
  const requests = [];
  const activeClaim = {
    claimed_by: 'ADMIN-1', claimed_at: '2026-07-29T02:00:00.000Z',
    lease_expires_at: '2099-07-29T02:15:00.000Z', active: true
  };
  let dossier = payrollDossier();
  let uploadCount = 0;
  return {
    requests,
    async browser() {
      return executeManageClient(MANAGE_CLIENT, {
        confirm,
        async fetch(path, options = {}) {
          const method = options.method || 'GET';
          requests.push({ path, method, headers: options.headers, body: options.body });
          if (path === '/api/admin/me') return json({ ok: true });
          if (path === '/api/manage/session') {
            return json({ telegram_id: 'ADMIN-1', csrf_token: 'CSRF-1' });
          }
          if (path === '/api/manage/stores') {
            return json({ stores: [{ store_id: 'STORE-1', name: 'Tokyo Club', currency: '$' }] });
          }
          if (path === '/api/manage/tasks?') return json({ tasks: [] });
          if (path === '/api/manage/stores/STORE-1/payroll') {
            return json({ payroll: [structuredClone(payrollListItem)] });
          }
          if (path === '/api/manage/stores/STORE-1/payroll/PAYROLL-1' && method === 'GET') {
            return json(structuredClone(dossier));
          }
          if (path === '/api/manage/tasks/payroll/PAYROLL-1/claim') {
            dossier.payroll.claim = structuredClone(activeClaim);
            return json({ ok: true, claim: activeClaim });
          }
          if (path.endsWith('/attempts/draft')) {
            dossier = payrollDossier({ claim: activeClaim, draft: true });
            return json({ ok: true, attempt: structuredClone(dossier.attempts[0]) });
          }
          if (path.endsWith('/attempts/ATTEMPT-DRAFT/split')) {
            if (splitConflict) return json({ error: 'task_claim_required' }, 409);
            const split = JSON.parse(options.body);
            Object.assign(dossier.attempts[0], split);
            return json({ ok: true, attempt: structuredClone(dossier.attempts[0]) });
          }
          if (path.endsWith('/attempts/ATTEMPT-DRAFT/proofs') && method === 'POST') {
            uploadCount += 1;
            if (uploadGate) return uploadGate.promise;
            if (uploadCount === uploadFailureAt) return json({ error: 'upload_failed' }, 503);
            const methodName = options.body.get('method');
            const proof = {
              proof_id: `PROOF-${uploadCount}`, attempt_id: 'ATTEMPT-DRAFT',
              method: methodName, file_name: options.body.get('proof').name,
              mime_type: options.body.get('proof').type, size_bytes: options.body.get('proof').size,
              uploaded_by: 'ADMIN-1', uploaded_at: '2026-07-29T02:10:00.000Z',
              url: `/api/manage/stores/STORE-1/payroll/proofs/PROOF-${uploadCount}`
            };
            dossier.attempts[0].proofs.push(proof);
            return json({ ok: true, proof });
          }
          if (path.includes('/proofs/') && method === 'DELETE') {
            const proofId = path.split('/').at(-1);
            dossier.attempts[0].proofs = dossier.attempts[0].proofs.filter((proof) => proof.proof_id !== proofId);
            return json({ ok: true });
          }
          if (path.endsWith('/attempts/ATTEMPT-DRAFT/submit')) {
            return json({ ok: true, attempt: { ...dossier.attempts[0], status: 'submitted' } });
          }
          return json({ ok: false, error: 'not_found' }, 404);
        }
      });
    }
  };
}

test('payroll opens a dossier with facts and immutable attempt history before edit controls', async () => {
  const app = payrollFixture();
  const browser = await app.browser();
  await browser.clickButton('工资');
  await browser.clickButton('查看工资档案');

  assert.match(browser.document.app.textContent, /Alice/);
  assert.match(browser.document.app.textContent, /工资周期/);
  assert.match(browser.document.app.textContent, /版本 1/);
  assert.match(browser.document.app.textContent, /submit_payroll_payment/);
  assert.equal(browser.document.getElementById('bank-amount'), null);
  assert.equal(browser.document.getElementById('delete-proof-PROOF-OLD'), null);
});

test('payroll payment enables submit only for an exact evidenced integer-micros split', async () => {
  const app = payrollFixture();
  const browser = await app.browser();
  await browser.clickButton('工资');
  await browser.clickButton('查看工资档案');
  await browser.clickButton('领取并开始付款');

  await browser.input('bank-amount', '70');
  await browser.input('usdt-amount', '30');
  await browser.input('cash-amount', '0');
  assert.match(browser.document.getElementById('payment-difference').textContent, /\$0/);
  assert.equal(browser.document.getElementById('submit-payroll-payment').disabled, true);

  const claimIndex = app.requests.findIndex((request) => request.path.endsWith('/payroll/PAYROLL-1/claim'));
  const draftIndex = app.requests.findIndex((request) => request.path.endsWith('/attempts/draft'));
  assert.ok(claimIndex >= 0 && draftIndex > claimIndex);

  const jpeg = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], 'bank.jpg', { type: 'image/jpeg' });
  const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'usdt.png', { type: 'image/png' });
  await browser.call('uploadProof', 'bank', [jpeg]);
  await browser.call('uploadProof', 'usdt', [png]);

  assert.equal(browser.document.getElementById('submit-payroll-payment').disabled, false);
  const split = app.requests.find((request) => request.path.endsWith('/split'));
  assert.deepEqual(JSON.parse(split.body), {
    bank_micros: 70_000_000, usdt_micros: 30_000_000, cash_micros: 0
  });
  const uploads = app.requests.filter((request) => request.path.endsWith('/proofs'));
  assert.equal(uploads.length, 2);
  assert.equal(uploads[0].headers['x-csrf-token'], 'CSRF-1');
  assert.equal(uploads[0].headers['content-type'], undefined);
  assert.equal(browser.objectUrls.size, 0);
});

test('payroll rejects negative, excessive-precision, and float-like amount input', async () => {
  const app = payrollFixture();
  const browser = await app.browser();
  await browser.clickButton('工资');
  await browser.clickButton('查看工资档案');
  await browser.clickButton('领取并开始付款');

  for (const invalid of ['-1', '0.0000001', '1e2']) {
    await browser.input('bank-amount', invalid);
    assert.match(browser.document.getElementById('bank-amount-error').textContent, /有效金额/);
    assert.equal(browser.document.getElementById('submit-payroll-payment').disabled, true);
  }
  assert.equal(app.requests.some((request) => request.path.endsWith('/split')), false);
});

test('multi-file upload isolates failures and retries only the failed proof', async () => {
  const app = payrollFixture({ uploadFailureAt: 2 });
  const browser = await app.browser();
  await browser.clickButton('工资');
  await browser.clickButton('查看工资档案');
  await browser.clickButton('领取并开始付款');
  await browser.input('bank-amount', '100');
  await browser.input('usdt-amount', '0');
  await browser.input('cash-amount', '0');
  await browser.call('savePaymentDraft');

  const first = new File([new Uint8Array([1])], 'first.jpg', { type: 'image/jpeg' });
  const second = new File([new Uint8Array([2])], 'second.jpg', { type: 'image/jpeg' });
  await browser.call('uploadProof', 'bank', [first, second]);
  assert.match(browser.document.app.textContent, /second.jpg.*上传失败/s);
  assert.match(browser.document.app.textContent, /first.jpg.*已上传/s);
  await browser.clickButton('重试 second.jpg');
  assert.equal(app.requests.filter((request) => request.path.endsWith('/proofs')).length, 3);
  assert.doesNotMatch(browser.document.app.textContent, /上传失败/);
});

test('payroll mobile upload keeps camera and photo library as separate accessible inputs', async () => {
  const browser = await payrollFixture().browser();
  await browser.clickButton('工资');
  await browser.clickButton('查看工资档案');
  await browser.clickButton('领取并开始付款');

  const camera = browser.document.getElementById('bank-camera');
  const library = browser.document.getElementById('bank-library');
  assert.equal(camera.getAttribute('accept'), 'image/jpeg,image/png,image/webp');
  assert.equal(camera.getAttribute('capture'), 'environment');
  assert.equal(camera.getAttribute('multiple'), null);
  assert.equal(library.getAttribute('accept'), 'image/jpeg,image/png,image/webp');
  assert.equal(library.getAttribute('capture'), null);
  assert.equal(library.getAttribute('multiple'), '');
});

test('a draft proof is deleted only after confirmation and submitted proof stays immutable', async () => {
  let shouldConfirm = false;
  const app = payrollFixture({ confirm: () => shouldConfirm });
  const baseBrowser = await app.browser();
  await baseBrowser.clickButton('工资');
  await baseBrowser.clickButton('查看工资档案');
  await baseBrowser.clickButton('领取并开始付款');
  await baseBrowser.input('bank-amount', '100');
  await baseBrowser.call('savePaymentDraft');
  const proof = new File([new Uint8Array([1])], 'proof.jpg', { type: 'image/jpeg' });
  await baseBrowser.call('uploadProof', 'bank', [proof]);
  assert.ok(baseBrowser.document.getElementById('delete-proof-PROOF-1'));
  assert.equal(baseBrowser.document.getElementById('delete-proof-PROOF-OLD'), null);

  await baseBrowser.clickButton('删除回执');
  assert.equal(app.requests.filter((request) => request.method === 'DELETE').length, 0);
  shouldConfirm = true;
  await baseBrowser.clickButton('删除回执');
  assert.equal(app.requests.filter((request) => request.method === 'DELETE').length, 1);
  assert.equal(baseBrowser.document.getElementById('delete-proof-PROOF-1'), null);
});

test('offline payroll payment becomes read-only without losing the loaded dossier', async () => {
  const app = payrollFixture();
  const browser = await app.browser();
  await browser.clickButton('工资');
  await browser.clickButton('查看工资档案');
  await browser.clickButton('领取并开始付款');
  await browser.input('bank-amount', '100');
  await browser.call('savePaymentDraft');
  await browser.setOnline(false);

  assert.match(browser.document.app.textContent, /Alice/);
  assert.equal(browser.document.getElementById('save-payment-draft').disabled, true);
  assert.equal(browser.document.getElementById('submit-payroll-payment').disabled, true);
});

test('payroll submit uses the planned idempotent Task 11 route and cannot double-submit', async () => {
  const app = payrollFixture();
  const browser = await app.browser();
  await browser.clickButton('工资');
  await browser.clickButton('查看工资档案');
  await browser.clickButton('领取并开始付款');
  await browser.input('bank-amount', '100');
  await browser.call('savePaymentDraft');
  const proof = new File([new Uint8Array([1])], 'proof.jpg', { type: 'image/jpeg' });
  await browser.call('uploadProof', 'bank', [proof]);

  const submit = browser.document.getElementById('submit-payroll-payment');
  await Promise.all([submit.click(), submit.click()]);
  const requests = app.requests.filter((request) => request.path.endsWith('/ATTEMPT-DRAFT/submit'));
  assert.equal(requests.length, 1);
  assert.match(requests[0].headers['Idempotency-Key'], /^PAYROLL-1:ATTEMPT-DRAFT:/);
});

test('a payroll mutation conflict refreshes safely into dossier-only mode', async () => {
  const app = payrollFixture({ splitConflict: true });
  const browser = await app.browser();
  await browser.clickButton('工资');
  await browser.clickButton('查看工资档案');
  await browser.clickButton('领取并开始付款');
  await browser.input('bank-amount', '100');
  await browser.call('savePaymentDraft');

  assert.match(browser.document.app.textContent, /工资状态已更新/);
  assert.equal(browser.document.getElementById('bank-amount'), null);
  assert.match(browser.document.app.textContent, /版本 1/);
});

test('a late proof upload cannot overwrite payroll state after navigation', async () => {
  const gate = deferred();
  const app = payrollFixture({ uploadGate: gate });
  const browser = await app.browser();
  await browser.clickButton('工资');
  await browser.clickButton('查看工资档案');
  await browser.clickButton('领取并开始付款');
  await browser.input('bank-amount', '100');
  await browser.call('savePaymentDraft');
  const proof = new File([new Uint8Array([1])], 'late.jpg', { type: 'image/jpeg' });
  const upload = browser.call('uploadProof', 'bank', [proof]);
  await new Promise((resolve) => setImmediate(resolve));
  await browser.clickButton('工资');
  gate.resolve(json({ ok: true, proof: {
    proof_id: 'PROOF-LATE', attempt_id: 'ATTEMPT-DRAFT', method: 'bank',
    file_name: 'late.jpg', mime_type: 'image/jpeg', size_bytes: 1,
    uploaded_by: 'ADMIN-1', uploaded_at: '2026-07-29T02:10:00.000Z'
  } }));
  await upload;

  assert.match(browser.document.app.textContent, /工资中心/);
  assert.equal(browser.document.getElementById('bank-amount'), null);
  assert.doesNotMatch(browser.document.app.textContent, /late.jpg/);
  assert.equal(browser.objectUrls.size, 0);
});
