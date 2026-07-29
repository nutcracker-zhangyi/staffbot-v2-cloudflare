import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { handleUpdate as facadeHandleUpdate } from '../src/index.js';
import { handleUpdate } from '../src/telegram.js';
import { createD1 } from './helpers/d1.js';

const schema = readFileSync(
  new URL('../db/schema.sql', import.meta.url),
  'utf8'
);

const mainKeyboard = {
  keyboard: [
    [{ text: '切换店铺' }],
    [{ text: '提交收入' }, { text: '总收入' }],
    [{ text: '申请工资' }, { text: '预支薪资' }],
    [{ text: '打卡' }, { text: '请假' }]
  ],
  resize_keyboard: true,
  is_persistent: true
};

const welcomeText = [
  '欢迎使用员工管理机器人。请选择操作：',
  '',
  '可用命令：',
  '/store - 切换店铺',
  '/income - 提交收入',
  '/total - 查看总收入',
  '/salary - 申请工资',
  '/advance - 预支薪资',
  '/attendance - 打卡',
  '/leave - 请假',
  '/lang - 切换语言',
  '/cancel - 取消当前流程',
  '/ping - 测试机器人'
].join('\n');

function flowFixture() {
  const database = new DatabaseSync(':memory:');
  database.exec(schema);
  database.exec(`
    INSERT INTO stores (store_id, name, currency, created_at, updated_at)
    VALUES ('STORE1', 'Tokyo Club', '$', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
    INSERT INTO store_members (
      store_id, telegram_id, display_name, role, status, commission_rate,
      cycle_start, joined_at, absence_check_enabled, absence_check_enabled_at, updated_at
    ) VALUES (
      'STORE1', '1001', 'Alice', 'employee', 'active', 0.6,
      '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z',
      1, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
    );
    INSERT INTO user_preferences (telegram_id, language, current_store_id, updated_at)
    VALUES ('1001', 'zh', 'STORE1', '2026-07-01T00:00:00.000Z');
    INSERT INTO income_records (
      record_id, store_id, telegram_id, income, commission_rate,
      commission_income, original_fine, fine, type, source,
      request_id, approved_at, admin_id
    ) VALUES (
      'REC1', 'STORE1', '1001', 100, 0.6,
      60, 5, 5, 'income', 'manual',
      'INC1', '2026-07-02T00:00:00.000Z', 'ADMIN1'
    );
  `);

  const payloads = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return { json: async () => ({ ok: true }) };
  };

  return {
    database,
    env: {
      DB: createD1(database),
      BOT_TOKEN: 'test-token',
      ENVIRONMENT: 'production',
      ADMIN_IDS: '9001'
    },
    payloads,
    restore() {
      globalThis.fetch = originalFetch;
      database.close();
    }
  };
}

async function sendText(env, text, user = {
  id: 1001,
  first_name: 'Alice',
  username: 'alice'
}) {
  return handleUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: user.id, type: 'private' },
      from: user,
      text
    }
  }, env);
}

async function sendCallback(env, data, userId, text = 'callback message') {
  return handleUpdate({
    update_id: 2,
    callback_query: {
      id: `callback-${userId}`,
      from: { id: userId },
      data,
      message: {
        message_id: 2,
        chat: { id: userId, type: 'private' },
        text
      }
    }
  }, env);
}

test('keeps the Telegram workflow available through the Worker facade', () => {
  assert.equal(facadeHandleUpdate, handleUpdate);
});

