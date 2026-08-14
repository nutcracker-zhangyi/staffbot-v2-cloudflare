# StaffBot Staging Environment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fully isolated Cloudflare staging environment for StaffBot with a separate Worker, copied-and-sanitized D1 data, separate R2 bucket, separate Telegram bot, allowlisted outbound messages, and disabled remote Cron triggers.

**Architecture:** Keep the existing root Wrangler configuration as production and add a named `staging` environment whose bindings and variables are declared explicitly. Add two independent safety fences in code: staging Telegram calls with a `chat_id` may only target an allowlist, and scheduled work may only run when explicitly enabled. Copy production D1 into the separate staging database, remove ephemeral state, then deploy and connect `@staffbot_v2_staging_bot`.

**Tech Stack:** Cloudflare Workers, Wrangler environments, Cloudflare D1, Cloudflare R2, Telegram Bot API, JavaScript ES modules, Node.js built-in test runner.

## Global Constraints

- Do not deploy or mutate the root production Worker during this plan.
- Every deploy command in this plan must include `--env staging`.
- Staging must use a different Worker, D1 database, R2 bucket, Telegram bot, and secrets from production.
- The staging Telegram bot username is `staffbot_v2_staging_bot`.
- Never write a Telegram Bot Token, webhook secret, admin ID secret, or production database export into Git.
- Staging outbound Telegram messages with a `chat_id` must be blocked unless the recipient is explicitly allowlisted.
- Staging remote Cron triggers must remain empty.
- The scheduled handler must have an independent code-level disabled switch.
- Production business/history data may be copied; sessions, login codes, transient user state, notification delivery state, and bot logs must be removed from the staging copy.
- The current application must run in staging before modular refactoring, payroll-ledger migration, Dashboard work, or automatic payroll work begins.
- No payroll, income, fine, leave, attendance, or salary business rule changes are allowed in this plan.
- Use plain JavaScript and existing Node test tooling; do not add a framework or runtime dependency.
- Run `npm run check` and `npm test` before every commit.
- Each commit must contain one independently reviewable change.

## Command Locations

- Run all `npm`, `node`, `npx wrangler`, `curl`, and staging shell commands from:
  `/Users/nutcrackermacbookair/Documents/telegram/staffbot-v2-cloudflare`
- Run every `git add`, `git commit`, and repository-wide `git grep` command from the Git root:
  `/Users/nutcrackermacbookair/Documents/telegram`
- Paths beginning with `staffbot-v2-cloudflare/` in Git commands are relative to that Git root.
- Do not silently change either working directory during an execution task.

---

## File Structure

### Files modified

- `src/index.js`
  - Add environment helpers, staging Telegram recipient enforcement, scheduled-task gate, and visible staging identity.
- `wrangler.toml`
  - Preserve the existing root production configuration and add explicit staging bindings, variables, and empty Cron triggers.
- `test/security.test.js`
  - Cover staging recipient enforcement, production pass-through, environment naming, and scheduled-task gating.
- `package.json`
  - Add a focused staging-config test script without changing runtime dependencies.

### Files created

- `test/staging-config.test.js`
  - Verify the committed Wrangler staging safety contract without contacting Cloudflare.
- `scripts/staging-sanitize.sql`
  - Remove ephemeral and outbound-delivery state after importing a production D1 snapshot.
- `test/staging-sanitize.test.js`
  - Verify the sanitizer only clears approved ephemeral tables and preserves business tables.
- `docs/STAGING_RUNBOOK.md`
  - Record safe commands, resource names, manual secret handling, import order, verification, and teardown boundaries.

### External resources created during execution

- Worker environment: `staffbot-v2-staging`
- D1 database: `staffbot_v2_staging`
- Private R2 bucket: `staffbot-v2-payroll-proofs-staging`
- Telegram bot: `@staffbot_v2_staging_bot`

### Interfaces produced

```js
serviceEnvironment(env) -> 'production' | 'staging' | 'unknown'
parseTelegramAllowlist(value) -> Set<string>
isTelegramRecipientAllowed(env, payload) -> boolean
scheduledTasksEnabled(env) -> boolean
```

Later refactoring plans may move these functions into configuration and Telegram modules, but this plan keeps them in `src/index.js` to minimize pre-refactor movement.

---

### Task 1: Add the staging outbound-message safety fence

**Files:**

- Modify: `src/index.js:3067-3098`
- Modify: `src/index.js:3491-3509`
- Modify: `test/security.test.js`

**Interfaces:**

- Consumes: `env.ENVIRONMENT`, `env.STAGING_ALLOWED_TELEGRAM_IDS`, Telegram payloads that may contain `chat_id`.
- Produces:

