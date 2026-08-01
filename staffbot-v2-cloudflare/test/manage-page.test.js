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

function fixture({ initialTask = task, pathname = '/manage' } = {}) {
  const requests = [];
  let currentTask = structuredClone(initialTask);
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
    history: []
  });

  return {
    requests,
    setTask(value) { currentTask = structuredClone(value); },
    async browser() {
      return executeManageClient(MANAGE_CLIENT, {
        pathname,
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
          if (path === '/api/manage/stores/STORE-1/approvals/income/INC-1') return json(detail());
          if (path === '/api/manage/tasks/income/INC-1/claim') {
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
            return json({ ok: true, claim: structuredClone(currentTask.claim) });
          }
          if (path === '/api/manage/tasks/income/INC-1/release') {
            currentTask.claim = null;
            return json({ ok: true, claim: null });
          }
          if (path.endsWith('/approve')) {
            currentTask.status = 'approved';
            currentTask.claim = null;
            return json({ ok: true, notification: { status: 'sent' } });
          }
          if (path.endsWith('/reject')) {
            currentTask.status = 'rejected';
            currentTask.claim = null;
            return json({ ok: true, notification: { status: 'sent' } });
          }
          return json({ ok: false, error: 'not_found' }, 404);
        }
      });
    }
  };
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
  assert.equal(app.requests.at(-1).path, '/api/manage/stores/STORE-1/approvals/income/INC-1/approve');
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
  assert.deepEqual(app.requests.at(-1).body, { reason: '金额不清楚' });
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
