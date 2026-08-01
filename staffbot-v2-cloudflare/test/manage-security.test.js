import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import worker from '../src/index.js';
import {
  manageTaskKeyboard,
  manageTaskUrl,
  notifyStoreAdminsOfTask
} from '../src/admin-notifications.js';

function workerContext() {
  return { waitUntil() {} };
}

async function manageAsset(path) {
  return worker.fetch(
    new Request(`https://staffbot.test${path}`),
    { ENVIRONMENT: 'staging' },
    workerContext()
  );
}

async function executeServiceWorker({
  cachedResponse = null,
  cacheNames = [
    'staffbot-manage-shell-v0',
    'staffbot-manage-shell-v1',
    'unrelated-app-cache'
  ],
  installError = null
} = {}) {
  const listeners = new Map();
  const calls = {
    addAll: [],
    cacheMatch: [],
    cacheDelete: [],
    clientsClaim: 0,
    network: [],
    skipWaiting: 0
  };
  const cache = {
    async addAll(urls) {
      calls.addAll.push(Array.from(urls));
      if (installError) throw installError;
    },
    async match(request) {
      calls.cacheMatch.push(request.url || String(request));
      return cachedResponse;
    }
  };
  const self = {
    location: { origin: 'https://staffbot.test' },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    skipWaiting() {
      calls.skipWaiting += 1;
    },
    clients: {
      async claim() {
        calls.clientsClaim += 1;
      }
    }
  };
  const caches = {
    async open() { return cache; },
    async keys() { return Array.from(cacheNames); },
    async delete(name) {
      calls.cacheDelete.push(name);
      return true;
    }
  };
  const networkFetch = async (request) => {
    calls.network.push({ method: request.method, url: request.url });
    return new Response(`network:${request.method}:${request.url}`);
  };
  const response = await manageAsset('/manage/sw.js');
  vm.runInNewContext(await response.text(), {
    self,
    caches,
    fetch: networkFetch,
    Request,
    Response,
    URL,
    Promise
  }, { filename: '/manage/sw.js' });

  return {
    calls,
    async dispatch(type, request) {
      let lifetime;
      let responsePromise;
      const event = {
        request,
        waitUntil(promise) { lifetime = Promise.resolve(promise); },
        respondWith(promise) { responsePromise = Promise.resolve(promise); }
      };
      listeners.get(type)(event);
      return {
        lifetime,
        response: responsePromise ? await responsePromise : null
      };
    }
  };
}

const task = {
  task_type: 'payroll',
  task_id: 'PAYROLL-1',
  store_id: 'STORE-1'
};