```js
export function serviceEnvironment(env)
export function parseTelegramAllowlist(value)
export function isTelegramRecipientAllowed(env, payload)
```

- Behavior:
  - Only an explicit production environment allows unrestricted existing Telegram behavior.
  - Missing, misspelled, or otherwise unknown environments fail closed.
  - Staging Telegram methods without `chat_id`, such as `answerCallbackQuery`, remain allowed.
  - Staging Telegram methods with `chat_id` only run for IDs in `STAGING_ALLOWED_TELEGRAM_IDS`.
  - A blocked call does not call `fetch`.
  - A blocked call writes a sanitized `staging_telegram_recipient_blocked` log.

- [ ] **Step 1: Add imports to the existing security test**

Extend the import in `test/security.test.js`:

```js
import {
  csvCell,
  isTelegramRecipientAllowed,
  isWebhookConfigReady,
  nextLoginFailureState,
  parseTelegramAllowlist,
  sanitizeLogPayload,
  securityHeaders,
  serviceEnvironment,
  webhookSecretMatches
} from '../src/index.js';
```

- [ ] **Step 2: Write failing environment and allowlist tests**

Append:

```js
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
```

- [ ] **Step 3: Run the focused test and verify the red state**

Run:

```bash
node --test test/security.test.js
```

Expected: FAIL because the three exported helpers do not exist.

- [ ] **Step 4: Implement the minimal pure helpers**

Add near the existing security/configuration helpers in `src/index.js`:

```js
export function serviceEnvironment(env) {
  const value = String(env && env.ENVIRONMENT || '').trim().toLowerCase();
  if (value === 'production' || value === 'staging') return value;
  return 'unknown';
}

export function parseTelegramAllowlist(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
  );
}

export function isTelegramRecipientAllowed(env, payload) {
  const environment = serviceEnvironment(env);
  if (environment === 'production') return true;
  if (environment !== 'staging') return false;
  if (!payload || payload.chat_id === undefined || payload.chat_id === null) return true;
  if (String(env.TELEGRAM_RECIPIENT_MODE || '').toLowerCase() !== 'allowlist') return false;
  return parseTelegramAllowlist(env.STAGING_ALLOWED_TELEGRAM_IDS).has(String(payload.chat_id));
}
```

- [ ] **Step 5: Run the focused test and verify the green state**

Run:

```bash
node --test test/security.test.js
```

Expected: PASS.

- [ ] **Step 6: Write a failing behavior test for blocked network calls**

Export `telegram` from `src/index.js`, import it into `test/security.test.js`, and append:

```js
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
```

- [ ] **Step 7: Run the focused test and verify it fails**

Run:

```bash
node --test test/security.test.js
```

Expected: FAIL because `telegram` is not exported and does not enforce the fence.

- [ ] **Step 8: Enforce the fence before the network call**

Change the function signature and beginning:

```js
export async function telegram(env, method, payload) {
  if (!isTelegramRecipientAllowed(env, payload)) {
    await logEvent(env, 'warn', 'staging_telegram_recipient_blocked', {
      telegram_id: String(payload.chat_id),
      method
    });
    return {
      ok: false,
      error_code: 403,
      description: 'staging_recipient_blocked'
    };
  }

  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!result.ok) await logEvent(env, 'error', 'telegram_api_error', { method, payload, result });
  return result;
}
```

- [ ] **Step 9: Run all checks**

Run:

```bash
npm run check
npm test
```

Expected: syntax check passes and all tests pass.

- [ ] **Step 10: Commit**

```bash
git add staffbot-v2-cloudflare/src/index.js \
  staffbot-v2-cloudflare/test/security.test.js
git commit -m "feat: fence staging Telegram recipients"
```

---

### Task 2: Disable scheduled work in staging and show environment identity

**Files:**

- Modify: `src/index.js:218-257`
- Modify: `src/index.js:3503-3509`
- Modify: `src/index.js:4089-4232`
- Modify: `test/security.test.js`

**Interfaces:**

- Consumes: `env.SCHEDULED_TASKS_ENABLED`, `env.ENVIRONMENT`.
- Produces:

```js
export function scheduledTasksEnabled(env)
```

- [ ] **Step 1: Write failing scheduled-gate tests**

Import `scheduledTasksEnabled` and append:

```js
test('only runs scheduled tasks when explicitly enabled', () => {
  assert.equal(scheduledTasksEnabled(undefined), false);
  assert.equal(scheduledTasksEnabled({}), false);
  assert.equal(scheduledTasksEnabled({ SCHEDULED_TASKS_ENABLED: 'false' }), false);
  assert.equal(scheduledTasksEnabled({ SCHEDULED_TASKS_ENABLED: 'true' }), true);
  assert.equal(scheduledTasksEnabled({ SCHEDULED_TASKS_ENABLED: true }), true);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
node --test test/security.test.js
```

