import test from 'node:test';
import assert from 'node:assert/strict';

import {
  csvCell,
  isWebhookConfigReady,
  nextLoginFailureState,
  sanitizeLogPayload,
  securityHeaders,
  webhookSecretMatches
} from '../src/index.js';

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
