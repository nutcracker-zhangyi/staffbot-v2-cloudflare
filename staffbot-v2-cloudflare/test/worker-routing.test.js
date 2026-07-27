import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import worker from '../src/index.js';
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