Expected: FAIL because `scheduledTasksEnabled` is not defined.

- [ ] **Step 3: Implement the scheduled-task gate**

Add:

```js
export function scheduledTasksEnabled(env) {
  return !!(env && (env.SCHEDULED_TASKS_ENABLED === true
    || String(env.SCHEDULED_TASKS_ENABLED || '').toLowerCase() === 'true'));
}
```

Change the scheduled handler:

```js
async scheduled(controller, env, ctx) {
  if (!scheduledTasksEnabled(env)) return;
  ctx.waitUntil(processAbsenceFines(env, new Date(controller.scheduledTime)));
}
```

- [ ] **Step 4: Add environment identity to the health response**

Change:

```js
return json({
  ok: true,
  service: 'staffbot-v2',
  environment: serviceEnvironment(env),
  admin: '/admin'
});
```

This is additive for production and gives staging smoke tests a non-visual identity check.

- [ ] **Step 5: Add a staging banner without changing production presentation**

Pass `env` into `adminHtml`:

```js
return html(adminHtml(env));
```

Change the function signature:

```js
function adminHtml(env = {}) {
  const stagingBanner = serviceEnvironment(env) === 'staging'
    ? '<div class="staging-banner" role="status">STAGING 测试环境</div>'
    : '';
```

Insert `${stagingBanner}` as the first visible element inside `<body>`, and add:

```css
.staging-banner {
  position:sticky;
  top:0;
  z-index:1000;
  padding:8px 12px;
  background:#8a2b2b;
  color:#fff;
  text-align:center;
  font-weight:700;
  letter-spacing:.04em;
}
```

- [ ] **Step 6: Add source-level regression assertions**

Append to `test/security.test.js`:

```js
test('health and admin surfaces expose staging identity', async () => {
  const source = await import('node:fs/promises')
    .then((fs) => fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8'));
  assert.match(source, /environment:\s*serviceEnvironment\(env\)/);
  assert.match(source, /STAGING 测试环境/);
  assert.match(source, /if \(!scheduledTasksEnabled\(env\)\) return/);
});
```

- [ ] **Step 7: Run all checks**

Run:

```bash
npm run check
npm test
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add staffbot-v2-cloudflare/src/index.js \
  staffbot-v2-cloudflare/test/security.test.js
git commit -m "feat: identify and disable staging automation"
```

---

### Task 3: Provision isolated Cloudflare resources and commit staging configuration

**Files:**

- Modify: `wrangler.toml`
- Modify: `package.json`
- Create: `test/staging-config.test.js`

**Interfaces:**

- Consumes: the D1 UUID returned by `wrangler d1 create`.
- Produces:
  - Worker environment `staffbot-v2-staging`.
  - D1 database `staffbot_v2_staging`.
  - R2 bucket `staffbot-v2-payroll-proofs-staging`.
  - Explicit staging binding contract in `wrangler.toml`.

- [ ] **Step 1: Verify the Cloudflare identity before creating anything**

Run:

```bash
npx wrangler whoami
```

Expected: the intended Cloudflare account is shown with Workers, D1, and R2 permissions. If authentication or permissions fail, stop this plan; do not create partial resources under another account.

- [ ] **Step 2: Confirm the staging names are unused**

Run:

```bash
npx wrangler d1 list
npx wrangler r2 bucket list
```

Expected: no D1 named `staffbot_v2_staging` and no R2 bucket named `staffbot-v2-payroll-proofs-staging`. If either exists, inspect and reuse only after confirming it belongs to this project; never create a duplicate with a guessed suffix.

- [ ] **Step 3: Create the staging D1 database**

Run:

```bash
npx wrangler d1 create staffbot_v2_staging --location apac
```

Expected: Wrangler returns the exact D1 database UUID. Save that UUID for the next step; it is not a secret.

- [ ] **Step 4: Create the private staging R2 bucket**

Run:

```bash
npx wrangler r2 bucket create staffbot-v2-payroll-proofs-staging
```

Expected: bucket creation succeeds. Do not enable public access.

- [ ] **Step 5: Write a failing staging-config contract test**

Create `test/staging-config.test.js`:

```js
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
```

- [ ] **Step 6: Add the focused test script**

Update `package.json`:

```json
{
  "scripts": {
    "check": "node --check src/index.js",
    "test": "node --test test/*.test.js",
    "test:staging": "node --test test/staging-config.test.js"
  }
}
```