test('/ping sends the existing timestamped pong message', async () => {
  const fixture = flowFixture();
  try {
    await sendText(fixture.env, '/ping');

    assert.equal(fixture.payloads.length, 1);
    assert.equal(fixture.payloads[0].chat_id, '1001');
    assert.match(fixture.payloads[0].text, /^pong \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(fixture.payloads[0].reply_markup, undefined);
  } finally {
    fixture.restore();
  }
});

test('/start for an active employee sends the existing welcome menu', async () => {
  const fixture = flowFixture();
  try {
    await sendText(fixture.env, '/start');

    assert.deepEqual(fixture.payloads, [{
      chat_id: '1001',
      text: welcomeText,
      reply_markup: mainKeyboard
    }]);
  } finally {
    fixture.restore();
  }
});

test('/total sends the current store and payroll total', async () => {
  const fixture = flowFixture();
  try {
    await sendText(fixture.env, '/total');

    assert.deepEqual(fixture.payloads, [{
      chat_id: '1001',
      text: '店铺：Tokyo Club\n当前总收入：$55.00',
      reply_markup: mainKeyboard
    }]);
  } finally {
    fixture.restore();
  }
});

test('/cancel clears the current state and sends the existing menu', async () => {
  const fixture = flowFixture();
  try {
    fixture.database.prepare(`
      INSERT INTO user_states (telegram_id, state, data_json, updated_at)
      VALUES ('1001', 'WAIT_INCOME_AMOUNT', '{"store_id":"STORE1"}', '2026-07-01T00:00:00.000Z')
    `).run();

    await sendText(fixture.env, '/cancel');

    assert.equal(
      fixture.database.prepare(`SELECT state FROM user_states WHERE telegram_id = '1001'`).get(),
      undefined
    );
    assert.deepEqual(fixture.payloads, [{
      chat_id: '1001',
      text: '已取消当前流程。',
      reply_markup: mainKeyboard
    }]);
  } finally {
    fixture.restore();
  }
});

test('an unknown command sends the existing unknown-command menu', async () => {
  const fixture = flowFixture();
  try {
    await sendText(fixture.env, '/not-a-command');

    assert.deepEqual(fixture.payloads, [{
      chat_id: '1001',
      text: '无法识别。发送 /start 查看可用命令。',
      reply_markup: mainKeyboard
    }]);
  } finally {
    fixture.restore();
  }
});

test('registers a new employee only after choosing the first work date', async () => {
  const fixture = flowFixture();
  const employee = {
    id: 2002,
    first_name: 'Bob',
    username: 'bob'
  };
  try {
    await sendText(fixture.env, '/start', employee);
    await sendCallback(fixture.env, 'reg:store:STORE1', employee.id);
    await sendText(fixture.env, 'Bob Employee', employee);

    assert.equal(
      fixture.database.prepare(`
        SELECT 1 FROM store_members
        WHERE store_id = 'STORE1' AND telegram_id = '2002'
      `).get(),
      undefined
    );
    assert.deepEqual(
      {
        ...fixture.database.prepare(`
          SELECT state, data_json FROM user_states
          WHERE telegram_id = '2002'
        `).get()
      },
      {
        state: 'WAIT_REGISTER_PAYROLL_DATE',
        data_json: '{"store_id":"STORE1","display_name":"Bob Employee"}'
      }
    );

    const datePrompt = fixture.payloads.at(-1);
    assert.match(datePrompt.text, /第一天工作日期/);
    const dateButtons = datePrompt.reply_markup.inline_keyboard.flat();
    assert.equal(dateButtons.length, 6);
    assert.ok(dateButtons.every((button) =>
      /^reg:paydate:STORE1:\d{4}-\d{2}-\d{2}$/.test(button.callback_data)
    ));

    const selectedDate = dateButtons[0].callback_data.split(':')[3];
    await sendCallback(
      fixture.env,
      dateButtons[0].callback_data,
      employee.id,
      datePrompt.text
    );

    const pendingMember = fixture.database.prepare(`
      SELECT
        display_name,
        status,
        cycle_start,
        payroll_start_date,
        payroll_automation_started_at
      FROM store_members
      WHERE store_id = 'STORE1' AND telegram_id = '2002'
    `).get();
    assert.equal(pendingMember.display_name, 'Bob Employee');
    assert.equal(pendingMember.status, 'pending');
    assert.equal(pendingMember.payroll_start_date, selectedDate);
    assert.equal(
      pendingMember.cycle_start,
      pendingMember.payroll_automation_started_at
    );
    assert.equal(
      fixture.database.prepare(`
        SELECT 1 FROM user_states WHERE telegram_id = '2002'
      `).get(),
      undefined
    );
    assert.ok(fixture.payloads.some((payload) =>
      payload.chat_id === '9001'
      && payload.text.includes(`第一工作日期：${selectedDate}`)
    ));

    await sendCallback(
      fixture.env,
      'reg:approve:STORE1:2002',
      9001,
      'new employee request'
    );
    assert.deepEqual(
      {
        ...fixture.database.prepare(`
          SELECT
            status,
            cycle_start,
            payroll_start_date,
            payroll_automation_started_at
          FROM store_members
          WHERE store_id = 'STORE1' AND telegram_id = '2002'
        `).get()
      },
      {
        status: 'active',
        cycle_start: pendingMember.cycle_start,
        payroll_start_date: selectedDate,
        payroll_automation_started_at:
          pendingMember.payroll_automation_started_at
      }
    );
  } finally {
    fixture.restore();
  }
});

test('rejects a tampered first work date callback', async () => {
  const fixture = flowFixture();
  const employee = {
    id: 2003,
    first_name: 'Cara',
    username: 'cara'
  };
  try {
    await sendText(fixture.env, '/start', employee);
    await sendCallback(fixture.env, 'reg:store:STORE1', employee.id);
    await sendText(fixture.env, 'Cara Employee', employee);
    await sendCallback(
      fixture.env,
      'reg:paydate:STORE1:2000-01-01',
      employee.id
    );

    assert.equal(
      fixture.database.prepare(`
        SELECT 1 FROM store_members
        WHERE store_id = 'STORE1' AND telegram_id = '2003'
      `).get(),
      undefined
    );
    assert.equal(
      fixture.database.prepare(`
        SELECT state FROM user_states WHERE telegram_id = '2003'
      `).get().state,
      'WAIT_REGISTER_PAYROLL_DATE'
    );
    assert.equal(fixture.payloads.at(-1).show_alert, true);
  } finally {
    fixture.restore();
  }
});
