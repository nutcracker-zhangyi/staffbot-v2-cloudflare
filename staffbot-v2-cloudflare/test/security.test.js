import test from 'node:test';
import assert from 'node:assert/strict';

import worker, {
  csvCell,
  isTelegramRecipientAllowed,
  isWebhookConfigReady,
  nextLoginFailureState,
  parseTelegramAllowlist,
  sanitizeLogPayload,
  scheduledTasksEnabled,
  securityHeaders,
  serviceEnvironment,
  webhookSecretMatches
} from '../src/index.js';
import { telegram } from '../src/telegram-client.js';

test('requires an explicit service environment', () => {
  assert.equal(serviceEnvironment({}), 'unknown');
  assert.equal(serviceEnvironment({ ENVIRONMENT: 'production' }), 'production');
  assert.equal(serviceEnvironment({ ENVIRONMENT: 'staging' }), 'staging');
  assert.equal(serviceEnvironment({ ENVIRONMENT: 'typo' }), 'unknown');
});

test('parses a normalized Telegram recipient allowlist', () => {
  assert.deepEqual(
    [...parseTelegramAllowlist(' 1001,1002,1001 ,, ')],
    ['1001', '1002']
  );
  assert.deepEqual([...parseTelegramAllowlist('')], []);
});

test('blocks non-allowlisted staging Telegram chat recipients', () => {
  const env = {
    ENVIRONMENT: 'staging',
    TELEGRAM_RECIPIENT_MODE: 'allowlist',
    STAGING_ALLOWED_TELEGRAM_IDS: '1001,1002'
  };
  assert.equal(isTelegramRecipientAllowed(env, { chat_id: '1001' }), true);
  assert.equal(isTelegramRecipientAllowed(env, { chat_id: 1002 }), true);
  assert.equal(isTelegramRecipientAllowed(env, { chat_id: '9999' }), false);
  assert.equal(
    isTelegramRecipientAllowed(
      {
        ENVIRONMENT: 'staging',
        STAGING_ALLOWED_TELEGRAM_IDS: '1001'
      },
      { chat_id: '1001' }
    ),
    false
  );
});

test('keeps production and callback-only Telegram calls available', () => {
  assert.equal(
    isTelegramRecipientAllowed(
      { ENVIRONMENT: 'production' },
      { chat_id: '9999' }
    ),
    true
  );
  assert.equal(
    isTelegramRecipientAllowed(
      {
        ENVIRONMENT: 'staging',
        TELEGRAM_RECIPIENT_MODE: 'allowlist',
        STAGING_ALLOWED_TELEGRAM_IDS: '1001'
      },
      { callback_query_id: 'callback-1' }
    ),
    true
  );
  assert.equal(
    isTelegramRecipientAllowed(
      { ENVIRONMENT: 'unknown' },
      { callback_query_id: 'callback-2' }
    ),
    false
  );
});