- [ ] **Step 7: Run the config test and verify it fails**

Run:

```bash
node --test test/staging-config.test.js
```

Expected: FAIL because `wrangler.toml` has no staging environment.

- [ ] **Step 8: Add explicit production-safe root variables**

Extend the existing root `[vars]`:

```toml
[vars]
CURRENCY = "$"
ENVIRONMENT = "production"
SCHEDULED_TASKS_ENABLED = "true"
TELEGRAM_RECIPIENT_MODE = "all"
```

These values preserve production behavior after a future explicitly approved production deployment. This plan does not deploy the root environment.

- [ ] **Step 9: Add the staging environment**

Append to `wrangler.toml`, using the exact UUID returned in Step 3 for `database_id`:

```toml
[env.staging]
workers_dev = true

[[env.staging.d1_databases]]
binding = "DB"
database_name = "staffbot_v2_staging"
migrations_dir = "db/migrations"

[[env.staging.r2_buckets]]
binding = "PAYROLL_PROOFS"
bucket_name = "staffbot-v2-payroll-proofs-staging"

[env.staging.vars]
CURRENCY = "$"
ENVIRONMENT = "staging"
SCHEDULED_TASKS_ENABLED = "false"
TELEGRAM_RECIPIENT_MODE = "allowlist"

[env.staging.triggers]
crons = []
```

Before staging the file, use `apply_patch` to add a `database_id` assignment between `database_name` and `migrations_dir`. Its quoted value must be the exact UUID printed by Step 3.

Verify that the final staging block contains a UUID and does not reuse the production UUID:

```bash
rg -n 'database_id = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"' wrangler.toml
```

Expected: two different matches, one for production and one for staging.

- [ ] **Step 10: Run configuration and full tests**

Run:

```bash
node --test test/staging-config.test.js
npm run check
npm test
```

Expected: all tests pass.

- [ ] **Step 11: Verify the resolved staging configuration**

Run:

```bash
npx wrangler deploy --env staging --dry-run
```

Expected:

- Worker name resolves to `staffbot-v2-staging`.
- D1 binding resolves to `staffbot_v2_staging`.
- R2 binding resolves to `staffbot-v2-payroll-proofs-staging`.
- No secret values are printed.
- No remote deployment occurs.

- [ ] **Step 12: Commit**

```bash
git add staffbot-v2-cloudflare/wrangler.toml \
  staffbot-v2-cloudflare/package.json \
  staffbot-v2-cloudflare/test/staging-config.test.js
git commit -m "chore: configure isolated staging resources"
```

---

### Task 4: Add deterministic staging-data sanitization

**Files:**

- Create: `scripts/staging-sanitize.sql`
- Create: `test/staging-sanitize.test.js`
- Modify: `package.json`

**Interfaces:**

- Consumes: a D1 database cloned from production.
- Produces: the same business/history dataset with transient authentication, conversation, notification-delivery, and bot-log state removed.

- [ ] **Step 1: Write the sanitizer SQL**

Create `scripts/staging-sanitize.sql`:

```sql
DELETE FROM admin_sessions;
DELETE FROM admin_login_codes;
DELETE FROM user_states;
DELETE FROM absence_fine_notifications;
DELETE FROM bot_logs;

UPDATE absence_fine_requests
SET notified_at = NULL
WHERE status = 'pending';
```

Do not delete:

- `stores`
- `users`
- `store_members`
- `pending_income`
- `income_records`
- `salary_requests`
- `salary_records`
- `salary_advance_requests`
- `attendance_records`
- `pending_checkout_requests`
- `leave_requests`
- `absence_fine_requests`
- `admin_audit_logs`

- [ ] **Step 2: Write the sanitizer contract test**

Create `test/staging-sanitize.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sql = await readFile(
  new URL('../scripts/staging-sanitize.sql', import.meta.url),
  'utf8'
);

const ephemeralTables = [
  'admin_sessions',
  'admin_login_codes',
  'user_states',
  'absence_fine_notifications',
  'bot_logs'
];

const businessTables = [
  'stores',
  'users',
  'store_members',
  'pending_income',
  'income_records',
  'salary_requests',
  'salary_records',
  'salary_advance_requests',
  'attendance_records',
  'pending_checkout_requests',
  'leave_requests',
  'absence_fine_requests',
  'admin_audit_logs'
];

test('clears every approved ephemeral table', () => {
  for (const table of ephemeralTables) {
    assert.match(sql, new RegExp(`DELETE FROM ${table}\\s*;`, 'i'));
  }
});

test('does not delete business or financial history tables', () => {
  for (const table of businessTables) {
    assert.doesNotMatch(sql, new RegExp(`DELETE FROM ${table}\\s*;`, 'i'));
  }
});

test('resets pending absence notification timestamps', () => {
  assert.match(
    sql,
    /UPDATE absence_fine_requests[\s\S]*SET notified_at = NULL[\s\S]*status = 'pending'/i
  );
});
```

