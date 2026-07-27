import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const config = await readFile(
  new URL('../wrangler.toml', import.meta.url),
  'utf8'
);

test('declares a separate staging Worker and bindings', () => {
  assert.match(config, /\[env\.staging\][\s\S]*workers_dev\s*=\s*true/);
  assert.match(config, /\[\[env\.staging\.d1_databases\]\]/);
  assert.match(config, /database_name\s*=\s*"staffbot_v2_staging"/);
  assert.match(config, /\[\[env\.staging\.r2_buckets\]\]/);
  assert.match(config, /bucket_name\s*=\s*"staffbot-v2-payroll-proofs-staging"/);
});

test('declares staging safety variables explicitly', () => {
  assert.match(config, /\[env\.staging\.vars\][\s\S]*ENVIRONMENT\s*=\s*"staging"/);
  assert.match(config, /SCHEDULED_TASKS_ENABLED\s*=\s*"false"/);
  assert.match(config, /TELEGRAM_RECIPIENT_MODE\s*=\s*"allowlist"/);
});

test('removes all staging Cron triggers explicitly', () => {
  assert.match(config, /\[env\.staging\.triggers\][\s\S]*crons\s*=\s*\[\]/);
});

test('keeps production and staging D1 names different', () => {
  assert.match(config, /database_name\s*=\s*"staffbot_v2"/);
  assert.match(config, /database_name\s*=\s*"staffbot_v2_staging"/);
  assert.doesNotMatch(config, /BOT_TOKEN\s*=/);
  assert.doesNotMatch(config, /WEBHOOK_SECRET\s*=/);
  assert.doesNotMatch(config, /STAGING_ALLOWED_TELEGRAM_IDS\s*=/);
});