test('manage manifest is parseable and contains complete install metadata', async () => {
  const response = await manageAsset('/manage/manifest.webmanifest');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/manifest+json; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  assert.match(response.headers.get('content-security-policy'), /manifest-src 'self'/);

  const manifest = await response.json();
  assert.equal(manifest.name, 'StaffBot 管理端');
  assert.equal(manifest.short_name, 'StaffBot');
  assert.equal(manifest.start_url, '/manage/');
  assert.equal(manifest.scope, '/manage/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.theme_color, '#111827');
  assert.deepEqual(manifest.icons, [{
    src: '/manage/icon.svg',
    sizes: 'any',
    type: 'image/svg+xml',
    purpose: 'any maskable'
  }]);
});

test('manage service worker installs exactly the fixed shell and removes old caches on activate', async () => {
  const serviceWorker = await executeServiceWorker();
  const install = await serviceWorker.dispatch('install');
  await install.lifetime;
  assert.deepEqual(serviceWorker.calls.addAll, [[
    '/manage/',
    '/manage/app.js',
    '/manage/styles.css',
    '/manage/manifest.webmanifest',
    '/manage/icon.svg'
  ]]);
  assert.equal(serviceWorker.calls.skipWaiting, 1);

  const activate = await serviceWorker.dispatch('activate');
  await activate.lifetime;
  assert.deepEqual(serviceWorker.calls.cacheDelete, ['staffbot-manage-shell-v0']);
  assert.equal(serviceWorker.calls.clientsClaim, 1);
});

test('manage launch URL is routable inside the default service-worker scope', async () => {
  const redirect = await manageAsset('/manage');
  assert.equal(redirect.status, 308);
  assert.equal(new URL(redirect.headers.get('location')).pathname, '/manage/');

  const launch = await manageAsset('/manage/');
  assert.equal(launch.status, 200);
  assert.equal(launch.headers.get('content-type'), 'text/html; charset=utf-8');

  const manifest = await (await manageAsset('/manage/manifest.webmanifest')).json();
  const defaultScope = new URL('./', 'https://staffbot.test/manage/sw.js').pathname;
  assert.equal(defaultScope, '/manage/');
  assert.ok(manifest.start_url.startsWith(defaultScope));
  assert.equal(manifest.start_url, defaultScope);
});

test('manage service worker is cache-first only for exact same-origin shell GET requests', async () => {
  const cached = new Response('cached-shell');
  const serviceWorker = await executeServiceWorker({ cachedResponse: cached });

  const shell = await serviceWorker.dispatch(
    'fetch',
    new Request('https://staffbot.test/manage/app.js')
  );
  assert.equal(await shell.response.text(), 'cached-shell');
  assert.deepEqual(serviceWorker.calls.cacheMatch, ['https://staffbot.test/manage/app.js']);
  assert.deepEqual(serviceWorker.calls.network, []);

  for (const request of [
    new Request('https://staffbot.test/api/manage/tasks?store_id=STORE-1'),
    new Request('https://staffbot.test/api/manage/stores/STORE-1/payroll/proofs/PROOF-1'),
    new Request('https://staffbot.test/manage/app.js?stale=1'),
    new Request('https://files.example.test/manage/app.js'),
    new Request('https://staffbot.test/manage', { method: 'POST' })
  ]) {
    const result = await serviceWorker.dispatch('fetch', request);
    assert.match(await result.response.text(), /^network:/);
  }
  assert.equal(serviceWorker.calls.cacheMatch.length, 1);
  assert.deepEqual(
    serviceWorker.calls.network.map(({ method, url }) => [method, url]),
    [
      ['GET', 'https://staffbot.test/api/manage/tasks?store_id=STORE-1'],
      ['GET', 'https://staffbot.test/api/manage/stores/STORE-1/payroll/proofs/PROOF-1'],
      ['GET', 'https://staffbot.test/manage/app.js?stale=1'],
      ['GET', 'https://files.example.test/manage/app.js'],
      ['POST', 'https://staffbot.test/manage']
    ]
  );
});

test('manage service worker install fails when the complete shell cannot be cached', async () => {
  const serviceWorker = await executeServiceWorker({
    installError: new Error('shell_cache_failed')
  });
  const install = await serviceWorker.dispatch('install');
  await assert.rejects(install.lifetime, /shell_cache_failed/);
  assert.equal(serviceWorker.calls.skipWaiting, 0);
});

test('builds an encoded task URL only from a strict HTTPS manage origin', () => {
  assert.equal(
    manageTaskUrl({
      MANAGE_BASE_URL: 'https://staffbot-v2-staging.staffbot-v2.workers.dev'
    }, task),
    'https://staffbot-v2-staging.staffbot-v2.workers.dev/manage/tasks/payroll/PAYROLL-1?store=STORE-1'
  );
  assert.equal(
    manageTaskUrl({ MANAGE_BASE_URL: 'https://manage.example.test' }, {
      task_type: 'income',
      task_id: 'INC /?&:#',
      store_id: 'STORE /?&:#'
    }),
    'https://manage.example.test/manage/tasks/income/INC%20%2F%3F%26%3A%23?store=STORE+%2F%3F%26%3A%23'
  );

  for (const base of [
    '',
    'http://manage.example.test',
    'https://user:password@manage.example.test',
    'https://manage.example.test?next=https://evil.example',
    'https://manage.example.test#fragment',
    'https://manage.example.test/ambiguous/path',
    '//manage.example.test',
    'not-a-url'
  ]) {
    assert.throws(
      () => manageTaskUrl({ MANAGE_BASE_URL: base }, task),
      /MANAGE_BASE_URL/
    );
  }
});

test('accepts only server task types and ignores redirect-shaped extra fields', () => {
  for (const taskType of ['income', 'leave', 'absence', 'advance', 'payroll']) {
    const keyboard = manageTaskKeyboard({
      MANAGE_BASE_URL: 'https://manage.example.test'
    }, {
      task_type: taskType,
      task_id: `${taskType}-1`,
      store_id: 'STORE-1',
      url: 'https://evil.example',
      redirect: '//evil.example'
    });
    assert.deepEqual(keyboard, {
      inline_keyboard: [[{
        text: '去处理',
        url: `https://manage.example.test/manage/tasks/${taskType}/${taskType}-1?store=STORE-1`
      }]]
    });
  }

  for (const taskType of ['', 'registration', 'checkout', '../admin', 'payroll?next=evil']) {
    assert.throws(
      () => manageTaskUrl({ MANAGE_BASE_URL: 'https://manage.example.test' }, {
        ...task,
        task_type: taskType
      }),
      /task type/
    );
  }
});

test('missing manage origin fails before querying recipients or sending Telegram messages', async () => {
  let queried = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('Telegram must not be called');
  };
  try {
    await assert.rejects(
      notifyStoreAdminsOfTask({
        DB: {
          prepare() {
            queried = true;
            throw new Error('database must not be queried');
          }
        }
      }, 'STORE-1', task, '工资待付款'),
      /MANAGE_BASE_URL/
    );
    assert.equal(queried, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('notifies only active store admins plus global admins and isolates each delivery failure', async () => {
  const telegramPayloads = [];
  const logRows = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    telegramPayloads.push(payload);
    if (String(payload.chat_id) === '500') {
      throw new Error('PRIVATE TELEGRAM TRANSPORT DETAIL');
    }
    return { json: async () => ({ ok: true }) };
  };
  const env = {
    MANAGE_BASE_URL: 'https://manage.example.test',
    ENVIRONMENT: 'staging',
    TELEGRAM_RECIPIENT_MODE: 'allowlist',
    STAGING_ALLOWED_TELEGRAM_IDS: '100,500',
    ADMIN_IDS: '500,600',
    BOT_TOKEN: 'PRIVATE-BOT-TOKEN',
    DB: {
      prepare(sql) {
        return {
          bind(...params) {
            if (/SELECT telegram_id FROM store_members/.test(sql)) {
              assert.deepEqual(params, ['STORE-1']);
              return {
                async all() {
                  return {
                    results: [
                      { telegram_id: '100' },
                      { telegram_id: '200' }
                    ]
                  };
                }
              };
            }
            return {
              async run() {
                logRows.push(params);
                return { success: true, meta: { changes: 1 } };
              }
            };
          }
        };
      }
    }
  };

  try {
    const result = await notifyStoreAdminsOfTask(
      env,
      'STORE-1',
      task,
      '工资待付款\n工资 ID：PAYROLL-1'
    );
    assert.deepEqual(result, { attempted: 4, sent: 1, failed: 3 });
    assert.deepEqual(
      telegramPayloads.map((payload) => String(payload.chat_id)),
      ['100', '500']
    );
    assert.ok(telegramPayloads.every((payload) =>
      payload.reply_markup.inline_keyboard[0][0].text === '去处理'
    ));
    assert.ok(logRows.length >= 3);
    assert.doesNotMatch(JSON.stringify(logRows), /PRIVATE-BOT-TOKEN|PRIVATE TELEGRAM TRANSPORT DETAIL/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