- [ ] **Step 3: Extend the focused staging test script**

Change `package.json`:

```json
{
  "scripts": {
    "check": "node --check src/index.js",
    "test": "node --test test/*.test.js",
    "test:staging": "node --test test/staging-config.test.js test/staging-sanitize.test.js"
  }
}
```

- [ ] **Step 4: Run focused and full tests**

Run:

```bash
npm run test:staging
npm run check
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add staffbot-v2-cloudflare/scripts/staging-sanitize.sql \
  staffbot-v2-cloudflare/package.json \
  staffbot-v2-cloudflare/test/staging-sanitize.test.js
git commit -m "test: define staging data sanitization"
```

---

### Task 5: Copy production D1 into staging and prove isolation

**Files:**

- Use: `scripts/staging-sanitize.sql`
- No tracked file changes.

**Interfaces:**

- Consumes: production D1 `staffbot_v2`, staging D1 `staffbot_v2_staging`.
- Produces: a sanitized staging copy with matching business record counts.

- [ ] **Step 1: Record production business-table counts**

Run each command read-only:

```bash
npx wrangler d1 execute staffbot_v2 --remote --command \
  "SELECT 'stores' AS table_name, COUNT(*) AS rows FROM stores
   UNION ALL SELECT 'users', COUNT(*) FROM users
   UNION ALL SELECT 'store_members', COUNT(*) FROM store_members
   UNION ALL SELECT 'pending_income', COUNT(*) FROM pending_income
   UNION ALL SELECT 'income_records', COUNT(*) FROM income_records
   UNION ALL SELECT 'salary_requests', COUNT(*) FROM salary_requests
   UNION ALL SELECT 'salary_records', COUNT(*) FROM salary_records
   UNION ALL SELECT 'salary_advance_requests', COUNT(*) FROM salary_advance_requests
   UNION ALL SELECT 'attendance_records', COUNT(*) FROM attendance_records
   UNION ALL SELECT 'pending_checkout_requests', COUNT(*) FROM pending_checkout_requests
   UNION ALL SELECT 'leave_requests', COUNT(*) FROM leave_requests
   UNION ALL SELECT 'absence_fine_requests', COUNT(*) FROM absence_fine_requests
   UNION ALL SELECT 'admin_audit_logs', COUNT(*) FROM admin_audit_logs;"
```

Expected: a count row for every listed business table. This is a live diagnostic only; the exported snapshot counts recorded in Step 4 are the authoritative comparison because production may continue changing.

- [ ] **Step 2: Create a private temporary export directory**

Run:

```bash
STAGING_EXPORT_DIR="$(mktemp -d /private/tmp/staffbot-staging.XXXXXX)"
chmod 700 "${STAGING_EXPORT_DIR}"
```

Expected: a new mode-700 directory under `/private/tmp`. Do not use the repository, home directory, or a broad cleanup target.

- [ ] **Step 3: Export the production D1 database**

Run:

```bash
npx wrangler d1 export staffbot_v2 \
  --remote \
  --output="${STAGING_EXPORT_DIR}/staffbot-live.sql"
chmod 600 "${STAGING_EXPORT_DIR}/staffbot-live.sql"
```

Expected: the SQL export exists only in the private temporary directory.

- [ ] **Step 4: Build a local snapshot database and record authoritative counts**

Run:

```bash
sqlite3 "${STAGING_EXPORT_DIR}/snapshot.sqlite" \
  < "${STAGING_EXPORT_DIR}/staffbot-live.sql"

sqlite3 -header -column "${STAGING_EXPORT_DIR}/snapshot.sqlite" \
  "SELECT 'stores' AS table_name, COUNT(*) AS rows FROM stores
   UNION ALL SELECT 'users', COUNT(*) FROM users
   UNION ALL SELECT 'store_members', COUNT(*) FROM store_members
   UNION ALL SELECT 'pending_income', COUNT(*) FROM pending_income
   UNION ALL SELECT 'income_records', COUNT(*) FROM income_records
   UNION ALL SELECT 'salary_requests', COUNT(*) FROM salary_requests
   UNION ALL SELECT 'salary_records', COUNT(*) FROM salary_records
   UNION ALL SELECT 'salary_advance_requests', COUNT(*) FROM salary_advance_requests
   UNION ALL SELECT 'attendance_records', COUNT(*) FROM attendance_records
   UNION ALL SELECT 'pending_checkout_requests', COUNT(*) FROM pending_checkout_requests
   UNION ALL SELECT 'leave_requests', COUNT(*) FROM leave_requests
   UNION ALL SELECT 'absence_fine_requests', COUNT(*) FROM absence_fine_requests
   UNION ALL SELECT 'admin_audit_logs', COUNT(*) FROM admin_audit_logs;"
```

