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
  search = '',
  now,
  decisionGate = null,
  claimGate = null,
  refreshFailsAfterDecision = false,
  decisionConflictRefreshFails = false,
  claimConflictRefreshFails = false,
  deferRenew = false,
  reconnectSessionGate = null,
  failReconnectSession = false,
  takeoverGate = null,
  takeoverConflict = false,
  takeoverRefreshFails = false,
  notificationRetryGate = null,
  notificationRetryFails = false,
  notificationRetryRefreshFails = false,
  detailOverrides = {}
} = {}) {
  const requests = [];
  let currentTask = structuredClone(initialTask);
  let decisionMade = false;
  let authorityRefreshFails = false;
  let sessionReads = 0;
  let notificationRetried = false;
  const renewResolvers = [];
  const detail = () => {
    const defaultHistory = currentTask.status === 'pending' ? [] : [{
      id: 1,
      admin_id: 'ADMIN-1',
      action: currentTask.status === 'approved' ? 'approve_income' : 'reject_income',
      details: currentTask.status === 'rejected' ? { reason: '金额不清楚' } : {},
      created_at: '2026-07-29T02:10:00.000Z'
    }];
    const history = structuredClone(detailOverrides.history || defaultHistory);
    if (notificationRetried) history.push({
      id: 99,
      admin_id: 'ADMIN-1',
      action: 'approval_notification_retried',
      details: { task_type: currentTask.task_type },
      created_at: '2026-07-29T02:20:00.000Z'
    });
    return {
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
      ...structuredClone(detailOverrides),
      history
    };
  };

  return {
    requests,
    renewResolvers,
    setTask(value) { currentTask = structuredClone(value); },
    async browser() {
      return executeManageClient(MANAGE_CLIENT, {
        pathname,
        search,
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
            sessionReads += 1;
            if (sessionReads > 1 && reconnectSessionGate) await reconnectSessionGate.promise;
            if (sessionReads > 1 && failReconnectSession) {
              return json({ ok: false, error: 'refresh_failed' }, 503);
            }
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
          if (path === '/api/manage/tasks/income/INC-1/takeover') {
            if (takeoverGate) await takeoverGate.promise;
            if (takeoverConflict) return json({ ok: false, error: 'task_claimed' }, 409);
            currentTask.claim = {
              claimed_by: 'ADMIN-1',
              claimed_at: '2026-07-29T02:05:00.000Z',
              lease_expires_at: '2099-07-29T02:20:00.000Z',
              active: true
            };
            if (takeoverRefreshFails) authorityRefreshFails = true;
            return json({ ok: true, claim: structuredClone(currentTask.claim) });
          }
          if (path === '/api/manage/stores/STORE-1/approvals/income/INC-1/notify/retry') {
            if (notificationRetryGate) await notificationRetryGate.promise;
            if (notificationRetryFails) {
              return json({ ok: false, error: 'notification_retry_not_available' }, 409);
            }
            notificationRetried = true;
            if (notificationRetryRefreshFails) authorityRefreshFails = true;
            return json({ ok: true, notification: { status: 'sent', retryable: false } });
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

test('offline login is visibly read-only and does not send or verify a code', async () => {
  const requests = [];
  const browser = await executeManageClient(MANAGE_CLIENT, {
    online: false,
    async fetch(path, options = {}) {
      requests.push({ path, method: options.method || 'GET' });
      return json({ ok: false, error: 'unauthorized' }, 401);
    }
  });

  assert.match(browser.document.app.textContent, /当前离线，只能查看已加载内容/);
  assert.deepEqual(browser.serviceWorkerRegistrations, ['/manage/sw.js']);
  assert.deepEqual(browser.serviceWorkerRegistrationDetails, [{
    script: '/manage/sw.js',
    scope: '/manage/'
  }]);
  assert.equal(browser.document.getElementById('send-code').disabled, true);
  assert.equal(browser.document.getElementById('verify-code').disabled, true);
  const before = requests.length;
  await browser.clickButton('发送验证码');
  await browser.clickButton('登录');
  assert.equal(requests.length, before);

  await browser.setOnline(true);
  assert.equal(browser.document.getElementById('send-code').disabled, false);
  assert.equal(browser.document.getElementById('verify-code').disabled, false);
});

test('reconnecting an approval stays locked until session stores detail and tasks are authoritative', async () => {
  const gate = deferred();
  const app = fixture({
    initialTask: {
      ...task,
      claim: {
        claimed_by: 'ADMIN-1',
        claimed_at: '2026-07-29T02:00:00.000Z',
        lease_expires_at: '2099-07-29T02:15:00.000Z',
        active: true
      }
    },
    reconnectSessionGate: gate
  });
  const browser = await app.browser();
  await browser.clickButton('查看详情');
  await browser.setOnline(false);
  app.setTask({
    ...task,
    claim: {
      claimed_by: 'ADMIN-2',
      claimed_at: '2026-07-29T02:05:00.000Z',
      lease_expires_at: '2099-07-29T02:20:00.000Z',
      active: true
    }
  });
  await browser.setOnline(true);

  assert.equal(browser.document.getElementById('approve').disabled, true);
  assert.match(browser.document.app.textContent, /正在刷新最新状态/);
  gate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(browser.document.getElementById('claim-status').textContent, /ADMIN-2/);
  assert.equal(browser.document.getElementById('approve').disabled, true);
  assert.ok(app.requests.filter((request) => request.path === '/api/manage/session').length >= 2);
  assert.ok(app.requests.filter((request) => request.path === '/api/manage/stores').length >= 2);
  assert.ok(app.requests.some((request) => request.path.startsWith('/api/manage/tasks?')));
});

test('failed approval reconnect keeps cached detail locked and read-only', async () => {
  const app = fixture({
    initialTask: {
      ...task,
      claim: {
        claimed_by: 'ADMIN-1',
        claimed_at: '2026-07-29T02:00:00.000Z',
        lease_expires_at: '2099-07-29T02:15:00.000Z',
        active: true
      }
    },
    failReconnectSession: true
  });
  const browser = await app.browser();
  await browser.clickButton('查看详情');
  await browser.setOnline(false);
  await browser.setOnline(true);

  assert.equal(browser.document.getElementById('approve').disabled, true);
  assert.match(browser.document.app.textContent, /刷新失败.*只读/);
});

test('an occupied approval can be taken over with a reason and authoritative refresh', async () => {
  const app = fixture({
    initialTask: {
      ...task,
      claim: {
        claimed_by: 'ADMIN-2',
        claimed_at: '2026-07-29T02:00:00.000Z',
        lease_expires_at: '2099-07-29T02:15:00.000Z',
        active: true
      }
    }
  });
  const browser = await app.browser();
  await browser.clickButton('查看详情');
  await browser.clickButton('负责人接管');
  await browser.input('takeover-reason', '负责人重新分配');
  await browser.clickButton('确认接管');

  const takeover = app.requests.find((request) => request.path.endsWith('/takeover'));
  assert.deepEqual(takeover.body, { reason: '负责人重新分配' });
  assert.equal(takeover.csrf, 'CSRF-1');
  assert.ok(app.requests.filter((request) => (
    request.path === '/api/manage/stores/STORE-1/approvals/income/INC-1'
  )).length >= 2);
  assert.ok(app.requests.filter((request) => request.path.startsWith('/api/manage/tasks?')).length >= 2);
  assert.match(browser.document.getElementById('claim-status').textContent, /ADMIN-1/);
  assert.equal(browser.document.getElementById('approve').disabled, false);
});

test('a committed approval takeover stays locked when its authoritative refresh fails', async () => {
  const app = fixture({
    takeoverRefreshFails: true,
    initialTask: {
      ...task,
      claim: {
        claimed_by: 'ADMIN-2',
        claimed_at: '2026-07-29T02:00:00.000Z',
        lease_expires_at: '2099-07-29T02:15:00.000Z',
        active: true
      }
    }
  });
  const browser = await app.browser();
  await browser.clickButton('查看详情');
  await browser.clickButton('负责人接管');
  await browser.input('takeover-reason', '接管后刷新失败');
  await browser.clickButton('确认接管');

  const detailReads = app.requests.filter((request) => (
    request.path === '/api/manage/stores/STORE-1/approvals/income/INC-1'
  ));
  assert.equal(detailReads.length, 2);
  assert.match(browser.document.getElementById('app-message').textContent, /任务已接管.*最新状态加载失败.*锁定/);
  assert.doesNotMatch(browser.document.getElementById('app-message').textContent, /接管失败/);
  assert.equal(browser.document.getElementById('takeover').disabled, true);
  await browser.clickButton('负责人接管');
  assert.equal(app.requests.filter((request) => request.path.endsWith('/takeover')).length, 1);
});

test('approval takeover is offline-disabled and a conflict refreshes current authority', async () => {
  const occupied = {
    ...task,
    claim: {
      claimed_by: 'ADMIN-2',
      claimed_at: '2026-07-29T02:00:00.000Z',
      lease_expires_at: '2099-07-29T02:15:00.000Z',
      active: true
    }
  };
  const offlineApp = fixture({ initialTask: occupied });
  const offline = await offlineApp.browser();
  await offline.clickButton('查看详情');
  await offline.setOnline(false);
  assert.equal(offline.document.getElementById('takeover').disabled, true);
  await offline.clickButton('负责人接管');
  assert.equal(offlineApp.requests.some((request) => request.path.endsWith('/takeover')), false);

  const conflictApp = fixture({ initialTask: occupied, takeoverConflict: true });
  const conflict = await conflictApp.browser();
  await conflict.clickButton('查看详情');
  await conflict.clickButton('负责人接管');
  await conflict.input('takeover-reason', '接管冲突测试');
  await conflict.clickButton('确认接管');
  assert.ok(conflictApp.requests.some((request) => request.path.endsWith('/takeover')));
  assert.ok(conflictApp.requests.filter((request) => (
    request.path === '/api/manage/stores/STORE-1/approvals/income/INC-1'
  )).length >= 2);
  assert.match(conflict.document.getElementById('claim-status').textContent, /ADMIN-2/);
});

test('a late takeover response cannot revive an approval after navigation', async () => {
  const gate = deferred();
  const app = fixture({
    takeoverGate: gate,
    initialTask: {
      ...task,
      claim: {
        claimed_by: 'ADMIN-2',
        claimed_at: '2026-07-29T02:00:00.000Z',
        lease_expires_at: '2099-07-29T02:15:00.000Z',
        active: true
      }
    }
  });
  const browser = await app.browser();
  await browser.clickButton('查看详情');
  await browser.clickButton('负责人接管');
  await browser.input('takeover-reason', '稍后返回');
  const takeover = browser.document.getElementById('takeover-confirm').click();
  await new Promise((resolve) => setImmediate(resolve));
  await browser.clickButton('审批');
  gate.resolve();
  await takeover;

  assert.match(browser.document.app.textContent, /审批中心/);
  assert.equal(browser.document.getElementById('claim-status'), null);
});

test('failed approval Telegram notification can retry once and refresh authoritative history', async () => {
  const failedHistory = [{
    id: 2,
    admin_id: 'ADMIN-1',
    action: 'approval_notification_failed',
    details: { task_type: 'income' },
    created_at: '2026-07-29T02:15:00.000Z'
  }];
  const app = fixture({
    initialTask: { ...task, status: 'approved', claim: null },
    detailOverrides: { history: failedHistory }
  });
  const browser = await app.browser();
  await browser.clickButton('查看详情');
  await browser.clickButton('重试 Telegram 通知');

  assert.ok(app.requests.some((request) => (
    request.path === '/api/manage/stores/STORE-1/approvals/income/INC-1/notify/retry'
    && request.method === 'POST'
  )));
  assert.ok(app.requests.filter((request) => (
    request.path === '/api/manage/stores/STORE-1/approvals/income/INC-1'
  )).length >= 2);
  assert.equal(browser.document.getElementById('retry-approval-notification'), null);
  assert.match(browser.document.app.textContent, /Telegram 通知已发送/);
});

test('a committed approval Telegram retry stays locked when its authoritative refresh fails', async () => {
  const app = fixture({
    notificationRetryRefreshFails: true,
    initialTask: { ...task, status: 'approved', claim: null },
    detailOverrides: { history: [{
      id: 2,
      admin_id: 'ADMIN-1',
      action: 'approval_notification_failed',
      details: { task_type: 'income' },
      created_at: '2026-07-29T02:15:00.000Z'
    }] }
  });
  const browser = await app.browser();
  await browser.clickButton('查看详情');
  await browser.clickButton('重试 Telegram 通知');

  const detailReads = app.requests.filter((request) => (
    request.path === '/api/manage/stores/STORE-1/approvals/income/INC-1'
  ));
  assert.equal(detailReads.length, 2);
  assert.match(browser.document.getElementById('app-message').textContent, /Telegram 通知已发送.*最新状态加载失败.*锁定/);
  assert.doesNotMatch(browser.document.getElementById('app-message').textContent, /通知发送失败/);
  assert.equal(browser.document.getElementById('retry-approval-notification').disabled, true);
  await browser.clickButton('重试 Telegram 通知');
  assert.equal(app.requests.filter((request) => request.path.endsWith('/notify/retry')).length, 1);
});

test('approval Telegram retry is offline-disabled and a conflict refreshes history', async () => {
  const options = {
    initialTask: { ...task, status: 'approved', claim: null },
    detailOverrides: { history: [{
      id: 2,
      admin_id: 'ADMIN-1',
      action: 'approval_notification_failed',
      details: { task_type: 'income' },
      created_at: '2026-07-29T02:15:00.000Z'
    }] }
  };
  const offlineApp = fixture(options);
  const offline = await offlineApp.browser();
  await offline.clickButton('查看详情');
  await offline.setOnline(false);
  assert.equal(offline.document.getElementById('retry-approval-notification').disabled, true);
  await offline.clickButton('重试 Telegram 通知');
  assert.equal(offlineApp.requests.some((request) => request.path.endsWith('/notify/retry')), false);

  const conflictApp = fixture({ ...options, notificationRetryFails: true });
  const conflict = await conflictApp.browser();
  await conflict.clickButton('查看详情');
  await conflict.clickButton('重试 Telegram 通知');
  assert.ok(conflictApp.requests.filter((request) => (
    request.path === '/api/manage/stores/STORE-1/approvals/income/INC-1'
  )).length >= 2);
  assert.ok(conflict.document.getElementById('retry-approval-notification'));
});

test('a late approval Telegram retry cannot overwrite navigation state', async () => {
  const gate = deferred();
  const app = fixture({
    notificationRetryGate: gate,
    initialTask: { ...task, status: 'approved', claim: null },
    detailOverrides: { history: [{
      id: 2,
      admin_id: 'ADMIN-1',
      action: 'approval_notification_failed',
      details: { task_type: 'income' },
      created_at: '2026-07-29T02:15:00.000Z'
    }] }
  });
  const browser = await app.browser();
  await browser.clickButton('查看详情');
  const retry = browser.document.getElementById('retry-approval-notification').click();
  await new Promise((resolve) => setImmediate(resolve));
  await browser.clickButton('待办');
  gate.resolve();
  await retry;

  assert.match(browser.document.app.textContent, /任务中心/);
  assert.equal(browser.document.getElementById('retry-approval-notification'), null);
});

test('approval notification retry ignores a same-id failure from another task type', async () => {
  const app = fixture({
    initialTask: { ...task, status: 'approved', claim: null },
    detailOverrides: { history: [
      {
        id: 2,
        admin_id: 'ADMIN-1',
        action: 'approval_notification_sent',
        details: { task_type: 'income' },
        created_at: '2026-07-29T02:15:00.000Z'
      },
      {
        id: 3,
        admin_id: 'ADMIN-1',
        action: 'approval_notification_failed',
        details: { task_type: 'leave' },
        created_at: '2026-07-29T02:16:00.000Z'
      }
    ] }
  });
  const browser = await app.browser();
  await browser.clickButton('查看详情');

  assert.equal(browser.document.getElementById('retry-approval-notification'), null);
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

function completedApprovalDetail({
  type = 'income',
  id = 'INC-1',
  storeId = 'STORE-1',
  storeName = 'Tokyo Club'
} = {}) {
  return {
    task: {
      ...task,
      task_type: type,
      task_id: id,
      store_id: storeId,
      store_name: storeName,
      status: 'approved'
    },
    request: { request_id: id, income: 100, status: 'approved' },
    employee: { telegram_id: 'EMP-1', display_name: 'Alice', language: 'zh' },
    store: { store_id: storeId, name: storeName, currency: '₫', timezone: 'Asia/Tokyo' },
    attachments: [],
    history: [{
      id: 1,
      admin_id: 'ADMIN-1',
      action: 'approve_income',
      details: {},
      created_at: '2026-07-29T02:10:00.000Z'
    }]
  };
}

async function directApprovalBrowser({
  pathname = '/manage/tasks/income/INC-1',
  search = '?store=STORE-1',
  stores = [{ store_id: 'STORE-1', name: 'Tokyo Club' }],
  detailForPath = () => completedApprovalDetail(),
  tasksStatus = 200,
  tasksGate = null,
  now
} = {}) {
  const requests = [];
  const browser = await executeManageClient(MANAGE_CLIENT, {
    pathname,
    search,
    now,
    async fetch(path, options = {}) {
      requests.push({ path, method: options.method || 'GET' });
      if (path === '/api/admin/me') return json({ ok: true });
      if (path === '/api/manage/session') {
        return json({ telegram_id: 'ADMIN-1', csrf_token: 'CSRF-1' });
      }
      if (path === '/api/manage/stores') return json({ stores });
      if (path === '/api/manage/tasks?') {
        if (tasksGate) return tasksGate.promise;
        return tasksStatus === 200
          ? json({ tasks: [] })
          : json({ ok: false, error: 'tasks_unavailable' }, tasksStatus);
      }
      if (path.endsWith('/renew')) {
        return json({
          ok: true,
          claim: {
            claimed_by: 'ADMIN-1',
            claimed_at: '2026-07-29T01:45:00.000Z',
            lease_expires_at: '2099-07-29T02:15:00.000Z',
            active: true
          }
        });
      }
      if (path.includes('/approvals/')) return json(detailForPath(path));
      return json({ ok: false, error: 'not_found' }, 404);
    }
  });
  return { browser, requests };
}

test('a completed approval deep link opens exact authorized detail without a pending task', async () => {
  const app = await directApprovalBrowser({
    pathname: '/manage/tasks/income/INC%2F1',
    search: '?store=STORE%2F1',
    stores: [{ store_id: 'STORE/1', name: 'Tokyo Club' }],
    detailForPath: () => completedApprovalDetail({ id: 'INC/1', storeId: 'STORE/1' })
  });

  assert.ok(app.requests.some((request) =>
    request.path === '/api/manage/stores/STORE%2F1/approvals/income/INC%2F1'
  ));
  assert.ok(
    app.requests.findIndex((request) => request.path === '/api/manage/stores')
    < app.requests.findIndex((request) => request.path.includes('/approvals/'))
  );
  assert.match(app.browser.document.app.textContent, /已通过/);
  assert.equal(app.browser.document.getElementById('approve').disabled, true);
  assert.equal(app.requests.some((request) => request.method !== 'GET'), false);
});

test('a completed approval never renews a residual owned claim', async () => {
  const now = new Date('2026-07-29T02:00:00.000Z').getTime();
  const app = await directApprovalBrowser({
    now,
    detailForPath: () => {
      const detail = completedApprovalDetail();
      detail.task.claim = {
        claimed_by: 'ADMIN-1',
        claimed_at: '2026-07-29T01:45:00.000Z',
        lease_expires_at: '2026-07-29T02:04:00.000Z',
        active: true
      };
      return detail;
    }
  });
  await app.browser.advanceTimers(5 * 60 * 1000);

  assert.equal(app.requests.some((request) => request.method === 'POST'), false);
  assert.match(app.browser.document.app.textContent, /已通过/);
});

test('a direct task still opens when the pending task list is unavailable', async () => {
  const app = await directApprovalBrowser({ tasksStatus: 503 });

  assert.match(app.browser.document.app.textContent, /已通过/);
  assert.match(app.browser.document.getElementById('app-message').textContent, /待办列表暂时无法加载/);
  assert.ok(app.requests.some((request) => request.path.includes('/approvals/')));
  assert.ok(app.browser.navigationLabels().includes('待办'));
});

test('a late task-list failure cannot add a message after navigation leaves the direct task', async () => {
  const gate = deferred();
  const app = await directApprovalBrowser({ tasksGate: gate });
  assert.match(app.browser.document.app.textContent, /已通过/);

  await app.browser.clickButton('更多');
  assert.match(app.browser.document.app.textContent, /已登录：ADMIN-1/);
  gate.resolve(json({ ok: false, error: 'tasks_unavailable' }, 503));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(app.browser.document.app.textContent, /已登录：ADMIN-1/);
  assert.doesNotMatch(app.browser.document.app.textContent, /待办列表暂时无法加载|当前任务仍可查看/);
});

test('a late task-list failure from an old session cannot contaminate a new session', async () => {
  const firstTasks = deferred();
  let adminId = 'ADMIN-1';
  let taskCalls = 0;
  const browser = await executeManageClient(MANAGE_CLIENT, {
    pathname: '/manage/tasks/income/INC-1',
    search: '?store=STORE-1',
    async fetch(path) {
      if (path === '/api/admin/me') return json({ ok: true });
      if (path === '/api/manage/session') {
        return json({ telegram_id: adminId, csrf_token: adminId + '-CSRF' });
      }
      if (path === '/api/manage/stores') {
        return json({ stores: [{ store_id: 'STORE-1', name: adminId + ' Store' }] });
      }
      if (path === '/api/manage/tasks?') {
        taskCalls += 1;
        return taskCalls === 1 ? firstTasks.promise : json({ tasks: [] });
      }
      if (path.includes('/approvals/')) {
        const detail = completedApprovalDetail({ storeName: adminId + ' Store' });
        detail.task.employee_name = adminId === 'ADMIN-1' ? 'Alice' : 'Bob';
        detail.employee.display_name = detail.task.employee_name;
        return json(detail);
      }
      if (path === '/api/admin/logout') return json({ ok: true });
      if (path === '/api/admin/login/verify') {
        adminId = 'ADMIN-2';
        return json({ ok: true });
      }
      return json({ ok: false, error: 'not_found' }, 404);
    }
  });
  assert.match(browser.document.app.textContent, /Alice/);

  await browser.clickButton('更多');
  await browser.clickButton('退出登录');
  browser.document.getElementById('telegram-id').value = 'ADMIN-2';
  browser.document.getElementById('login-code').value = '123456';
  await browser.clickButton('登录');
  assert.match(browser.document.app.textContent, /Bob/);
  assert.match(browser.document.app.textContent, /ADMIN-2/);

  firstTasks.resolve(json({ ok: false, error: 'tasks_unavailable' }, 503));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(browser.document.app.textContent, /Bob/);
  assert.match(browser.document.app.textContent, /ADMIN-2/);
  assert.doesNotMatch(browser.document.app.textContent, /待办列表暂时无法加载|当前任务仍可查看|Alice/);
});

test('task deep links reject missing duplicate blank and unauthorized stores before detail fetch', async (context) => {
  for (const [name, search] of [
    ['missing', ''],
    ['duplicate', '?store=STORE-1&store=STORE-2'],
    ['blank', '?store=%20%20'],
    ['unauthorized', '?store=STORE-2']
  ]) {
    await context.test(name, async () => {
      const app = await directApprovalBrowser({ search });
      assert.equal(
        app.requests.some((request) => request.path.includes('/approvals/')),
        false
      );
      assert.match(app.browser.document.app.textContent, /任务不存在或无权查看/);
    });
  }
});

test('mismatched approval response identity is rejected and never adopted', async (context) => {
  for (const [name, mutate] of [
    ['type', (detail) => { detail.task.task_type = 'leave'; }],
    ['id', (detail) => { detail.task.task_id = 'INC-2'; }],
    ['task store', (detail) => { detail.task.store_id = 'STORE-2'; }],
    ['detail store', (detail) => { detail.store.store_id = 'STORE-2'; }]
  ]) {
    await context.test(name, async () => {
      const app = await directApprovalBrowser({
        detailForPath: () => {
          const detail = completedApprovalDetail({ storeName: 'Injected Store' });
          mutate(detail);
          return detail;
        }
      });
      assert.match(app.browser.document.app.textContent, /任务不存在或无权查看/);
      assert.doesNotMatch(app.browser.document.app.textContent, /Injected Store|Alice/);
    });
  }
});

test('the URL store selects the exact same-id task across authorized stores', async () => {
  const app = await directApprovalBrowser({
    search: '?store=STORE-2',
    stores: [
      { store_id: 'STORE-1', name: 'Tokyo Club' },
      { store_id: 'STORE-2', name: 'Osaka Club' }
    ],
    detailForPath: () => completedApprovalDetail({
      storeId: 'STORE-2',
      storeName: 'Osaka Club'
    })
  });

  assert.ok(app.requests.some((request) =>
    request.path === '/api/manage/stores/STORE-2/approvals/income/INC-1'
  ));
  assert.equal(app.requests.some((request) =>
    request.path === '/api/manage/stores/STORE-1/approvals/income/INC-1'
  ), false);
  assert.match(app.browser.document.app.textContent, /Osaka Club/);
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
  assert.ok(externalBrowser.document.getElementById('takeover'));
  assert.equal(externalBrowser.document.getElementById('claim'), null);
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

function payrollDossier({
  claim = null,
  draft = false,
  draftId = 'ATTEMPT-DRAFT',
  amountMicros = 100_000_000,
  draftProofs = []
} = {}) {
  return {
    payroll: {
      ...payrollListItem,
      amount_snapshot_micros: amountMicros,
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
        attempt_id: draftId, version: draftId.endsWith('2') ? 3 : 2, status: 'draft',
        bank_micros: 0, usdt_micros: 0, cash_micros: 0, proofs: draftProofs
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
  initialDossier = payrollDossier(),
  uploadFailureAt = 0,
  uploadGate = null,
  uploadGates = new Map(),
  submitFailures = 0,
  submitConflict = '',
  splitConflict = false,
  storeName = 'Tokyo Club',
  initialTasks = [],
  pathname = '/manage',
  search = '',
  tasksStatus = 200,
  now,
  draftFallbackAttempt = null,
  takeoverGate = null,
  takeoverErrorStatus = 0,
  takeoverRefreshFails = false,
  notificationRetryGate = null,
  notificationRetryFails = false,
  notificationRetryRefreshFails = false,
  confirm = () => true
} = {}) {
  const requests = [];
  const activeClaim = {
    claimed_by: 'ADMIN-1', claimed_at: '2026-07-29T02:00:00.000Z',
    lease_expires_at: '2099-07-29T02:15:00.000Z', active: true
  };
  let dossier = structuredClone(initialDossier);
  let uploadCount = 0;
  let remainingSubmitFailures = submitFailures;
  let nextDossierGate = null;
  let manageTasks = null;
  let currentDraftFallback = draftFallbackAttempt;
  let authorityRefreshFails = false;
  return {
    requests,
    setDossier(value) { dossier = structuredClone(value); },
    gateNextDossier(gate) { nextDossierGate = gate; },
    setManageTasks(tasks) { manageTasks = structuredClone(tasks); },
    setDraftFallback(attempt) { currentDraftFallback = structuredClone(attempt); },
    async browser() {
      return executeManageClient(MANAGE_CLIENT, {
        confirm,
        pathname,
        search,
        now,
        async fetch(path, options = {}) {
          const method = options.method || 'GET';
          requests.push({ path, method, headers: options.headers, body: options.body });
          if (path === '/api/admin/me') return json({ ok: true });
          if (path === '/api/manage/session') {
            return json({ telegram_id: 'ADMIN-1', csrf_token: 'CSRF-1' });
          }
          if (path === '/api/manage/stores') {
            return json({ stores: [
              { store_id: 'STORE-1', name: storeName, currency: '$', timezone: 'Asia/Tokyo' },
              ...(initialTasks.some((item) => item.store_id === 'STORE-2')
                ? [{ store_id: 'STORE-2', name: 'Osaka Club', currency: '$', timezone: 'Asia/Tokyo' }]
                : [])
            ] });
          }
          if (path === '/api/manage/tasks?') {
            return tasksStatus === 200
              ? json({ tasks: structuredClone(initialTasks) })
              : json({ ok: false, error: 'tasks_unavailable' }, tasksStatus);
          }
          if (path === '/api/manage/tasks?store_id=STORE-1&type=payroll') {
            const matching = {
              task_type: 'payroll', task_id: dossier.payroll.payroll_id,
              store_id: dossier.payroll.store_id, store_name: storeName,
              employee_name: dossier.payroll.employee_name,
              status: dossier.payroll.status, claim: structuredClone(dossier.payroll.claim),
              submitted_at: dossier.payroll.cutoff_at, urgency: 300
            };
            return json({ tasks: structuredClone(manageTasks === null ? [matching] : manageTasks) });
          }
          if (path === '/api/manage/stores/STORE-1/payroll') {
            return json({ payroll: [{
              ...structuredClone(payrollListItem),
              amount_snapshot_micros: dossier.payroll.amount_snapshot_micros,
              status: dossier.payroll.status,
              claim: dossier.payroll.claim
            }] });
          }
          if (path === '/api/manage/stores/STORE-2/payroll') {
            return json({ payroll: [] });
          }
          if (path === '/api/manage/stores/STORE-1/payroll/PAYROLL-1' && method === 'GET') {
            if (authorityRefreshFails) {
              return json({ ok: false, error: 'refresh_failed' }, 503);
            }
            if (nextDossierGate) {
              const gate = nextDossierGate;
              nextDossierGate = null;
              return gate.promise;
            }
            return json(structuredClone(dossier));
          }
          if (path === '/api/manage/tasks/payroll/PAYROLL-1/claim') {
            dossier.payroll.claim = structuredClone(activeClaim);
            return json({ ok: true, claim: activeClaim });
          }
          if (path === '/api/manage/tasks/payroll/PAYROLL-1/renew') {
            dossier.payroll.claim = structuredClone(activeClaim);
            return json({ ok: true, claim: activeClaim });
          }
          if (path === '/api/manage/tasks/payroll/PAYROLL-1/takeover') {
            if (takeoverGate) await takeoverGate.promise;
            if (takeoverErrorStatus) {
              return json({
                ok: false,
                error: takeoverErrorStatus === 403 ? 'forbidden' : 'task_claimed'
              }, takeoverErrorStatus);
            }
            dossier.payroll.claim = structuredClone(activeClaim);
            if (takeoverRefreshFails) authorityRefreshFails = true;
            return json({ ok: true, claim: activeClaim });
          }
          if (path.endsWith('/attempts/draft')) {
            if (currentDraftFallback) {
              return json({ ok: true, attempt: structuredClone(currentDraftFallback) });
            }
            let draft = dossier.attempts.find((attempt) => attempt.status === 'draft');
            if (!draft) {
              dossier = payrollDossier({ claim: activeClaim, draft: true });
              draft = dossier.attempts[0];
            }
            return json({ ok: true, attempt: structuredClone(draft) });
          }
          const splitMatch = path.match(/\/attempts\/([^/]+)\/split$/);
          if (splitMatch) {
            if (splitConflict) return json({ error: 'task_claim_required' }, 409);
            const split = JSON.parse(options.body);
            const draft = dossier.attempts.find((attempt) => attempt.attempt_id === splitMatch[1]);
            Object.assign(draft, split);
            return json({ ok: true, attempt: structuredClone(draft) });
          }
          const proofMatch = path.match(/\/attempts\/([^/]+)\/proofs$/);
          if (proofMatch && method === 'POST') {
            uploadCount += 1;
            if (uploadGate) return uploadGate.promise;
            if (uploadCount === uploadFailureAt) return json({ error: 'upload_failed' }, 503);
            const methodName = options.body.get('method');
            const file = options.body.get('proof');
            const namedGate = uploadGates.get(file.name);
            if (namedGate) return namedGate.promise;
            const proof = {
              proof_id: `PROOF-${uploadCount}`, attempt_id: proofMatch[1],
              method: methodName, file_name: file.name,
              mime_type: file.type, size_bytes: file.size,
              uploaded_by: 'ADMIN-1', uploaded_at: '2026-07-29T02:10:00.000Z',
              url: `/api/manage/stores/STORE-1/payroll/proofs/PROOF-${uploadCount}`
            };
            dossier.attempts.find((attempt) => attempt.attempt_id === proofMatch[1]).proofs.push(proof);
            return json({ ok: true, proof });
          }
          if (path.includes('/proofs/') && method === 'DELETE') {
            const proofId = path.split('/').at(-1);
            dossier.attempts[0].proofs = dossier.attempts[0].proofs.filter((proof) => proof.proof_id !== proofId);
            return json({ ok: true });
          }
          const submitMatch = path.match(/\/attempts\/([^/]+)\/submit$/);
          if (submitMatch) {
            if (remainingSubmitFailures > 0) {
              remainingSubmitFailures -= 1;
              throw new TypeError('network_failed');
            }
            if (submitConflict) return json({ error: submitConflict }, 409);
            const draft = dossier.attempts.find((attempt) => attempt.attempt_id === submitMatch[1]);
            return json({ ok: true, attempt: { ...draft, status: 'submitted' } });
          }
          const retryMatch = path.match(/\/attempts\/([^/]+)\/notify\/retry$/);
          if (retryMatch) {
            if (notificationRetryGate) await notificationRetryGate.promise;
            if (notificationRetryFails) {
              return json({ ok: false, error: 'payment notification delivery in progress' }, 409);
            }
            dossier.history.push({
              id: 99,
              admin_id: 'ADMIN-1',
              action: 'payroll_notification_sent',
              details: { attempt_id: retryMatch[1], version: 1 },
              created_at: '2026-07-29T02:20:00.000Z'
            });
            if (notificationRetryRefreshFails) authorityRefreshFails = true;
            return json({ ok: true, notification: { status: 'sent', retryable: false } });
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
  assert.match(browser.document.app.textContent, /提交付款并通知员工/);
  assert.equal(browser.document.getElementById('bank-amount'), null);
  assert.equal(browser.document.getElementById('delete-proof-PROOF-OLD'), null);
});

test('an occupied payroll can be taken over with a reason and authoritative refresh', async () => {
  const occupied = payrollDossier({
    claim: {
      claimed_by: 'ADMIN-2',
      claimed_at: '2026-07-29T02:00:00.000Z',
      lease_expires_at: '2099-07-29T02:15:00.000Z',
      active: true
    }
  });
  const app = payrollFixture({ initialDossier: occupied });
  const browser = await app.browser();
  await browser.clickButton('工资');
  await browser.clickButton('查看工资档案');
  await browser.clickButton('负责人接管');
  await browser.input('takeover-reason', '工资负责人重新分配');
  await browser.clickButton('确认接管');

  const request = app.requests.find((item) => item.path.endsWith('/takeover'));
  assert.deepEqual(JSON.parse(request.body), { reason: '工资负责人重新分配' });
  assert.ok(app.requests.filter((item) => (
    item.path === '/api/manage/stores/STORE-1/payroll/PAYROLL-1'
    && item.method === 'GET'
  )).length >= 2);
  assert.ok(app.requests.some((item) => (
    item.path === '/api/manage/tasks?store_id=STORE-1&type=payroll'
  )));
  assert.match(browser.document.getElementById('claim-status').textContent, /ADMIN-1/);
  assert.equal(browser.document.getElementById('start-payroll-payment').disabled, false);
});

test('a committed payroll takeover stays locked when its authoritative refresh fails', async () => {
  const occupied = payrollDossier({
    claim: {
      claimed_by: 'ADMIN-2',
      claimed_at: '2026-07-29T02:00:00.000Z',
      lease_expires_at: '2099-07-29T02:15:00.000Z',
      active: true
    }
  });
  const app = payrollFixture({ initialDossier: occupied, takeoverRefreshFails: true });
  const browser = await app.browser();
  await browser.clickButton('工资');
  await browser.clickButton('查看工资档案');
  await browser.clickButton('负责人接管');
  await browser.input('takeover-reason', '工资接管后刷新失败');
  await browser.clickButton('确认接管');

  assert.match(browser.document.getElementById('app-message').textContent, /工资状态刷新失败.*只读/);
  assert.doesNotMatch(browser.document.getElementById('app-message').textContent, /接管失败/);
  assert.equal(browser.document.getElementById('takeover').disabled, true);
  await browser.clickButton('负责人接管');
  assert.equal(app.requests.filter((request) => request.path.endsWith('/takeover')).length, 1);
});

test('payroll takeover is offline-disabled and a 403 refreshes without claiming success', async () => {
  const occupied = payrollDossier({
    claim: {
      claimed_by: 'ADMIN-2',
      claimed_at: '2026-07-29T02:00:00.000Z',
      lease_expires_at: '2099-07-29T02:15:00.000Z',
      active: true
    }
  });
  const offlineApp = payrollFixture({ initialDossier: occupied });
  const offline = await offlineApp.browser();
  await offline.clickButton('工资');
  await offline.clickButton('查看工资档案');
  await offline.setOnline(false);
  assert.equal(offline.document.getElementById('takeover').disabled, true);
  await offline.clickButton('负责人接管');
  assert.equal(offlineApp.requests.some((item) => item.path.endsWith('/takeover')), false);

  const deniedApp = payrollFixture({
    initialDossier: occupied,
    takeoverErrorStatus: 403
  });
  const denied = await deniedApp.browser();
  await denied.clickButton('工资');
  await denied.clickButton('查看工资档案');
  await denied.clickButton('负责人接管');
  await denied.input('takeover-reason', '无权限接管测试');
  await denied.clickButton('确认接管');
  assert.match(denied.document.getElementById('app-message').textContent, /无权接管/);
  assert.doesNotMatch(denied.document.getElementById('app-message').textContent, /已接管/);
  assert.match(denied.document.getElementById('claim-status').textContent, /ADMIN-2/);
  assert.equal(denied.document.getElementById('start-payroll-payment'), null);
  assert.equal(denied.document.getElementById('bank-amount'), null);
  assert.ok(denied.document.getElementById('takeover'));
});

test('failed payroll Telegram notification can retry and refresh exact attempt history', async () => {
  const failed = payrollDossier();
  failed.payroll.status = 'awaiting_employee_confirmation';
  failed.history.push({
    id: 2,
    admin_id: 'ADMIN-1',
    action: 'payroll_notification_failed',
    details: { attempt_id: 'ATTEMPT-OLD', version: 1 },
    created_at: '2026-07-29T02:15:00.000Z'
  });
  const app = payrollFixture({ initialDossier: failed });
  const browser = await app.browser();
  await browser.clickButton('工资');
  await browser.clickButton('查看工资档案');
  await browser.clickButton('重试 Telegram 通知');

  assert.ok(app.requests.some((item) => (
    item.path === '/api/manage/stores/STORE-1/payroll/PAYROLL-1/attempts/ATTEMPT-OLD/notify/retry'
    && item.method === 'POST'
  )));
  assert.ok(app.requests.filter((item) => (
    item.path === '/api/manage/stores/STORE-1/payroll/PAYROLL-1'
  )).length >= 2);
  assert.equal(browser.document.getElementById('retry-payroll-notification-ATTEMPT-OLD'), null);
  assert.match(browser.document.getElementById('app-message').textContent, /Telegram 通知已发送/);
});

test('a committed payroll Telegram retry stays locked when its authoritative refresh fails', async () => {
  const failed = payrollDossier();
  failed.payroll.status = 'awaiting_employee_confirmation';
  failed.history.push({
    id: 2,
    admin_id: 'ADMIN-1',
    action: 'payroll_notification_failed',
    details: { attempt_id: 'ATTEMPT-OLD', version: 1 },
    created_at: '2026-07-29T02:15:00.000Z'
  });
  const app = payrollFixture({
    initialDossier: failed,
    notificationRetryRefreshFails: true
  });
  const browser = await app.browser();
  await browser.clickButton('工资');
  await browser.clickButton('查看工资档案');
  await browser.clickButton('重试 Telegram 通知');

  assert.match(browser.document.getElementById('app-message').textContent, /工资状态刷新失败.*只读/);
  assert.doesNotMatch(browser.document.getElementById('app-message').textContent, /通知发送失败/);
  assert.equal(browser.document.getElementById('retry-payroll-notification-ATTEMPT-OLD').disabled, true);
  await browser.clickButton('重试 Telegram 通知');
  assert.equal(app.requests.filter((request) => request.path.endsWith('/notify/retry')).length, 1);
});

test('payroll Telegram retry is offline-disabled and a conflict refreshes without success', async () => {
  const failed = payrollDossier();
  failed.payroll.status = 'awaiting_employee_confirmation';
  failed.history.push({
    id: 2,
    admin_id: 'ADMIN-1',
    action: 'payroll_notification_failed',
    details: { attempt_id: 'ATTEMPT-OLD', version: 1 },
    created_at: '2026-07-29T02:15:00.000Z'
  });
  const offlineApp = payrollFixture({ initialDossier: failed });
  const offline = await offlineApp.browser();
  await offline.clickButton('工资');
  await offline.clickButton('查看工资档案');
  await offline.setOnline(false);
  const retry = offline.document.getElementById('retry-payroll-notification-ATTEMPT-OLD');
  assert.equal(retry.disabled, true);
  await offline.clickButton('重试 Telegram 通知');
  assert.equal(offlineApp.requests.some((item) => item.path.endsWith('/notify/retry')), false);

  const conflictApp = payrollFixture({ initialDossier: failed, notificationRetryFails: true });
  const conflict = await conflictApp.browser();
  await conflict.clickButton('工资');
  await conflict.clickButton('查看工资档案');
  await conflict.clickButton('重试 Telegram 通知');
  assert.match(conflict.document.getElementById('app-message').textContent, /发送冲突/);
  assert.doesNotMatch(conflict.document.getElementById('app-message').textContent, /已发送/);
  assert.ok(conflict.document.getElementById('retry-payroll-notification-ATTEMPT-OLD'));
});

test('a late payroll Telegram retry cannot overwrite navigation state', async () => {
  const gate = deferred();
  const failed = payrollDossier();
  failed.payroll.status = 'awaiting_employee_confirmation';
  failed.history.push({
    id: 2,
    admin_id: 'ADMIN-1',
    action: 'payroll_notification_failed',
    details: { attempt_id: 'ATTEMPT-OLD', version: 1 },
    created_at: '2026-07-29T02:15:00.000Z'
  });
  const app = payrollFixture({ initialDossier: failed, notificationRetryGate: gate });
  const browser = await app.browser();
  await browser.clickButton('工资');
  await browser.clickButton('查看工资档案');
  const retry = browser.document
    .getElementById('retry-payroll-notification-ATTEMPT-OLD').click();
  await new Promise((resolve) => setImmediate(resolve));
  await browser.clickButton('待办');
  gate.resolve();
  await retry;

  assert.match(browser.document.app.textContent, /任务中心/);
  assert.equal(browser.document.getElementById('claim-status'), null);
});

test('a completed payroll deep link opens its dossier without a pending task or payment action', async () => {
  const completed = payrollDossier();
  completed.payroll.status = 'confirmed';
  completed.payroll.claim = null;
  const app = payrollFixture({
    initialDossier: completed,
    pathname: '/manage/tasks/payroll/PAYROLL-1',
    search: '?store=STORE-1',
    initialTasks: []
  });
  const browser = await app.browser();

  assert.ok(app.requests.some((request) =>
    request.path === '/api/manage/stores/STORE-1/payroll/PAYROLL-1'
  ));
  assert.match(browser.document.app.textContent, /工资档案/);
  assert.equal(browser.document.getElementById('start-payroll-payment'), null);
  assert.equal(app.requests.some((request) => request.method === 'POST'), false);
});

test('a confirmed payroll shows a completed Chinese summary in store time', async () => {
  const completed = payrollDossier();
  completed.payroll.status = 'confirmed';
  completed.payroll.confirmed_at = '2026-07-29T02:00:00.000Z';
  completed.payroll.claim = null;
  const app = payrollFixture({ initialDossier: completed });
  const browser = await app.browser();

  await browser.clickButton('工资');
  const listText = browser.document.app.textContent;
  assert.match(listText, /员工已确认 · 已完成/);
  assert.doesNotMatch(listText, /confirmed|未领取/);

  await browser.clickButton('查看工资档案');
  const detailText = browser.document.app.textContent;
  assert.match(detailText, /工资已完成/);
  assert.match(detailText, /工资 IDPAYROLL-1/);
  assert.match(detailText, /确认账号EMP-1/);
  assert.match(detailText, /确认时间2026-07-29 11:00（店铺时区）/);
  assert.doesNotMatch(detailText, /当前未领取/);
});

test('completed payroll traceability is Chinese and keeps every proof', async () => {
  const completed = payrollDossier();
  completed.payroll.status = 'confirmed';
  completed.payroll.confirmed_at = '2026-07-29T02:00:00.000Z';
  completed.payroll.claim = null;
  completed.attempts[0].status = 'employee_confirmed';
  completed.attempts[0].employee_response = 'confirmed';
  completed.attempts[0].employee_responded_at = '2026-07-29T02:00:00.000Z';
  completed.attempts[0].proofs.push({
    proof_id: 'PROOF-USDT', method: 'usdt', mime_type: 'image/png',
    uploaded_at: '2026-07-16T03:56:00.000Z',
    url: '/api/manage/stores/STORE-1/payroll/proofs/PROOF-USDT'
  });
  completed.history.push({
    id: 2,
    admin_id: 'EMP-1',
    action: 'confirm_payroll_receipt',
    details: { attempt_id: 'ATTEMPT-OLD', version: 1 },
    created_at: '2026-07-29T02:00:00.000Z'
  });
  const app = payrollFixture({ initialDossier: completed });
  const browser = await app.browser();

  await browser.clickButton('工资');
  await browser.clickButton('查看工资档案');
  const detailText = browser.document.app.textContent;
  assert.match(detailText, /员工已确认/);
  assert.match(detailText, /员工反馈：已确认收到工资 · 2026-07-29 11:00/);
  assert.match(detailText, /员工确认收到工资/);
  assert.match(detailText, /银行卡 · 2026-07-16 12:55/);
  assert.match(detailText, /USDT · 2026-07-16 12:56/);
  assert.doesNotMatch(detailText, /employee_confirmed|confirm_payroll_receipt/);
});

test('a confirmed payroll never renews a residual owned claim', async () => {
  const completed = payrollDossier();
  completed.payroll.status = 'confirmed';
  completed.payroll.claim = {
    claimed_by: 'ADMIN-1',
    claimed_at: '2026-07-29T01:45:00.000Z',
    lease_expires_at: '2026-07-29T02:04:00.000Z',
    active: true
  };
  const app = payrollFixture({
    initialDossier: completed,
    pathname: '/manage/tasks/payroll/PAYROLL-1',
    search: '?store=STORE-1',
    now: new Date('2026-07-29T02:00:00.000Z').getTime()
  });
  const browser = await app.browser();
  await browser.advanceTimers(5 * 60 * 1000);

  assert.equal(app.requests.some((request) => request.method === 'POST'), false);
  assert.match(browser.document.app.textContent, /工资档案/);
});

test('an editable payroll still renews its owned active claim', async () => {
  const editable = payrollDossier({
    claim: {
      claimed_by: 'ADMIN-1',
      claimed_at: '2026-07-29T01:45:00.000Z',
      lease_expires_at: '2026-07-29T02:04:00.000Z',
      active: true
    }
  });
  const app = payrollFixture({
    initialDossier: editable,
    pathname: '/manage/tasks/payroll/PAYROLL-1',
    search: '?store=STORE-1',
    now: new Date('2026-07-29T02:00:00.000Z').getTime()
  });
  const browser = await app.browser();
  await browser.advanceTimers(4 * 60 * 1000);

  assert.equal(app.requests.filter((request) =>
    request.path === '/api/manage/tasks/payroll/PAYROLL-1/renew'
    && request.method === 'POST'
  ).length, 1);
});

test('a direct payroll dossier still opens when the pending task list is unavailable', async () => {
  const completed = payrollDossier();
  completed.payroll.status = 'confirmed';
  completed.payroll.claim = null;
  const app = payrollFixture({
    initialDossier: completed,
    pathname: '/manage/tasks/payroll/PAYROLL-1',
    search: '?store=STORE-1',
    tasksStatus: 503
  });
  const browser = await app.browser();

  assert.match(browser.document.app.textContent, /工资档案/);
  assert.match(browser.document.getElementById('app-message').textContent, /待办列表暂时无法加载/);
});

test('a payroll deep link rejects a dossier with mismatched store or id', async (context) => {
  for (const [name, field, value] of [
    ['store', 'store_id', 'STORE-2'],
    ['id', 'payroll_id', 'PAYROLL-2']
  ]) {
    await context.test(name, async () => {
      const mismatched = payrollDossier();
      mismatched.payroll[field] = value;
      const app = payrollFixture({
        initialDossier: mismatched,
        pathname: '/manage/tasks/payroll/PAYROLL-1',
        search: '?store=STORE-1'
      });
      const browser = await app.browser();

      assert.match(browser.document.app.textContent, /工资记录不存在或无权查看/);
      assert.doesNotMatch(browser.document.app.textContent, /工资档案/);
    });
  }
});

test('payroll deep-link identity rejects a delimiter collision without adoption', async () => {
  const collision = payrollDossier();
  collision.payroll.store_id = 'A:B';
  collision.payroll.payroll_id = 'C';
  const requests = [];
  const browser = await executeManageClient(MANAGE_CLIENT, {
    pathname: '/manage/tasks/payroll/B%3AC',
    search: '?store=A',
    async fetch(path, options = {}) {
      requests.push({ path, method: options.method || 'GET' });
      if (path === '/api/admin/me') return json({ ok: true });
      if (path === '/api/manage/session') {
        return json({ telegram_id: 'ADMIN-1', csrf_token: 'CSRF-1' });
      }
      if (path === '/api/manage/stores') {
        return json({ stores: [{ store_id: 'A', name: 'Expected Store' }] });
      }
      if (path === '/api/manage/tasks?') return json({ tasks: [] });
      if (path === '/api/manage/stores/A/payroll/B%3AC') return json(collision);
      return json({ ok: false, error: 'not_found' }, 404);
    }
  });

  assert.ok(requests.some((request) => request.path === '/api/manage/stores/A/payroll/B%3AC'));
  assert.match(browser.document.app.textContent, /工资记录不存在或无权查看/);
  assert.doesNotMatch(browser.document.app.textContent, /工资档案/);
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
  await browser.changeFiles('bank-camera', [jpeg]);
  await browser.changeFiles('usdt-library', [png]);

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

test('dynamic payment validation keeps native and aria disabled states in sync', async () => {
  const owned = {
    claimed_by: 'ADMIN-1',
    claimed_at: '2026-07-29T02:00:00.000Z',
    lease_expires_at: '2099-07-29T02:15:00.000Z',
    active: true
  };
  const dossier = payrollDossier({
    claim: owned,
    draft: true,
    amountMicros: 8_000_000_000,
    draftProofs: [
      {
        proof_id: 'PROOF-BANK', attempt_id: 'ATTEMPT-DRAFT', method: 'bank',
        superseded_at: null
      },
      {
        proof_id: 'PROOF-USDT', attempt_id: 'ATTEMPT-DRAFT', method: 'usdt',
        superseded_at: null
      }
    ]
  });
  const browser = await payrollFixture({ initialDossier: dossier }).browser();
  await browser.clickButton('工资');
  await browser.clickButton('查看工资档案');
  await browser.clickButton('领取并开始付款');

  let save = browser.document.getElementById('save-payment-draft');
  let submit = browser.document.getElementById('submit-payroll-payment');
  assert.equal(save.disabled, true);
  assert.equal(save.getAttribute('aria-disabled'), 'true');
  assert.equal(submit.disabled, true);
  assert.equal(submit.getAttribute('aria-disabled'), 'true');

  await browser.input('bank-amount', '5000');
  await browser.input('usdt-amount', '3000');
  await browser.input('cash-amount', '0');
  save = browser.document.getElementById('save-payment-draft');
  submit = browser.document.getElementById('submit-payroll-payment');
  assert.equal(save.disabled, false);
  assert.equal(save.getAttribute('aria-disabled'), 'false');
  assert.equal(submit.disabled, false);
  assert.equal(submit.getAttribute('aria-disabled'), 'false');

  await browser.setOnline(false);
  save = browser.document.getElementById('save-payment-draft');
  submit = browser.document.getElementById('submit-payroll-payment');
  assert.equal(save.disabled, true);
  assert.equal(save.getAttribute('aria-disabled'), 'true');
  assert.equal(submit.disabled, true);
  assert.equal(submit.getAttribute('aria-disabled'), 'true');
});

test('starting an already-owned payroll renews its claim before editing', async () => {
  const app = payrollFixture({
    initialDossier: payrollDossier({
      claim: {
        claimed_by: 'ADMIN-1',
        claimed_at: '2026-07-29T02:00:00.000Z',
        lease_expires_at: '2026-07-29T02:15:00.000Z',
        active: true
      }
    })
  });
  const browser = await app.browser();
  await browser.clickButton('工资');
  await browser.clickButton('查看工资档案');
  await browser.clickButton('领取并开始付款');

  assert.equal(
    app.requests.filter((request) => request.path.endsWith('/payroll/PAYROLL-1/claim')).length,
    1
  );
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
  await browser.changeFiles('bank-library', [first, second]);
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
  await baseBrowser.changeFiles('bank-camera', [proof]);
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
  assert.equal(browser.document.getElementById('bank-amount').disabled, true);
  assert.equal(browser.document.getElementById('bank-camera').disabled, true);
  assert.equal(browser.document.getElementById('bank-library').disabled, true);
  assert.equal(browser.document.getElementById('save-payment-draft').disabled, true);
  assert.equal(browser.document.getElementById('submit-payroll-payment').disabled, true);
  const mutationCount = app.requests.filter((request) => request.method !== 'GET').length;
  await browser.call('savePaymentDraft');
  await browser.call('submitPayrollPayment');
  await browser.changeFiles('bank-library', [
    new File([new Uint8Array([1])], 'offline.jpg', { type: 'image/jpeg' })
  ]);
  assert.equal(
    app.requests.filter((request) => request.method !== 'GET').length,
    mutationCount
  );
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
  await browser.changeFiles('bank-camera', [proof]);

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

  assert.match(browser.document.app.textContent, /付款任务认领已过期/);
  assert.equal(browser.document.getElementById('bank-amount'), null);
  assert.match(browser.document.app.textContent, /版本 1/);
});

test('payroll submit exposes the server conflict reason after refreshing', async () => {
  const app = payrollFixture({ submitConflict: 'task_claim_required' });
  const browser = await app.browser();
  await browser.clickButton('工资');
  await browser.clickButton('查看工资档案');
  await browser.clickButton('领取并开始付款');
  await browser.input('bank-amount', '100');
  await browser.call('savePaymentDraft');
  const proof = new File([new Uint8Array([1])], 'proof.jpg', { type: 'image/jpeg' });
  await browser.changeFiles('bank-camera', [proof]);
  await browser.clickButton('提交付款并通知员工');

  assert.match(browser.document.app.textContent, /付款任务认领已过期/);
  assert.equal(browser.document.getElementById('bank-amount'), null);
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
  const upload = browser.changeFiles('bank-library', [proof]);
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

test('reconnecting a payroll page stays read-only until authoritative state is refreshed', async () => {
  const app = payrollFixture();
  const browser = await app.browser();
  await browser.clickButton('工资');
  await browser.clickButton('查看工资档案');
  await browser.clickButton('领取并开始付款');
  await browser.input('bank-amount', '100');
  await browser.setOnline(false);

  const gate = deferred();
  const takeover = payrollDossier({
    claim: {
      claimed_by: 'ADMIN-2', claimed_at: '2026-07-29T02:05:00.000Z',
      lease_expires_at: '2099-07-29T02:20:00.000Z', active: true
    },
    draft: true
  });
  app.setDossier(takeover);
  app.gateNextDossier(gate);
  await browser.setOnline(true);

  assert.equal(browser.document.getElementById('save-payment-draft').disabled, true);
  assert.match(browser.document.app.textContent, /正在刷新最新工资状态/);

  gate.resolve(json(takeover));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(browser.document.getElementById('claim-status').textContent, /ADMIN-2/);
  assert.equal(browser.document.getElementById('bank-amount'), null);
  assert.ok(app.requests.filter((request) => request.path === '/api/manage/session').length >= 2);
  assert.ok(app.requests.filter((request) => request.path === '/api/manage/stores').length >= 2);
});

test('failed reconnect refresh keeps the cached payroll dossier locked', async () => {
  const app = payrollFixture();
  const browser = await app.browser();
  await browser.clickButton('工资');
  await browser.clickButton('查看工资档案');
  await browser.clickButton('领取并开始付款');
  await browser.setOnline(false);
  const gate = deferred();
  app.gateNextDossier(gate);
  await browser.setOnline(true);
  gate.resolve(json({ error: 'unavailable' }, 503));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(browser.document.getElementById('save-payment-draft').disabled, true);
  assert.match(browser.document.app.textContent, /刷新失败.*只读/);
});

test('failed proof state from payment v1 is cleared when authority moves to v2', async () => {
  const app = payrollFixture({ uploadFailureAt: 1 });
  const browser = await app.browser();
  await browser.clickButton('工资');
  await browser.clickButton('查看工资档案');
  await browser.clickButton('领取并开始付款');
  await browser.input('bank-amount', '100');
  const failed = new File([new Uint8Array([1])], 'v1-failed.jpg', { type: 'image/jpeg' });
  await browser.changeFiles('bank-library', [failed]);
  assert.match(browser.document.app.textContent, /v1-failed.jpg.*上传失败/s);

  const v2 = payrollDossier({
    claim: {
      claimed_by: 'ADMIN-1', claimed_at: '2026-07-29T02:05:00.000Z',
      lease_expires_at: '2099-07-29T02:20:00.000Z', active: true
    },
    draft: true,
    draftId: 'ATTEMPT-DRAFT-2'
  });
  app.setDossier(v2);
  await browser.setOnline(false);
  await browser.setOnline(true);

  assert.doesNotMatch(browser.document.app.textContent, /v1-failed.jpg/);
  assert.equal(browser.document.buttons.some((button) => /重试 v1-failed/.test(button.textContent)), false);
  assert.equal(browser.objectUrls.size, 0);
});

test('an unknown submit result reuses one key only for the same payment attempt', async () => {
  const app = payrollFixture({ submitFailures: 2 });
  const browser = await app.browser();
  await browser.clickButton('工资');
  await browser.clickButton('查看工资档案');
  await browser.clickButton('领取并开始付款');
  await browser.input('bank-amount', '100');
  const proof = new File([new Uint8Array([1])], 'v1.jpg', { type: 'image/jpeg' });
  await browser.changeFiles('bank-camera', [proof]);
  await browser.clickButton('提交付款并通知员工');
  const first = app.requests.filter((request) => request.path.endsWith('/submit')).at(-1);
  assert.ok(browser.document.getElementById('submit-payroll-payment'));
  await browser.clickButton('提交付款并通知员工');
  const sameAttempt = app.requests.filter((request) => request.path.endsWith('/submit')).at(-1);
  assert.equal(sameAttempt.headers['Idempotency-Key'], first.headers['Idempotency-Key']);

  const owned = {
    claimed_by: 'ADMIN-1', claimed_at: '2026-07-29T02:05:00.000Z',
    lease_expires_at: '2099-07-29T02:20:00.000Z', active: true
  };
  const v2 = payrollDossier({ claim: owned, draft: true, draftId: 'ATTEMPT-DRAFT-2' });
  Object.assign(v2.attempts[0], {
    bank_micros: 100_000_000,
    proofs: [{
      proof_id: 'PROOF-V2', attempt_id: 'ATTEMPT-DRAFT-2', method: 'bank',
      mime_type: 'image/jpeg', uploaded_at: '2026-07-29T03:00:00.000Z',
      url: '/api/manage/stores/STORE-1/payroll/proofs/PROOF-V2'
    }]
  });
  app.setDossier(v2);
  await browser.setOnline(false);
  await browser.setOnline(true);
  await browser.clickButton('领取并开始付款');
  await browser.clickButton('提交付款并通知员工');
  const newAttempt = app.requests.filter((request) => request.path.endsWith('/submit')).at(-1);
  assert.notEqual(newAttempt.headers['Idempotency-Key'], first.headers['Idempotency-Key']);
});

test('money display preserves every safe integer micro and negative difference exactly', async () => {
  const exact = payrollDossier({ amountMicros: Number.MAX_SAFE_INTEGER });
  const browser = await payrollFixture({ initialDossier: exact }).browser();
  await browser.clickButton('工资');
  assert.match(browser.document.app.textContent, /\$9,007,199,254\.740991/);
  await browser.clickButton('查看工资档案');
  assert.match(browser.document.app.textContent, /\$9,007,199,254\.740991/);

  const normal = await payrollFixture().browser();
  await normal.clickButton('工资');
  await normal.clickButton('查看工资档案');
  await normal.clickButton('领取并开始付款');
  await normal.input('bank-amount', '100.000001');
  assert.equal(normal.document.getElementById('payment-difference').textContent, '$-0.000001');
});

test('photo library starts every selected upload without waiting for an earlier file', async () => {
  const firstGate = deferred();
  const app = payrollFixture({ uploadGates: new Map([['first.jpg', firstGate]]) });
  const browser = await app.browser();
  await browser.clickButton('工资');
  await browser.clickButton('查看工资档案');
  await browser.clickButton('领取并开始付款');
  await browser.input('bank-amount', '100');
  const first = new File([new Uint8Array([1])], 'first.jpg', { type: 'image/jpeg' });
  const second = new File([new Uint8Array([2])], 'second.jpg', { type: 'image/jpeg' });
  const change = browser.changeFiles('bank-library', [first, second]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.requests.filter((request) => request.path.endsWith('/proofs')).length, 2);
  assert.match(browser.document.app.textContent, /first.jpg.*上传中/s);
  assert.match(browser.document.app.textContent, /second.jpg.*已上传/s);
  assert.equal(browser.document.getElementById('submit-payroll-payment').disabled, true);
  firstGate.resolve(json({ ok: true, proof: {
    proof_id: 'PROOF-FIRST', attempt_id: 'ATTEMPT-DRAFT', method: 'bank',
    file_name: 'first.jpg', mime_type: 'image/jpeg', size_bytes: 1,
    uploaded_by: 'ADMIN-1', uploaded_at: '2026-07-29T02:10:00.000Z'
  } }));
  await change;
  assert.equal(browser.document.getElementById('submit-payroll-payment').disabled, false);
});

test('superseded and wrong-attempt proofs never satisfy the submit gate', async () => {
  const owned = {
    claimed_by: 'ADMIN-1', claimed_at: '2026-07-29T02:00:00.000Z',
    lease_expires_at: '2099-07-29T02:15:00.000Z', active: true
  };
  const dossier = payrollDossier({
    claim: owned,
    draft: true,
    draftProofs: [
      { proof_id: 'SUPERSEDED', attempt_id: 'ATTEMPT-DRAFT', method: 'bank', superseded_at: '2026-07-29T02:01:00.000Z' },
      { proof_id: 'WRONG', attempt_id: 'ATTEMPT-OTHER', method: 'bank', superseded_at: null }
    ]
  });
  dossier.attempts[0].bank_micros = 100_000_000;
  const browser = await payrollFixture({ initialDossier: dossier }).browser();
  await browser.clickButton('工资');
  await browser.clickButton('查看工资档案');
  await browser.clickButton('领取并开始付款');
  assert.equal(browser.document.getElementById('submit-payroll-payment').disabled, true);
});

test('payroll dossier resolves and escapes its authorized store name', async () => {
  const attack = '<img src=x onerror=alert(1)>';
  const browser = await payrollFixture({ storeName: attack }).browser();
  await browser.clickButton('工资');
  await browser.clickButton('查看工资档案');
  assert.match(browser.document.app.textContent, /店铺：&lt;img src=x/);
  assert.doesNotMatch(browser.document.app.innerHTML, /<img src=x/);
  assert.match(browser.document.app.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('editable payroll reconnect requires its exact task while a matching task unlocks it', async () => {
  const app = payrollFixture();
  const browser = await app.browser();
  await browser.clickButton('工资');
  await browser.clickButton('查看工资档案');
  await browser.clickButton('领取并开始付款');
  await browser.input('bank-amount', '100');
  await browser.setOnline(false);
  await browser.setOnline(true);
  assert.equal(browser.document.getElementById('save-payment-draft').disabled, false);
  assert.match(browser.document.app.textContent, /最新工资状态已刷新/);

  app.setManageTasks([]);
  await browser.setOnline(false);
  await browser.setOnline(true);
  assert.equal(browser.document.getElementById('save-payment-draft').disabled, true);
  assert.match(browser.document.app.textContent, /刷新失败.*只读/);

  const terminalDossier = payrollDossier();
  terminalDossier.payroll.status = 'confirmed';
  const terminalApp = payrollFixture({ initialDossier: terminalDossier });
  terminalApp.setManageTasks([]);
  const terminal = await terminalApp.browser();
  await terminal.clickButton('工资');
  await terminal.clickButton('查看工资档案');
  await terminal.setOnline(false);
  await terminal.setOnline(true);
  assert.match(terminal.document.app.textContent, /最新工资状态已刷新/);
  assert.doesNotMatch(terminal.document.app.textContent, /刷新失败/);
});

test('payroll reconnect replaces only the current store payroll tasks', async () => {
  const otherPayroll = {
    task_type: 'payroll', task_id: 'PAYROLL-OTHER', store_id: 'STORE-2',
    store_name: 'Osaka Club', employee_name: 'OtherPayroll', status: 'awaiting_admin_payment',
    amount_micros: 20_000_000, currency: '$', submitted_at: '2026-07-29T01:00:00.000Z',
    urgency: 200, claim: null
  };
  const approval = {
    ...task, task_id: 'INC-OTHER', store_id: 'STORE-2', store_name: 'Osaka Club',
    employee_name: 'IncomeOther'
  };
  const app = payrollFixture({ initialTasks: [otherPayroll, approval] });
  const browser = await app.browser();
  await browser.clickButton('工资');
  await browser.clickButton('查看工资档案');
  await browser.clickButton('领取并开始付款');
  await browser.setOnline(false);
  await browser.setOnline(true);
  await browser.clickButton('待办');

  assert.match(browser.document.app.textContent, /OtherPayroll/);
  assert.match(browser.document.app.textContent, /IncomeOther/);
  assert.match(browser.document.app.textContent, /Alice/);
});

test('draft fallback adoption clears transient state owned by the prior attempt', async () => {
  const owned = {
    claimed_by: 'ADMIN-1', claimed_at: '2026-07-29T02:00:00.000Z',
    lease_expires_at: '2099-07-29T02:15:00.000Z', active: true
  };
  const initial = payrollDossier({ claim: owned, draft: true });
  const app = payrollFixture({ initialDossier: initial, uploadFailureAt: 1 });
  const browser = await app.browser();
  await browser.clickButton('工资');
  await browser.clickButton('查看工资档案');
  await browser.clickButton('领取并开始付款');
  await browser.input('bank-amount', '100');
  const failed = new File([new Uint8Array([1])], 'old-attempt.jpg', { type: 'image/jpeg' });
  await browser.changeFiles('bank-library', [failed]);
  assert.equal(browser.objectUrls.size, 1);
  assert.match(browser.document.app.textContent, /old-attempt.jpg.*上传失败/s);

  app.setDraftFallback({
    attempt_id: 'ATTEMPT-FALLBACK', version: 3, status: 'draft',
    bank_micros: 0, usdt_micros: 0, cash_micros: 0, proofs: []
  });
  await browser.call('startPayrollPayment');
  assert.match(browser.document.app.textContent, /草稿版本 3/);
  assert.doesNotMatch(browser.document.app.textContent, /old-attempt.jpg/);
  assert.equal(browser.objectUrls.size, 0);
});

test('task refresh keeps the server urgency time and stable-id order', async () => {
  const base = {
    ...task,
    store_id: 'STORE-2',
    store_name: 'Osaka Club',
    claim: null
  };
  const initialTasks = [
    { ...base, task_id: 'UNKNOWN-Z', employee_name: 'Unknown-Z', urgency: 'unknown', submitted_at: null },
    { ...base, task_id: 'UNKNOWN-A', employee_name: 'Unknown-A', urgency: undefined, submitted_at: null },
    { ...base, task_id: 'MEDIUM-LATE', employee_name: 'Medium-Late', urgency: 500, submitted_at: '2026-07-29T02:00:00.000Z' },
    { ...base, task_id: 'MEDIUM-EARLY', employee_name: 'Medium-Early', urgency: 500, submitted_at: '2026-07-29T01:00:00.000Z' }
  ];
  const app = payrollFixture({ initialTasks });
  const browser = await app.browser();
  await browser.clickButton('工资');
  await browser.clickButton('查看工资档案');
  await browser.clickButton('领取并开始付款');
  app.setManageTasks([{
    task_type: 'payroll', task_id: 'PAYROLL-1', store_id: 'STORE-1',
    store_name: 'Tokyo Club', employee_name: 'Highest-Payroll',
    status: 'awaiting_admin_payment', urgency: 900,
    submitted_at: '2026-07-29T03:00:00.000Z',
    claim: {
      claimed_by: 'ADMIN-1', claimed_at: '2026-07-29T02:00:00.000Z',
      lease_expires_at: '2099-07-29T02:15:00.000Z', active: true
    }
  }]);
  await browser.setOnline(false);
  await browser.setOnline(true);
  await browser.clickButton('待办');

  const text = browser.document.app.textContent;
  const positions = [
    'Highest-Payroll', 'Medium-Early', 'Medium-Late', 'Unknown-A', 'Unknown-Z'
  ].map((label) => text.indexOf(label));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
});
