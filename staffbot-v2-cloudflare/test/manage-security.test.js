import test from 'node:test';
import assert from 'node:assert/strict';

import {
  manageTaskKeyboard,
  manageTaskUrl,
  notifyStoreAdminsOfTask
} from '../src/admin-notifications.js';

const task = {
  task_type: 'payroll',
  task_id: 'PAYROLL-1',
  store_id: 'STORE-1'
};

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