Expected: local SQLite imports the export and returns a snapshot count for every business table. Record these counts as the authoritative expected values.

- [ ] **Step 5: Confirm the target database name before import**

Run:

```bash
npx wrangler d1 execute staffbot_v2_staging --remote --command \
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

Expected: the newly created staging database is empty or contains no application tables. If it already contains application data, stop and inspect it instead of overwriting.

- [ ] **Step 6: Import the snapshot into staging**

Run:

```bash
npx wrangler d1 execute staffbot_v2_staging \
  --remote \
  --file="${STAGING_EXPORT_DIR}/staffbot-live.sql"
```

Expected: import succeeds against `staffbot_v2_staging`, never `staffbot_v2`.

- [ ] **Step 7: Sanitize transient state**

Run:

```bash
npx wrangler d1 execute staffbot_v2_staging \
  --remote \
  --file=./scripts/staging-sanitize.sql
```

Expected: the statements execute successfully.

- [ ] **Step 8: Verify transient tables are empty**

Run:

```bash
npx wrangler d1 execute staffbot_v2_staging --remote --command \
  "SELECT
     (SELECT COUNT(*) FROM admin_sessions) AS admin_sessions,
     (SELECT COUNT(*) FROM admin_login_codes) AS admin_login_codes,
     (SELECT COUNT(*) FROM user_states) AS user_states,
     (SELECT COUNT(*) FROM absence_fine_notifications) AS absence_notifications,
     (SELECT COUNT(*) FROM bot_logs) AS bot_logs;"
```

Expected: every returned count is `0`.

- [ ] **Step 9: Verify business-table counts**

Run the Step 1 count query against `staffbot_v2_staging`.

Expected: every business-table count matches the authoritative local snapshot counts from Step 4. A difference from the preliminary live diagnostic is acceptable only when production changed after export; a difference from the local snapshot is not acceptable.

- [ ] **Step 10: Verify staging migration state**

Run:

```bash
npx wrangler d1 migrations list staffbot_v2_staging --remote
```

Expected: staging reflects the same applied migrations as the imported production snapshot. Do not apply new payroll-ledger migrations in this plan.

- [ ] **Step 11: Remove the sensitive temporary export**

First verify the target:

```bash
test -n "${STAGING_EXPORT_DIR}"
test "${STAGING_EXPORT_DIR#"/private/tmp/staffbot-staging."}" != "${STAGING_EXPORT_DIR}"
ls -ld "${STAGING_EXPORT_DIR}"
```

Then remove only that exact temporary directory:

```bash
rm -rf -- "${STAGING_EXPORT_DIR}"
unset STAGING_EXPORT_DIR
```

Expected: the temporary SQL export is gone. This deletion is intentional because the file contains production data and staging already has a verified import.

---

### Task 6: Configure staging secrets without storing them in files

**Files:**

- No tracked file changes.

**Interfaces:**

- Consumes:
  - BotFather Token for `@staffbot_v2_staging_bot`.
  - The numeric Telegram ID from the `/start` update already sent to that bot.
- Produces staging-only secret names:
  - `BOT_TOKEN`
  - `WEBHOOK_SECRET`
  - `ADMIN_IDS`
  - `STAGING_ALLOWED_TELEGRAM_IDS`

This task contains a manual secret checkpoint. The user must enter the Bot Token in a private terminal prompt; it must not be pasted into Codex chat.

- [ ] **Step 1: Load the Bot Token into the current terminal without echo**

The user runs:

```bash
read -s "STAGING_BOT_TOKEN?Staging Bot Token: "
printf '\n'
```

Expected: the token is present only in the current shell variable and was not echoed.

- [ ] **Step 2: Read the queued `/start` update**

Run:

```bash
STAGING_ADMIN_ID="$(
  curl -fsS "https://api.telegram.org/bot${STAGING_BOT_TOKEN}/getUpdates" \
    | jq -r '[.result[]
      | select(.message.text == "/start")
      | .message.from.id][-1] // empty'
)"
test -n "${STAGING_ADMIN_ID}"
```

Expected: `STAGING_ADMIN_ID` contains the numeric sender ID of the `/start` message without printing the full Telegram update.

- [ ] **Step 3: Generate a dedicated webhook secret**

Run:

```bash
STAGING_WEBHOOK_SECRET="$(openssl rand -hex 32)"
```

Expected: a 64-character value exists in the current shell variable. Do not print it.

- [ ] **Step 4: Store the four staging secrets**

Run from the same terminal:

```bash
printf '%s' "${STAGING_BOT_TOKEN}" \
  | npx wrangler secret put BOT_TOKEN --env staging

