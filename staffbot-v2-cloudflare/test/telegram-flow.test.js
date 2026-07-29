import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { handleUpdate as facadeHandleUpdate } from '../src/index.js';
import { usdtDetailModeKeyboard } from '../src/payroll-payments.js';
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
    [{ text: '预支薪资' }],
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
  '/advance - 预支薪资',
  '/attendance - 打卡',
  '/leave - 请假',
  '/lang - 切换语言',
  '/cancel - 取消当前流程',
  '/ping - 测试机器人'
].join('\n');

function flowFixture(fixtureOptions = {}) {
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
  const proofObjects = new Map();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/file/bot')) {
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'image/jpeg' }
      });
    }
    const payload = JSON.parse(options.body);
    payloads.push(payload);
    if (String(url).endsWith('/getFile')) {
      return {
        json: async () => ({
          ok: true,
          result: { file_path: `proofs/${payload.file_id}.jpg` }
        })
      };
    }
    if (fixtureOptions.failQrDelivery
      && String(url).endsWith('/sendPhoto')) {
      return {
        json: async () => ({
          ok: false,
          error_code: 500,
          description: 'test QR delivery failure'
        })
      };
    }
    return { json: async () => ({ ok: true }) };
  };

  return {
    database,
    env: {
      DB: createD1(database),
      BOT_TOKEN: 'test-token',
      ENVIRONMENT: 'production',
      ADMIN_IDS: '9001',
      PAYROLL_FINANCE_EMAIL: 'finance@example.test',
      PAYROLL_PROOFS: {
        async head(key) {
          return proofObjects.has(key) ? {} : null;
        },
        async put(key, value) {
          proofObjects.set(key, value);
          return {};
        },
        async delete(key) {
          proofObjects.delete(key);
        }
      }
    },
    payloads,
    proofObjects,
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

async function sendPhoto(env, fileId, user = {
  id: 9001,
  first_name: 'Admin',
  username: 'admin'
}) {
  return handleUpdate({
    update_id: 3,
    message: {
      message_id: 3,
      chat: { id: user.id, type: 'private' },
      from: user,
      photo: [{
        file_id: fileId,
        file_size: 3,
        width: 100,
        height: 100
      }]
    }
  }, env);
}

function insertFlowPayroll(
  database,
  payrollId,
  amountMicros = 60_000_000
) {
  database.prepare(`
    INSERT INTO payroll_disbursements (
      payroll_id, store_id, telegram_id, payroll_start_date,
      scheduled_date, cycle_day, period_start, cutoff_at,
      amount_snapshot_micros, currency, status,
      created_at, updated_at
    ) VALUES (
      ?, 'STORE1', '1001', '2026-07-01',
      '2026-07-16', 16,
      '2026-07-01T00:00:00.000Z',
      '2026-07-16T03:00:00.000Z',
      ?, '$', 'awaiting_employee_details',
      '2026-07-16T03:00:00.000Z',
      '2026-07-16T03:00:00.000Z'
    )
  `).run(payrollId, amountMicros);
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

test('/salary explains automatic payroll and creates no legacy request', async () => {
  const fixture = flowFixture();
  try {
    await sendText(fixture.env, '/salary');
    await sendCallback(
      fixture.env,
      'salary:confirm:STORE1',
      1001
    );

    assert.equal(
      fixture.database.prepare(`
        SELECT COUNT(*) AS count FROM salary_requests
      `).get().count,
      0
    );
    assert.ok(fixture.payloads.some((payload) =>
      payload.text
      && payload.text.includes('系统会按照你的个人工资周期自动结算')
    ));
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

test('collects payroll methods with buttons and asks only for selected account text', async () => {
  const fixture = flowFixture();
  try {
    fixture.database.prepare(`
      INSERT INTO payroll_disbursements (
        payroll_id, store_id, telegram_id, payroll_start_date,
        scheduled_date, cycle_day, period_start, cutoff_at,
        amount_snapshot_micros, currency, status,
        created_at, updated_at
      ) VALUES (
        'PAYROLL-TEST', 'STORE1', '1001', '2026-07-01',
        '2026-07-16', 16,
        '2026-07-01T00:00:00.000Z',
        '2026-07-16T03:00:00.000Z',
        60000000, '$', 'awaiting_employee_details',
        '2026-07-16T03:00:00.000Z',
        '2026-07-16T03:00:00.000Z'
      )
    `).run();

    await sendCallback(
      fixture.env,
      'pay:d:PAYROLL-TEST',
      1001
    );
    assert.equal(
      fixture.database.prepare(`
        SELECT state FROM user_states WHERE telegram_id = '1001'
      `).get().state,
      'WAIT_PAYROLL_METHODS'
    );
    const methodPrompt = fixture.payloads.at(-1);
    assert.match(methodPrompt.text, /收款方式/);
    assert.equal(
      methodPrompt.reply_markup.inline_keyboard.flat().length,
      4
    );

    await sendCallback(
      fixture.env,
      'pay:m:b:PAYROLL-TEST',
      1001,
      methodPrompt.text
    );
    await sendCallback(
      fixture.env,
      'pay:m:c:PAYROLL-TEST',
      1001,
      methodPrompt.text
    );
    await sendCallback(
      fixture.env,
      'pay:c:PAYROLL-TEST',
      1001,
      methodPrompt.text
    );
    assert.equal(
      fixture.database.prepare(`
        SELECT state FROM user_states WHERE telegram_id = '1001'
      `).get().state,
      'WAIT_PAYROLL_BANK_DETAILS'
    );
    assert.match(fixture.payloads.at(-1).text, /银行卡/);

    await sendText(fixture.env, 'Bank account 12345678');

    assert.equal(
      fixture.database.prepare(`
        SELECT 1 FROM user_states WHERE telegram_id = '1001'
      `).get(),
      undefined
    );
    assert.deepEqual(
      {
        ...fixture.database.prepare(`
          SELECT
            status,
            accepts_bank,
            accepts_usdt,
            accepts_cash,
            bank_details_snapshot,
            usdt_details_snapshot
          FROM payroll_disbursements
          WHERE payroll_id = 'PAYROLL-TEST'
        `).get()
      },
      {
        status: 'awaiting_admin_payment',
        accepts_bank: 1,
        accepts_usdt: 0,
        accepts_cash: 1,
        bank_details_snapshot: 'Bank account 12345678',
        usdt_details_snapshot: null
      }
    );
    assert.ok(fixture.payloads.some((payload) =>
      payload.chat_id === '9001'
      && payload.text.includes('PAYROLL-TEST')
      && payload.text.includes('Bank account 12345678')
    ));
  } finally {
    fixture.restore();
  }
});

test('cash-only payroll details require no free-text answer', async () => {
  const fixture = flowFixture();
  try {
    fixture.database.prepare(`
      INSERT INTO payroll_disbursements (
        payroll_id, store_id, telegram_id, payroll_start_date,
        scheduled_date, cycle_day, period_start, cutoff_at,
        amount_snapshot_micros, currency, status,
        created_at, updated_at
      ) VALUES (
        'PAYROLL-CASH', 'STORE1', '1001', '2026-07-01',
        '2026-07-16', 16,
        '2026-07-01T00:00:00.000Z',
        '2026-07-16T03:00:00.000Z',
        60000000, '$', 'awaiting_employee_details',
        '2026-07-16T03:00:00.000Z',
        '2026-07-16T03:00:00.000Z'
      )
    `).run();

    await sendCallback(fixture.env, 'pay:d:PAYROLL-CASH', 1001);
    await sendCallback(fixture.env, 'pay:m:c:PAYROLL-CASH', 1001);
    await sendCallback(fixture.env, 'pay:c:PAYROLL-CASH', 1001);

    assert.equal(
      fixture.database.prepare(`
        SELECT state FROM user_states WHERE telegram_id = '1001'
      `).get(),
      undefined
    );
    assert.deepEqual(
      {
        ...fixture.database.prepare(`
          SELECT status, accepts_cash
          FROM payroll_disbursements
          WHERE payroll_id = 'PAYROLL-CASH'
        `).get()
      },
      {
        status: 'awaiting_admin_payment',
        accepts_cash: 1
      }
    );
  } finally {
    fixture.restore();
  }
});

test('offers address QR and both USDT detail modes with safe callbacks', () => {
  const payrollId = 'PAYROLL-USDT';
  const callbacks = usdtDetailModeKeyboard(
    payrollId,
    'zh'
  ).inline_keyboard.flat().map((button) => button.callback_data);

  assert.deepEqual(callbacks, [
    `pay:um:a:${payrollId}`,
    `pay:um:q:${payrollId}`,
    `pay:um:b:${payrollId}`
  ]);
  assert.ok(callbacks.every((callback) =>
    Buffer.byteLength(callback, 'utf8') <= 64
  ));
});

test('collects address-only QR-only and combined USDT profiles', async (context) => {
  await context.test('address-only finishes after text', async () => {
    const fixture = flowFixture();
    try {
      insertFlowPayroll(fixture.database, 'PAYROLL-USDT-ADDRESS');
      await sendCallback(
        fixture.env,
        'pay:d:PAYROLL-USDT-ADDRESS',
        1001
      );
      await sendCallback(
        fixture.env,
        'pay:m:u:PAYROLL-USDT-ADDRESS',
        1001
      );
      await sendCallback(
        fixture.env,
        'pay:c:PAYROLL-USDT-ADDRESS',
        1001
      );
      assert.equal(
        fixture.database.prepare(`
          SELECT state FROM user_states WHERE telegram_id = '1001'
        `).get().state,
        'WAIT_PAYROLL_USDT_MODE'
      );

      await sendCallback(
        fixture.env,
        'pay:um:a:PAYROLL-USDT-ADDRESS',
        1001
      );
      await sendText(fixture.env, 'TADDRESS');

      const saved = fixture.database.prepare(`
        SELECT
          usdt_details_snapshot,
          usdt_qr_id_snapshot
        FROM payroll_disbursements
        WHERE payroll_id = 'PAYROLL-USDT-ADDRESS'
      `).get();
      assert.equal(saved.usdt_details_snapshot, 'TADDRESS');
      assert.equal(saved.usdt_qr_id_snapshot, null);
      assert.equal(
        fixture.database.prepare(`
          SELECT 1 FROM user_states WHERE telegram_id = '1001'
        `).get(),
        undefined
      );
    } finally {
      fixture.restore();
    }
  });

  await context.test('QR-only finishes after one photo', async () => {
    const fixture = flowFixture();
    try {
      insertFlowPayroll(
        fixture.database,
        'PAYROLL-USDT-QR',
        8_000_000_000_000
      );
      await sendCallback(
        fixture.env,
        'pay:d:PAYROLL-USDT-QR',
        1001
      );
      await sendCallback(
        fixture.env,
        'pay:m:u:PAYROLL-USDT-QR',
        1001
      );
      await sendCallback(
        fixture.env,
        'pay:c:PAYROLL-USDT-QR',
        1001
      );
      await sendCallback(
        fixture.env,
        'pay:um:q:PAYROLL-USDT-QR',
        1001
      );

      await sendText(fixture.env, 'not a photo');
      assert.equal(
        fixture.database.prepare(`
          SELECT state FROM user_states WHERE telegram_id = '1001'
        `).get().state,
        'WAIT_PAYROLL_USDT_QR'
      );
      await sendPhoto(fixture.env, 'EMPLOYEE-USDT-QR', {
        id: 1001,
        first_name: 'Alice',
        username: 'alice'
      });

      const saved = fixture.database.prepare(`
        SELECT
          amount_snapshot_micros,
          cutoff_at,
          usdt_details_snapshot,
          usdt_qr_id_snapshot
        FROM payroll_disbursements
        WHERE payroll_id = 'PAYROLL-USDT-QR'
      `).get();
      assert.equal(saved.amount_snapshot_micros, 8_000_000_000_000);
      assert.equal(saved.cutoff_at, '2026-07-16T03:00:00.000Z');
      assert.equal(saved.usdt_details_snapshot, null);
      assert.match(saved.usdt_qr_id_snapshot, /^QR-/);
      assert.ok(fixture.payloads.some((payload) =>
        payload.chat_id === '9001'
        && payload.photo === 'EMPLOYEE-USDT-QR'
        && payload.caption.includes('PAYROLL-USDT-QR')
      ));
    } finally {
      fixture.restore();
    }
  });

  await context.test('both asks for address then QR after bank details', async () => {
    const fixture = flowFixture();
    try {
      insertFlowPayroll(fixture.database, 'PAYROLL-USDT-BOTH');
      await sendCallback(
        fixture.env,
        'pay:d:PAYROLL-USDT-BOTH',
        1001
      );
      await sendCallback(
        fixture.env,
        'pay:m:b:PAYROLL-USDT-BOTH',
        1001
      );
      await sendCallback(
        fixture.env,
        'pay:m:u:PAYROLL-USDT-BOTH',
        1001
      );
      await sendCallback(
        fixture.env,
        'pay:c:PAYROLL-USDT-BOTH',
        1001
      );
      await sendText(fixture.env, 'BANK-1234');
      assert.equal(
        fixture.database.prepare(`
          SELECT state FROM user_states WHERE telegram_id = '1001'
        `).get().state,
        'WAIT_PAYROLL_USDT_MODE'
      );

      await sendCallback(
        fixture.env,
        'pay:um:b:PAYROLL-USDT-BOTH',
        1001
      );
      await sendText(fixture.env, 'TADDRESS-BOTH');
      assert.equal(
        fixture.database.prepare(`
          SELECT state FROM user_states WHERE telegram_id = '1001'
        `).get().state,
        'WAIT_PAYROLL_USDT_QR'
      );
      await sendPhoto(fixture.env, 'EMPLOYEE-USDT-BOTH', {
        id: 1001,
        first_name: 'Alice',
        username: 'alice'
      });

      const saved = fixture.database.prepare(`
        SELECT
          bank_details_snapshot,
          usdt_details_snapshot,
          usdt_qr_id_snapshot
        FROM payroll_disbursements
        WHERE payroll_id = 'PAYROLL-USDT-BOTH'
      `).get();
      assert.equal(saved.bank_details_snapshot, 'BANK-1234');
      assert.equal(saved.usdt_details_snapshot, 'TADDRESS-BOTH');
      assert.match(saved.usdt_qr_id_snapshot, /^QR-/);
    } finally {
      fixture.restore();
    }
  });
});

test('a failed admin QR delivery does not undo the saved profile', async () => {
  const fixture = flowFixture({ failQrDelivery: true });
  try {
    insertFlowPayroll(fixture.database, 'PAYROLL-USDT-DELIVERY');
    await sendCallback(
      fixture.env,
      'pay:d:PAYROLL-USDT-DELIVERY',
      1001
    );
    await sendCallback(
      fixture.env,
      'pay:m:u:PAYROLL-USDT-DELIVERY',
      1001
    );
    await sendCallback(
      fixture.env,
      'pay:c:PAYROLL-USDT-DELIVERY',
      1001
    );
    await sendCallback(
      fixture.env,
      'pay:um:q:PAYROLL-USDT-DELIVERY',
      1001
    );
    await sendPhoto(fixture.env, 'PRIVATE-QR-FILE-ID', {
      id: 1001,
      first_name: 'Alice',
      username: 'alice'
    });

    const payroll = fixture.database.prepare(`
      SELECT status, usdt_qr_id_snapshot
      FROM payroll_disbursements
      WHERE payroll_id = 'PAYROLL-USDT-DELIVERY'
    `).get();
    assert.equal(payroll.status, 'awaiting_admin_payment');
    assert.match(payroll.usdt_qr_id_snapshot, /^QR-/);

    const log = fixture.database.prepare(`
      SELECT payload_json
      FROM bot_logs
      WHERE event = 'payroll_usdt_qr_delivery_failed'
    `).get();
    assert.ok(
      log,
      JSON.stringify(
        fixture.database.prepare(`
          SELECT event, payload_json FROM bot_logs
        `).all()
      )
    );
    assert.doesNotMatch(log.payload_json, /PRIVATE-QR-FILE-ID/);
    assert.doesNotMatch(log.payload_json, /payroll-payment-qr/);
  } finally {
    fixture.restore();
  }
});

test('admin splits payroll and uploads proof images by payment method', async () => {
  const fixture = flowFixture();
  try {
    fixture.database.prepare(`
      INSERT INTO payroll_disbursements (
        payroll_id, store_id, telegram_id, payroll_start_date,
        scheduled_date, cycle_day, period_start, cutoff_at,
        amount_snapshot_micros, currency, status,
        accepts_bank, accepts_usdt, accepts_cash,
        bank_details_snapshot,
        created_at, updated_at
      ) VALUES (
        'PAYROLL-ADMIN', 'STORE1', '1001', '2026-07-01',
        '2026-07-16', 16,
        '2026-07-01T00:00:00.000Z',
        '2026-07-16T03:00:00.000Z',
        60000000, '$', 'awaiting_admin_payment',
        1, 0, 1, 'Bank account 12345678',
        '2026-07-16T03:00:00.000Z',
        '2026-07-16T03:00:00.000Z'
      )
    `).run();

    await sendCallback(
      fixture.env,
      'pay:a:PAYROLL-ADMIN',
      9001
    );
    assert.equal(
      fixture.database.prepare(`
        SELECT state FROM user_states WHERE telegram_id = '9001'
      `).get().state,
      'WAIT_PAYROLL_SPLIT'
    );
    assert.match(fixture.payloads.at(-1).text, /银行卡.*付款金额/);

    await sendText(fixture.env, '40', {
      id: 9001,
      first_name: 'Admin',
      username: 'admin'
    });

    assert.deepEqual(
      {
        ...fixture.database.prepare(`
          SELECT bank_micros, usdt_micros, cash_micros, current_admin_id
          FROM payroll_disbursements
          WHERE payroll_id = 'PAYROLL-ADMIN'
        `).get()
      },
      {
        bank_micros: 40000000,
        usdt_micros: 0,
        cash_micros: 20000000,
        current_admin_id: '9001'
      }
    );
    assert.equal(
      fixture.database.prepare(`
        SELECT state FROM user_states WHERE telegram_id = '9001'
      `).get().state,
      'WAIT_PAYROLL_PROOF'
    );

    await sendPhoto(fixture.env, 'BANK-PHOTO');
    await sendCallback(
      fixture.env,
      'pay:a:PAYROLL-ADMIN',
      9001
    );
    assert.equal(
      fixture.database.prepare(`
        SELECT state FROM user_states WHERE telegram_id = '9001'
      `).get().state,
      'WAIT_PAYROLL_PROOF'
    );
    assert.equal(
      fixture.database.prepare(`
        SELECT COUNT(*) AS count
        FROM payroll_payment_proofs
        WHERE payroll_id = 'PAYROLL-ADMIN'
          AND superseded_at IS NULL
      `).get().count,
      1
    );
    await sendCallback(
      fixture.env,
      'pay:ps:c:PAYROLL-ADMIN',
      9001
    );
    await sendPhoto(fixture.env, 'CASH-PHOTO');
    await sendCallback(
      fixture.env,
      'pay:pc:PAYROLL-ADMIN',
      9001
    );

    assert.deepEqual(
      fixture.database.prepare(`
        SELECT method, COUNT(*) AS count
        FROM payroll_payment_proofs
        WHERE payroll_id = 'PAYROLL-ADMIN'
        GROUP BY method
        ORDER BY method
      `).all().map((row) => ({ ...row })),
      [
        { method: 'bank', count: 1 },
        { method: 'cash', count: 1 }
      ]
    );
    assert.equal(fixture.proofObjects.size, 2);
    assert.equal(
      fixture.database.prepare(`
        SELECT status FROM payroll_disbursements
        WHERE payroll_id = 'PAYROLL-ADMIN'
      `).get().status,
      'awaiting_employee_confirmation'
    );
    const confirmation = fixture.payloads.find((payload) =>
      payload.chat_id === '1001'
      && payload.reply_markup
      && payload.reply_markup.inline_keyboard.flat().some(
        (button) => button.callback_data === 'pay:ok:PAYROLL-ADMIN'
      )
    );
    assert.ok(confirmation);
    assert.match(confirmation.text, /工资总额：\$60\.00/);
    assert.equal(
      fixture.payloads.filter((payload) =>
        payload.chat_id === '1001' && payload.photo
      ).length,
      2
    );
    assert.equal(
      fixture.database.prepare(`
        SELECT 1 FROM user_states WHERE telegram_id = '9001'
      `).get(),
      undefined
    );

    await sendCallback(
      fixture.env,
      'pay:ok:PAYROLL-ADMIN',
      1001,
      confirmation.text
    );
    assert.deepEqual(
      {
        ...fixture.database.prepare(`
          SELECT status, salary_record_id
          FROM payroll_disbursements
          WHERE payroll_id = 'PAYROLL-ADMIN'
        `).get()
      },
      {
        status: 'confirmed',
        salary_record_id: 'SAL-AUTO-PAYROLL-ADMIN'
      }
    );
    assert.equal(
      fixture.database.prepare(`
        SELECT COUNT(*) AS count FROM salary_records
        WHERE request_id = 'PAYROLL-ADMIN'
      `).get().count,
      1
    );
    assert.equal(
      fixture.database.prepare(`
        SELECT recipient FROM payroll_email_outbox
        WHERE payroll_id = 'PAYROLL-ADMIN'
      `).get().recipient,
      'finance@example.test'
    );
  } finally {
    fixture.restore();
  }
});

test('employee dispute notifies admins with a correction button', async () => {
  const fixture = flowFixture();
  try {
    fixture.database.prepare(`
      INSERT INTO payroll_disbursements (
        payroll_id, store_id, telegram_id, payroll_start_date,
        scheduled_date, cycle_day, period_start, cutoff_at,
        amount_snapshot_micros, currency, status,
        accepts_bank, bank_details_snapshot, bank_micros,
        current_admin_id, payment_sent_at,
        created_at, updated_at
      ) VALUES (
        'PAYROLL-DISPUTE', 'STORE1', '1001', '2026-07-01',
        '2026-07-16', 16,
        '2026-07-01T00:00:00.000Z',
        '2026-07-16T03:00:00.000Z',
        60000000, '$', 'awaiting_employee_confirmation',
        1, 'Bank account 12345678', 60000000,
        '9001', '2026-07-16T04:00:00.000Z',
        '2026-07-16T03:00:00.000Z',
        '2026-07-16T04:00:00.000Z'
      )
    `).run();

    await sendCallback(
      fixture.env,
      'pay:x:PAYROLL-DISPUTE',
      1001
    );

    assert.equal(
      fixture.database.prepare(`
        SELECT status FROM payroll_disbursements
        WHERE payroll_id = 'PAYROLL-DISPUTE'
      `).get().status,
      'disputed'
    );
    const adminNotice = fixture.payloads.find((payload) =>
      payload.chat_id === '9001'
      && payload.text
      && payload.text.includes('PAYROLL-DISPUTE')
    );
    assert.ok(adminNotice);
    assert.doesNotMatch(adminNotice.text, /12345678/);
    assert.match(adminNotice.text, /••••5678/);
    assert.equal(
      adminNotice.reply_markup.inline_keyboard[0][0].callback_data,
      'pay:a:PAYROLL-DISPUTE'
    );
  } finally {
    fixture.restore();
  }
});