test('does not call Telegram API for a blocked staging recipient', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return { json: async () => ({ ok: true }) };
  };

  const logged = [];
  const env = {
    ENVIRONMENT: 'staging',
    TELEGRAM_RECIPIENT_MODE: 'allowlist',
    STAGING_ALLOWED_TELEGRAM_IDS: '1001',
    BOT_TOKEN: 'test-token',
    DB: {
      prepare() {
        return {
          bind(...params) {
            return {
              async run() {
                logged.push(params);
                return { success: true };
              }
            };
          }
        };
      }
    }
  };

  try {
    const result = await telegram(env, 'sendMessage', {
      chat_id: '9999',
      text: 'must not leave staging'
    });
    assert.equal(fetchCalls, 0);
    assert.deepEqual(result, {
      ok: false,
      error_code: 403,
      description: 'staging_recipient_blocked'
    });
    assert.equal(logged.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('only runs scheduled tasks when explicitly enabled', () => {
  assert.equal(scheduledTasksEnabled(undefined), false);
  assert.equal(scheduledTasksEnabled({}), false);
  assert.equal(scheduledTasksEnabled({ SCHEDULED_TASKS_ENABLED: 'false' }), false);
  assert.equal(scheduledTasksEnabled({ SCHEDULED_TASKS_ENABLED: 'true' }), true);
  assert.equal(scheduledTasksEnabled({ SCHEDULED_TASKS_ENABLED: true }), true);
});

test('does not queue scheduled work when automation is disabled', async () => {
  let waitUntilCalls = 0;
  await worker.scheduled(
    { scheduledTime: Date.parse('2026-07-28T03:10:00.000Z') },
    { SCHEDULED_TASKS_ENABLED: 'false' },
    {
      waitUntil(promise) {
        waitUntilCalls += 1;
        Promise.resolve(promise).catch(() => {});
      }
    }
  );
  assert.equal(waitUntilCalls, 0);
});

test('identifies staging in health and admin responses', async () => {
  const context = { waitUntil() {} };
  const stagingEnv = { ENVIRONMENT: 'staging' };
  const health = await worker.fetch(
    new Request('https://staffbot.example/'),
    stagingEnv,
    context
  );
  assert.deepEqual(await health.json(), {
    ok: true,
    service: 'staffbot-v2',
    environment: 'staging',
    admin: '/admin'
  });

  const stagingAdmin = await worker.fetch(
    new Request('https://staffbot.example/admin'),
    stagingEnv,
    context
  );
  assert.match(await stagingAdmin.text(), /STAGING 测试环境/);

  const productionAdmin = await worker.fetch(
    new Request('https://staffbot.example/admin'),
    { ENVIRONMENT: 'production' },
    context
  );
  assert.doesNotMatch(await productionAdmin.text(), /STAGING 测试环境/);
});

test('prefixes CSV cells that spreadsheet apps would treat as formulas', () => {
  assert.equal(csvCell('=IMPORTXML("https://example.com")'), '"\'=IMPORTXML(""https://example.com"")"');
  assert.equal(csvCell('+SUM(1,2)'), '"\'+SUM(1,2)"');
  assert.equal(csvCell('-10'), '\'-10');
  assert.equal(csvCell('@cmd'), '\'@cmd');
});

test('keeps normal CSV escaping behavior', () => {
  assert.equal(csvCell('hello'), 'hello');
  assert.equal(csvCell('hello,world'), '"hello,world"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
});

test('keeps numeric CSV amounts raw for exports', () => {
  assert.equal(csvCell(1500000), '1500000');
  assert.equal(csvCell(1234.5), '1234.5');
});

test('redacts noisy or sensitive fields from persisted logs', () => {
  assert.deepEqual(sanitizeLogPayload({
    telegram_id: 123,
    store_id: 'DEFAULT',
    text: '/income 1000',
    latitude: 35.1,
    payload: { nested: true },
    error: 'stack trace'
  }), {
    telegram_id: '123',
    store_id: 'DEFAULT',
    text: '[redacted]',
    latitude: '[redacted]',
    payload: '[redacted]',
    error: 'stack trace'
  });
});

test('reports webhook configuration readiness from required secrets', () => {
  assert.equal(isWebhookConfigReady({ BOT_TOKEN: 'bot', WEBHOOK_SECRET: 'secret' }), true);
  assert.equal(isWebhookConfigReady({ BOT_TOKEN: 'bot' }), false);
  assert.equal(isWebhookConfigReady({ WEBHOOK_SECRET: 'secret' }), false);
});

test('compares webhook header secret when Telegram sends it', () => {
  assert.equal(webhookSecretMatches('secret', 'secret'), true);
  assert.equal(webhookSecretMatches('wrong', 'secret'), false);
  assert.equal(webhookSecretMatches('', 'secret'), true);
});

test('locks admin login after repeated failed code attempts', () => {
  const now = new Date('2026-06-26T12:00:00.000Z');
  assert.deepEqual(nextLoginFailureState(3, now), { failedAttempts: 4, lockedUntil: null });
  assert.deepEqual(nextLoginFailureState(4, now), { failedAttempts: 5, lockedUntil: '2026-06-26T12:10:00.000Z' });
});

test('security headers include basic browser hardening', () => {
  assert.equal(securityHeaders()['x-content-type-options'], 'nosniff');
  assert.equal(securityHeaders()['x-frame-options'], 'DENY');
  assert.match(securityHeaders()['content-security-policy'], /default-src 'self'/);
});