printf '%s' "${STAGING_WEBHOOK_SECRET}" \
  | npx wrangler secret put WEBHOOK_SECRET --env staging

printf '%s' "${STAGING_ADMIN_ID}" \
  | npx wrangler secret put ADMIN_IDS --env staging

printf '%s' "${STAGING_ADMIN_ID}" \
  | npx wrangler secret put STAGING_ALLOWED_TELEGRAM_IDS --env staging
```

Expected: each secret is stored for `staffbot-v2-staging`.

- [ ] **Step 5: Verify secret names only**

Run:

```bash
npx wrangler secret list --env staging
```

Expected: all four names are present. The command must not reveal values.

- [ ] **Step 6: Keep variables only until webhook registration**

Do not unset the three shell variables yet. Task 7 uses them to register and verify the webhook without writing a file.

---

### Task 7: Deploy staging and connect the test Telegram bot

**Files:**

- No tracked file changes.

**Interfaces:**

- Consumes: configured staging bindings and current-shell secret variables from Task 6.
- Produces: deployed staging URL and Telegram webhook pointing only to that URL.

- [ ] **Step 1: Run the local verification gate**

Run:

```bash
npm run check
npm test
npm run test:staging
```

Expected: all checks pass.

- [ ] **Step 2: Confirm the Git diff contains no secret**

Run:

```bash
git status --short
git diff --check
git grep -nE '[0-9]{8,12}:[A-Za-z0-9_-]{30,}' -- . \
  ':(exclude)staffbot-v2-cloudflare/docs/superpowers/plans/2026-07-28-staging-environment.md'
```

Expected:

- Working tree contains only intentional changes.
- `git diff --check` is clean.
- `git grep` returns no Telegram-token-shaped value.

- [ ] **Step 3: Deploy only the staging environment**

Run:

```bash
npx wrangler deploy --env staging
```

Expected: Wrangler publishes `staffbot-v2-staging` to a `workers.dev` URL and reports no Cron triggers.

Set the expected environment URL:

```bash
STAGING_URL="https://staffbot-v2-staging.staffbot-v2.workers.dev"
```

Expected: the URL printed by Wrangler is exactly `${STAGING_URL}`. Stop if the account subdomain or Worker name differs; update the plan and runbook from verified output rather than guessing.

- [ ] **Step 4: Verify the staging health identity**

Run:

```bash
curl -fsS "${STAGING_URL}/"
```

Expected JSON:

```json
{
  "ok": true,
  "service": "staffbot-v2",
  "environment": "staging",
  "admin": "/admin"
}
```

- [ ] **Step 5: Verify the staging admin surface**

Run:

```bash
curl -fsS "${STAGING_URL}/admin"
```

Expected: HTTP 200 HTML containing `STAGING 测试环境`.

- [ ] **Step 6: Register the Telegram webhook**

Run from the Task 6 terminal:

```bash
curl -fsS \
  -X POST \
  "https://api.telegram.org/bot${STAGING_BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=${STAGING_URL}/webhook/${STAGING_WEBHOOK_SECRET}" \
  --data-urlencode "secret_token=${STAGING_WEBHOOK_SECRET}" \
  --data-urlencode "drop_pending_updates=true"
```

Expected: Telegram returns `"ok":true`.

`drop_pending_updates=true` intentionally removes the old `/start` update after its sender ID has already been recorded.

- [ ] **Step 7: Verify webhook ownership**

Run:

```bash
curl -fsS \
  "https://api.telegram.org/bot${STAGING_BOT_TOKEN}/getWebhookInfo"
