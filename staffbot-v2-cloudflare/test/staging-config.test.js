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
  assert.match(config, /\[env\.staging\.vars\][\s\S]*PAYROLL_LEDGER_READ_MODE\s*=\s*"ledger"/);
  assert.match(config, /\[env\.staging\.vars\][\s\S]*PAYROLL_LEDGER_WRITE_MODE\s*=\s*"dual"/);
  assert.match(config, /SCHEDULED_TASKS_ENABLED\s*=\s*"false"/);
  assert.match(config, /TELEGRAM_RECIPIENT_MODE\s*=\s*"allowlist"/);
  assert.match(
    config,
    /\[env\.staging\.vars\][\s\S]*MANAGE_BASE_URL\s*=\s*"https:\/\/staffbot-v2-staging\.staffbot-v2\.workers\.dev"/
  );
});

test('declares exact stable production and staging manage origins', () => {
  const productionVars = config.match(/\[vars\]([\s\S]*?)\n\[/)?.[1] || '';
  const stagingVars = config.match(/\[env\.staging\.vars\]([\s\S]*?)\n\[/)?.[1] || '';
  assert.match(
    productionVars,
    /MANAGE_BASE_URL\s*=\s*"https:\/\/staffbot-v2\.staffbot-v2\.workers\.dev"/
  );
  assert.match(
    stagingVars,
    /MANAGE_BASE_URL\s*=\s*"https:\/\/staffbot-v2-staging\.staffbot-v2\.workers\.dev"/
  );
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

test('does not invent payroll email addresses or bindings', () => {
  assert.doesNotMatch(config, /\[\[.*send_email\]\]/);
  assert.doesNotMatch(config, /PAYROLL_FINANCE_EMAIL\s*=/);
  assert.doesNotMatch(config, /PAYROLL_FROM_EMAIL\s*=/);
});