```

Expected:

- URL begins with the exact `STAGING_URL`.
- URL does not contain the production Worker hostname.
- `last_error_message` is absent after a new test message.

- [ ] **Step 8: Clear local secret variables**

Run:

```bash
unset STAGING_BOT_TOKEN
unset STAGING_WEBHOOK_SECRET
unset STAGING_ADMIN_ID
```

Expected: no Bot Token or webhook secret remains in the current shell environment.

---

### Task 8: Run the staging end-to-end safety acceptance

**Files:**

- Create: `docs/STAGING_RUNBOOK.md`

**Interfaces:**

- Consumes: deployed staging URL, test Telegram bot, sanitized D1 copy.
- Produces: verified environment ready for refactoring work.

- [ ] **Step 1: Verify bot registration and copied identity**

Using `@staffbot_v2_staging_bot`:

1. Send `/start`.
2. Select language.
3. Confirm existing copied stores appear.
4. Confirm the staging user can select a store and open the normal menu.

Expected: the test bot responds using staging D1 data.

- [ ] **Step 2: Verify staging admin login**

1. Open `${STAGING_URL}/admin`.
2. Confirm the red `STAGING 测试环境` banner.
3. Enter the allowlisted Telegram numeric ID.
4. Request a login code.
5. Confirm the code arrives through `@staffbot_v2_staging_bot`.
6. Log in and inspect stores, employees, income, salary, attendance, leave, and absence pages.

Expected: copied business/history data is visible; no production bot is involved.

- [ ] **Step 3: Verify one complete income approval flow**

1. Submit a small test income through the staging bot.
2. Confirm only the allowlisted test account receives the admin approval notification.
3. Approve the request in staging.
4. Confirm the employee receives the approval message.
5. Confirm staging D1 contains the new `pending_income` decision and `income_records` row.

Expected: the flow completes entirely inside staging.

- [ ] **Step 4: Verify blocked-recipient evidence**

Run:

```bash
npx wrangler d1 execute staffbot_v2_staging --remote --command \
  "SELECT event, telegram_id, created_at
   FROM bot_logs
   WHERE event = 'staging_telegram_recipient_blocked'
   ORDER BY id DESC
   LIMIT 20;"
```

Expected: copied store administrators outside the allowlist may appear as blocked attempts, proving the network fence intercepted them. No blocked attempt should be recorded as `telegram_api_error`.

- [ ] **Step 5: Verify remote Cron remains disabled**

Check the `staffbot-v2-staging` Worker triggers in Cloudflare after deployment.

Expected:

- No remote Cron trigger exists.
- `SCHEDULED_TASKS_ENABLED` is `false` in the staging environment.
- `stores.absence_last_checked_date` did not advance merely because staging was deployed.

- [ ] **Step 6: Verify production remained untouched**

Run read-only checks:

```bash
curl -fsS "https://staffbot-v2.staffbot-v2.workers.dev/"
npx wrangler d1 migrations list staffbot_v2 --remote
```

Expected:

- Production health still responds normally.
- No production migration was applied.
- No production deployment was created by this plan.

- [ ] **Step 7: Write the staging runbook**

Create `docs/STAGING_RUNBOOK.md` with:

```markdown
# StaffBot Staging Runbook

## Resources

- Worker: `staffbot-v2-staging`
- D1: `staffbot_v2_staging`
- R2: `staffbot-v2-payroll-proofs-staging`
- Telegram: `@staffbot_v2_staging_bot`
- URL: `https://staffbot-v2-staging.staffbot-v2.workers.dev`

## Deploy

`npx wrangler deploy --env staging`

## Verify

- `npm run check`
- `npm test`
- `npm run test:staging`
- `GET /` returns `"environment":"staging"`
- `/admin` shows `STAGING 测试环境`
- Cloudflare has no staging Cron trigger

## Data refresh order

1. Export production D1 to a private `/private/tmp/staffbot-staging.*` directory.
2. Import only into `staffbot_v2_staging`.
3. Run `scripts/staging-sanitize.sql`.
4. Verify business counts and zero ephemeral counts.
5. Delete the exact temporary export directory.

## Safety invariants

- Never deploy staging without `--env staging`.
- Never use the production Bot Token.
- Never add a staging recipient without explicit approval.
- Never enable remote staging Cron during ordinary testing.
- Never commit production exports or secrets.
```

Verify that the concrete URL in the runbook matches the URL returned by the successful deployment. If Cloudflare returned a different account subdomain, update that line to the verified URL. Do not include secret values or numeric personal IDs.

- [ ] **Step 8: Run the final verification gate**

Run:

```bash
npm run check
npm test
npm run test:staging
git diff --check
git status --short
```

Expected: tests pass and only the runbook is uncommitted.

- [ ] **Step 9: Commit the verified runbook**

```bash
git add staffbot-v2-cloudflare/docs/STAGING_RUNBOOK.md
git commit -m "docs: record staging operations"
```

- [ ] **Step 10: Stop at the staging checkpoint**

Do not start modular refactoring in the same execution batch.

Report:

- Staging URL.
- Worker, D1 and R2 names.
- Test count.
- Business-count comparison result.
- Telegram webhook verification.
- Cron-disabled verification.
- Production-untouched verification.
- Any blocked-recipient log evidence.

Wait for the user to test and approve staging before writing or executing the modular-refactor implementation plan.
