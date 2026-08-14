# StaffBot Protective Tests and Modular Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Protect StaffBot's current payroll-related behavior with regression tests, then split the 5,307-line Worker entrypoint into focused JavaScript modules without changing business rules, database schema, HTTP responses, Telegram messages, or production state.

**Architecture:** Keep the existing native JavaScript ES-module runtime and introduce a one-direction dependency graph: the Worker router calls Telegram, admin, and Cron coordinators; coordinators call business services; services call D1 and low-level Telegram/audit helpers. Preserve `src/index.js` as a thin compatibility facade so every existing named import and the default Worker export continue to work while code is extracted in reviewable batches.

**Tech Stack:** Cloudflare Workers, Cloudflare D1, Telegram Bot API, JavaScript ES modules, Node.js built-in test runner, Node.js built-in SQLite test database.

## Global Constraints

- Work only on `codex/staging-environment` in the existing isolated worktree.
- Do not merge into `main`, push a branch, create a pull request, or deploy production during this plan.
- Staging deploys, when explicitly reached in Task 9, must include `--env staging`.
- Preserve every current income, fine, salary, salary-advance, attendance, absence, leave, registration, authentication, pagination, CSV, and Telegram behavior.
- Preserve current HTTP status codes and JSON shapes, including current legacy error behavior; reliability changes such as new `409` responses belong to the unified-ledger phase.
- Do not add a database migration or modify production/staging data structures.
- Do not add the unified `payroll_entries` table, Dashboard, personal payroll dates, payment proofs, email, or R2 application code.
- Do not rename database fields, user-visible strings, callback payloads, routes, or configuration variables.
- Keep native JavaScript ES modules; do not add TypeScript, a framework, a bundler, or a runtime dependency.
- Keep `src/index.js` default export and all currently exported named functions compatible until a separately approved breaking change.
- Move existing function bodies verbatim first. Readability edits are allowed only after the moved module passes focused and full tests, and they must be committed separately.
- Do not modify existing assertions merely to make an extraction pass. A failing existing test means the extraction changed behavior.
- A single refactor commit must not mix behavior changes with file movement.
- For source movements larger than 500 lines, use a deterministic marker-based extraction script and inspect the resulting diff instead of manually retyping the block.
- Run `npm run check` and `npm test` before every commit.
- Every task ends with one independently reviewable commit and a clean worktree.

## Verified Baseline

- Branch: `codex/staging-environment`
- Starting commit: `b34b6f2`
- Local `main`: `2560dbc`
- GitHub `origin/main`: `45685d3`
- Current source size: 5,307 lines in `src/index.js`
- Current test command: `node --test test/*.test.js`
- Current test count: 122 passing tests
- Repository contains no `.github/workflows` deployment workflow.
- `package.json` contains no deploy script.
- A local merge into `main` cannot deploy live; production changes require a separate production deploy or an external Git integration after a push.

---

## File Structure

### Entry and routing

- `src/index.js`
  - Thin compatibility facade.
  - Re-export the default Worker from `router.js`.
  - Re-export the current named test/public interfaces from their owning modules.
- `src/router.js`
  - Own `fetch` and `scheduled`.
  - Dispatch health, admin page, admin API, Telegram webhook, and scheduled absence work.
- `src/http.js`
  - Own response helpers, JSON parsing, cookie parsing, and response header constants.
  - Own the private admin session cookie name so callers do not duplicate it.

### Shared policy and data helpers

- `src/constants.js`
  - Own cross-module fixed values such as `DEFAULT_STORE_ID`.
- `src/security.js`
  - Own environment identity, Telegram allowlist policy, webhook configuration checks, browser security headers, login failure state, and admin-ID parsing.
- `src/money.js`
  - Own amount parsing/formatting, commission calculations, current `income_records` draft construction, and fine decision helpers.
- `src/dates.js`
  - Own store-timezone conversion, date ranges, leave-window validation, local business dates, and ISO-day arithmetic.
- `src/admin-query.js`
  - Own pagination, sort allowlists, store filters, range predicates, and CSV encoding.
- `src/stores.js`
  - Own store/member lookup and authorization queries shared by Telegram, admin API, approvals, and absence processing.
- `src/audit.js`
  - Own audit statements, persisted bot logs, error logging, payload redaction, and ID/time helpers.

### Business and delivery modules

- `src/i18n.js`
  - Own `TEXT`, Russian overrides, language lookup, and `render`.
- `src/telegram-client.js`
  - Own the low-level Telegram HTTP call plus send/edit/answer helpers.
  - Enforce the staging recipient allowlist at the only outbound network boundary.
- `src/payroll.js`
  - Own current-cycle total calculation and existing salary calculations only.
  - Do not add personal 30-day payroll behavior in this phase.
- `src/approvals.js`
  - Own current income, salary, advance, leave, checkout, and absence approval/rejection database operations.
- `src/absence.js`
  - Own absence scan dates, discovery, notification claims/retries, decisions, and leave cancellation reconciliation.
- `src/telegram.js`
  - Own Telegram update/message/callback orchestration, state transitions, commands, menus, and keyboards.
- `src/admin-api.js`
  - Own admin authentication and all `/api/admin/*` route handlers.
- `src/admin-page.js`
  - Own the existing self-contained admin HTML/CSS/JavaScript string.

### Tests and documentation

- `test/helpers/d1.js`
  - Reusable synchronous SQLite-to-D1 adapter with transactional `batch`.
- `test/approval-regression.test.js`
  - Characterize current income, salary, and advance approval writes and replay behavior.
- `test/worker-routing.test.js`
  - Characterize health, admin, webhook authentication, and scheduled-handler boundaries.
- Existing test files remain behavior contracts and continue importing from `src/index.js`.
- `docs/ARCHITECTURE.md`
  - Record module ownership, dependency direction, verification commands, and the boundary between this phase and later ledger work.

## Dependency Direction

```text
index.js
  ↓
router.js
  ├─ telegram.js
  ├─ admin-api.js
  ├─ admin-page.js
  └─ absence.js
       ↓
approvals.js / payroll.js / stores.js
       ↓
constants.js / money.js / dates.js / admin-query.js / audit.js / telegram-client.js
       ↓
Cloudflare bindings and external Telegram HTTP
```

The following imports are forbidden:

```text
business service → admin-page.js
money.js or dates.js → D1
payroll.js → Telegram text
admin-page.js → payroll calculations
telegram-client.js → telegram.js
low-level module → router.js or index.js
```

---

### Task 1: Freeze the current financial and Worker boundaries

**Files:**

- Create: `test/helpers/d1.js`
- Create: `test/approval-regression.test.js`
- Create: `test/worker-routing.test.js`
- Modify: `test/admin-pagination-leave.test.js:49-259`

**Interfaces:**

- Produces:

```js
createD1(database, hooks = {}) -> {
  prepare(sql) -> bound statement,
  batch(statements) -> Promise<Array<{ meta: { changes: number } }>>
}

adminRequest(worker, env, pathname, options = {}) -> Promise<Response>
```

- The D1 adapter must implement `bind`, `first`, `all`, `run`, and atomic `batch`.
- Existing absence test fixtures must use the shared adapter without changing their assertions.

- [ ] **Step 1: Extract the reusable D1 adapter**

Create `test/helpers/d1.js`:

```js
export function createD1(database, hooks = {}) {
  function prepare(sql) {
    let params = [];
    return {
      _sql: sql,
      bind(...values) {
        params = values;
        return this;
      },
      async first() {
        await hooks.beforeFirst?.(sql, params);
        const row = database.prepare(sql).get(...params) || null;
        await hooks.afterFirst?.(sql, row);
        return row;
      },
      async all() {
        await hooks.beforeAll?.(sql, params);
        return { results: database.prepare(sql).all(...params) };
      },
      async run() {
        await hooks.beforeRun?.(sql, params);
        return this._run();
      },
      _run() {
        const result = database.prepare(sql).run(...params);
        return {
          success: true,
          meta: { changes: Number(result.changes || 0) }
        };
      }
    };
  }

  return {
    prepare,
    async batch(statements) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const statement of statements) {
          await hooks.beforeBatchStatement?.(statement._sql);
          results.push(statement._run());
        }
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    }
  };
}
```

- [ ] **Step 2: Replace the duplicate adapter in the absence test**

Import the shared helper:

```js
import { createD1 } from './helpers/d1.js';
```

Replace calls to the local `d1TestDatabase(database, afterFirst, hooks)` with:

```js
createD1(database, {
  afterFirst,
  ...hooks
})
```

This preserves the existing `afterFirst`, `beforeFirst`, `beforeRun`, and `beforeBatchStatement` hook ordering used by the race/failure tests.

- [ ] **Step 3: Run the existing absence test**

Run:

```bash
node --test test/admin-pagination-leave.test.js
```

Expected: all existing tests in the file PASS with no assertion changes.

- [ ] **Step 4: Add a financial approval fixture**

In `test/approval-regression.test.js`, create an in-memory schema containing exactly the current columns used by:

```text
stores
store_members
admin_sessions
pending_income
income_records
salary_requests
salary_records
salary_advance_requests
admin_audit_logs
bot_logs
```

Use these table contracts:

```sql
CREATE TABLE stores (
  store_id TEXT PRIMARY KEY,
  name TEXT,
  status TEXT,
  timezone TEXT,
  currency TEXT
);
CREATE TABLE store_members (
  store_id TEXT,
  telegram_id TEXT,
  role TEXT,
  status TEXT,
  commission_rate REAL,
  cycle_start TEXT,
  updated_at TEXT,
  PRIMARY KEY (store_id, telegram_id)
);
CREATE TABLE admin_sessions (
  token TEXT PRIMARY KEY,
  telegram_id TEXT,
  expires_at TEXT
);
CREATE TABLE pending_income (
  request_id TEXT PRIMARY KEY,
  store_id TEXT,
  telegram_id TEXT,
  income REAL,
  commission_rate REAL,
  commission_income REAL,
  fine REAL,
  status TEXT,
  submitted_at TEXT,
  decided_at TEXT,
  admin_id TEXT,
  reject_reason TEXT
);
CREATE TABLE income_records (
  record_id TEXT PRIMARY KEY,
  store_id TEXT,
  telegram_id TEXT,
  income REAL,
  commission_rate REAL,
  commission_income REAL,
  original_fine REAL,
  fine REAL,
  type TEXT,
  source TEXT,
  request_id TEXT,
  approved_at TEXT,
  admin_id TEXT
);
CREATE TABLE salary_requests (
  request_id TEXT PRIMARY KEY,
  store_id TEXT,
  telegram_id TEXT,
  amount_snapshot REAL,
  status TEXT,
  requested_at TEXT,
  decided_at TEXT,
  admin_id TEXT,
  reject_reason TEXT
);
CREATE TABLE salary_records (
  record_id TEXT PRIMARY KEY,
  store_id TEXT,
  telegram_id TEXT,
  amount REAL,
  period_start TEXT,
  period_end TEXT,
  approved_at TEXT,
  admin_id TEXT,
  request_id TEXT
);
CREATE TABLE salary_advance_requests (
  request_id TEXT PRIMARY KEY,
  store_id TEXT,
  telegram_id TEXT,
  amount REAL,
  status TEXT,
  requested_at TEXT,
  decided_at TEXT,
  admin_id TEXT,
  reject_reason TEXT
);
CREATE TABLE admin_audit_logs (
  id INTEGER PRIMARY KEY,
  store_id TEXT,
  admin_id TEXT,
  action TEXT,
  target_id TEXT,
  details_json TEXT,
  created_at TEXT
);
CREATE TABLE bot_logs (
  id INTEGER PRIMARY KEY,
  store_id TEXT,
  level TEXT,
  event TEXT,
  telegram_id TEXT,
  message_text TEXT,
  payload_json TEXT,
  created_at TEXT
);
```

Seed:

```js
const now = new Date(Date.now() + 60_000).toISOString();
database.prepare(`
  INSERT INTO stores
    (store_id, name, status, timezone, currency)
  VALUES ('STORE1', 'Store One', 'active', 'Asia/Tokyo', '$')
`).run();
database.prepare(`
  INSERT INTO store_members
    (store_id, telegram_id, role, status, commission_rate, cycle_start)
  VALUES ('STORE1', 'EMP1', 'employee', 'active', 0.6, '2026-07-01T00:00:00.000Z')
`).run();
database.prepare(`
  INSERT INTO admin_sessions (token, telegram_id, expires_at)
  VALUES ('TOKEN1', 'ADMIN1', ?)
`).run(now);
```

Use this request helper:

```js
function adminRequest(worker, env, pathname, options = {}) {
  return worker.fetch(new Request(`https://staffbot.test${pathname}`, {
    method: options.method || 'POST',
    headers: {
      cookie: 'staffbot_admin_session=TOKEN1',
      'content-type': 'application/json'
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  }), env, { waitUntil() {} });
}
```

- [ ] **Step 5: Write the current income approval behavior test**

The test must seed one pending income with a non-zero fine, call:

```text
POST /api/admin/stores/STORE1/income/INC1/approve
```

Assert:

```js
assert.equal(response.status, 200);
assert.deepEqual(await response.json(), { ok: true });
assert.deepEqual(
  database.prepare(`
    SELECT type, source, income, commission_income, fine, request_id
    FROM income_records
    WHERE request_id = 'INC1'
    ORDER BY type
  `).all(),
  [
    {
      type: 'fine',
      source: 'manual_fine',
      income: 0,
      commission_income: 0,
      fine: 5,
      request_id: 'INC1'
    },
    {
      type: 'income',
      source: 'manual',
      income: 100,
      commission_income: 60,
      fine: 0,
      request_id: 'INC1'
    }
  ]
);
```

Call the same route a second time and assert the current compatibility behavior:

```js
assert.equal(replay.status, 200);
assert.deepEqual(await replay.json(), { ok: false });
assert.equal(
  database.prepare(`SELECT COUNT(*) AS count FROM income_records WHERE request_id = 'INC1'`).get().count,
  2
);
```

- [ ] **Step 6: Write current salary-advance and salary approval tests**

For an approved advance, assert one record:

```js
{
  type: 'advance',
  source: 'salary_advance',
  commission_income: 0,
  original_fine: 20,
  fine: 20,
  request_id: 'ADV1'
}
```

For a salary approval, seed:

```text
income +60
fine   -5
advance -20
```

Then assert the current salary record amount is `35`, its `period_start` equals the member's prior `cycle_start`, and `store_members.cycle_start` advances to the same timestamp as the salary record's `period_end`. Replay must not create a second salary record.

- [ ] **Step 7: Add Worker route boundary tests**

In `test/worker-routing.test.js`, assert:

```text
GET /                          → 200 and environment identity
GET /admin                     → 200 HTML and environment marker
POST /webhook/wrong            → 404
POST /webhook/correct + wrong x-telegram-bot-api-secret-token → 403
POST /webhook/correct + matching header and update_id only     → 200 {"ok":true}
scheduled() with SCHEDULED_TASKS_ENABLED=false                 → no queued work
```

Use an update without `message` or `callback_query` so this route test does not need Telegram flow fixtures.

- [ ] **Step 8: Verify the new protection layer**

Run:

```bash
node --test test/approval-regression.test.js test/worker-routing.test.js
npm run check
npm test
```

Expected: focused tests PASS; full suite reports the previous 122 tests plus the new tests, all passing.

- [ ] **Step 9: Commit the characterization tests**

```bash
git add staffbot-v2-cloudflare/test/helpers/d1.js \
  staffbot-v2-cloudflare/test/approval-regression.test.js \
  staffbot-v2-cloudflare/test/worker-routing.test.js \
  staffbot-v2-cloudflare/test/admin-pagination-leave.test.js
git commit -m "test: protect current payroll and worker behavior"
```

---

### Task 2: Extract pure policy and calculation modules

**Files:**

- Create: `src/constants.js`
- Create: `src/security.js`
- Create: `src/money.js`
- Create: `src/dates.js`
- Create: `src/admin-query.js`
- Create: `src/http.js`
- Create: `src/validation.js`
- Modify: `src/index.js`

**Interfaces:**

- `security.js` exports:

```js
serviceEnvironment
parseTelegramAllowlist
isTelegramRecipientAllowed
scheduledTasksEnabled
isWebhookConfigReady
webhookSecretMatches
securityHeaders
nextLoginFailureState
adminIds
isGlobalAdmin
```

- `constants.js` exports:

```js
export const DEFAULT_STORE_ID = 'DEFAULT';
```

- `money.js` exports:

```js
parseStoreAmount
attendanceFineAmount
formatMoney
formatAdminMoney
calculateSalaryAmount
calculateCommissionIncome
calculateNetIncome
calculateIncomeRowsTotal
absenceFineRecordDraft
approvedIncomeRecordDrafts
checkoutFineWaiverAmount
checkoutFineRecordDrafts
attendanceAdminActions
attendanceFineDecision
normalizeCommissionRate
formatPercent
```

- `dates.js` exports:

```js
dateRange
formatAdminDateTime
formatAdminShortDateHour
validateLeaveDate
leaveDateOptions
leaveMonthRange
leaveRuleParams
completedAttendanceDate
absenceScanDates
localDate
localTime
getBusinessDate
minutesOf
zonedMidnightIso
addIsoDays
```

- `admin-query.js` exports:

```js
adminPage
visibleAdminStores
currentAdminStoreId
adminStoreWhere
memberListQuery
adminOrderSql
adminSortColumns
absenceAdminSortColumns
resetAdminSortPages
sumAttendanceEmployeeStats
addRangeFilter
placeholders
csvCell
toCsv
```

- `http.js` exports:

```js
JSON_HEADERS
HTML_HEADERS
TEXT_HEADERS
CSV_HEADERS
readJson
json
html
cookieValue
setSessionCookie
clearSessionCookie
```

- [ ] **Step 1: Add direct module tests before moving implementations**

Keep all existing tests importing from `src/index.js`. Add one focused import per target module:

```js
import {
  calculateIncomeRowsTotal as moduleCalculateIncomeRowsTotal
} from '../src/money.js';
```

Write an identity assertion using the existing fixture:

```js
assert.equal(
  moduleCalculateIncomeRowsTotal([
    { commission_income: 60, fine: 0 },
    { commission_income: 0, fine: 5 }
  ]),
  55
);
```

Repeat this pattern for `dateRange`, `serviceEnvironment`, `adminOrderSql`, and `json`. The tests must initially fail because the modules do not exist.

- [ ] **Step 2: Run focused tests and verify the red state**

Run:

```bash
node --test test/money.test.js test/security.test.js test/admin-pagination-leave.test.js test/worker-routing.test.js
```

Expected: FAIL with module-not-found errors for the new files.

- [ ] **Step 3: Move pure functions without rewriting them**

Move the current function bodies and their private helpers into the owning files. Shared constants stay with their only owner. Resolve dependencies with explicit imports:

```js
// src/http.js
import { securityHeaders } from './security.js';

export const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
export const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  ...securityHeaders()
};
```

```js
// src/dates.js
import { normalizePositiveInt } from './validation.js';
```

Create `src/validation.js` containing `normalizePositiveInt` and `validTime`, because the current store normalization and leave-window rules both consume them. Do not create a generic `utils.js`.

- [ ] **Step 4: Preserve the compatibility facade**

Add re-exports in `src/index.js`:

```js
export * from './security.js';
export * from './money.js';
export * from './dates.js';
export * from './admin-query.js';
```

Remove the original definitions from `src/index.js` only after the imports and re-exports compile.

- [ ] **Step 5: Verify module syntax and behavior**

Run:

```bash
node --check src/security.js
node --check src/money.js
node --check src/dates.js
node --check src/admin-query.js
node --check src/http.js
npm run check
npm test
```

Expected: all tests PASS; no user-visible output or SQL changes appear in the diff.

- [ ] **Step 6: Review the movement-only diff**

Run:

```bash
git diff --stat
git diff --check
git diff -- src/index.js src/security.js src/money.js src/dates.js src/admin-query.js src/http.js
```

Reject the extraction if an existing string, SQL predicate, calculation, error code, or side-effect order changed.

- [ ] **Step 7: Commit**

```bash
git add staffbot-v2-cloudflare/src/index.js \
  staffbot-v2-cloudflare/src/constants.js \
  staffbot-v2-cloudflare/src/security.js \
  staffbot-v2-cloudflare/src/money.js \
  staffbot-v2-cloudflare/src/dates.js \
  staffbot-v2-cloudflare/src/admin-query.js \
  staffbot-v2-cloudflare/src/http.js \
  staffbot-v2-cloudflare/src/validation.js \
  staffbot-v2-cloudflare/test/money.test.js \
  staffbot-v2-cloudflare/test/security.test.js \
  staffbot-v2-cloudflare/test/admin-pagination-leave.test.js \
  staffbot-v2-cloudflare/test/worker-routing.test.js
git commit -m "refactor: extract shared policy and calculation modules"
```

---

### Task 3: Extract translations and the Telegram network boundary

**Files:**

- Create: `src/i18n.js`
- Create: `src/telegram-client.js`
- Create: `src/audit.js`
- Modify: `src/index.js`
- Modify: `test/money.test.js`
- Modify: `test/security.test.js`

**Interfaces:**

- `i18n.js` exports:

```js
LANGS
t(lang, key) -> string
render(lang, key, params = {}) -> string
allLangLabels(lang, key) -> Array<string>
```

- `telegram-client.js` exports:

```js
telegram(env, method, payload) -> Promise<object>
sendMessage(env, chatId, text, replyMarkup) -> Promise<object>
answerCallback(env, callbackQueryId, text = '', showAlert = false) -> Promise<object>
editCallbackMessage(env, callback, text) -> Promise<object>
```

- [ ] **Step 1: Add direct contract tests**

In `test/money.test.js`, import `render` directly from `i18n.js` and assert the existing four-language messages used in the test.

In `test/security.test.js`, import `telegram` directly from `telegram-client.js` and run the existing allowlist/no-fetch test against it.

- [ ] **Step 2: Verify the tests fail before extraction**

Run:

```bash
node --test test/money.test.js test/security.test.js
```

Expected: FAIL because `i18n.js` and `telegram-client.js` do not exist.

- [ ] **Step 3: Extract `TEXT`, `RU_TEXT`, and render helpers mechanically**

Use fixed source markers:

```text
start: const TEXT = {
end:   for (const [key, value] of Object.entries(RU_TEXT))
```

Move that block into `src/i18n.js`, then move `t`, `render`, and `allLangLabels`. Preserve every byte of user-visible text. Export `LANGS` from the same file.

The module footer must be:

```js
for (const [key, value] of Object.entries(RU_TEXT)) {
  if (TEXT[key]) TEXT[key].ru = value;
}

export function t(lang, key) {
  return (TEXT[key] && (TEXT[key][lang] || TEXT[key].zh)) || key;
}

export function render(lang, key, params) {
  let text = t(lang, key);
  for (const [name, value] of Object.entries(params || {})) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}
```

- [ ] **Step 4: Extract the outbound Telegram client**

Move the current `telegram`, `sendMessage`, `answerCallback`, and `editCallbackMessage` implementations. Import:

```js
import { JSON_HEADERS } from './http.js';
import { isTelegramRecipientAllowed } from './security.js';
import { logEvent } from './audit.js';
```

Create `audit.js` now with `sanitizeLogPayload`, `logEvent`, and `logError`; Task 4 will add audit-statement ownership.

- [ ] **Step 5: Re-export compatibility names**

In `src/index.js`:

```js
export { render } from './i18n.js';
export { telegram } from './telegram-client.js';
```

Internal code must import directly from the owner modules, not through `index.js`.

- [ ] **Step 6: Verify exact text and network behavior**

Run:

```bash
node --check src/i18n.js
node --check src/telegram-client.js
node --test test/money.test.js test/security.test.js
npm run check
npm test
```

Expected: all tests PASS; staging non-allowlisted sends still do not call `fetch`.

- [ ] **Step 7: Commit**

```bash
git add staffbot-v2-cloudflare/src/index.js \
  staffbot-v2-cloudflare/src/i18n.js \
  staffbot-v2-cloudflare/src/telegram-client.js \
  staffbot-v2-cloudflare/src/audit.js \
  staffbot-v2-cloudflare/test/money.test.js \
  staffbot-v2-cloudflare/test/security.test.js
git commit -m "refactor: extract telegram text and delivery"
```

---

### Task 4: Extract store access, current payroll queries, and approval services

**Files:**

- Create: `src/stores.js`
- Create: `src/payroll.js`
- Create: `src/approvals.js`
- Modify: `src/audit.js`
- Modify: `src/index.js`
- Modify: `test/approval-regression.test.js`

**Interfaces:**

- `stores.js` exports:

```js
isAnyAdmin
isStoreAdmin
getStore
getStoreForMember
getMemberDisplayName
listMemberStores
listActiveStores
resolveStoreForUser
```

- `payroll.js` exports:

```js
getTotalIncome(env, storeId, telegramId) -> Promise<number>
getMemberCommissionRate(env, storeId, telegramId) -> Promise<number>
calculateSalaryAmount
```

- `approvals.js` exports the existing operations:

```js
approveIncomeRequest
rejectIncomeRequest
approveSalaryRequest
rejectSalaryRequest
approveSalaryAdvanceRequest
rejectSalaryAdvanceRequest
approveLeaveRequest
rejectLeaveRequest
approveCheckoutRequest
rejectCheckoutRequest
approveAbsenceFineRequest
rejectAbsenceFineRequest
cancelAbsenceForApprovedLeave
```

- All functions preserve their current return objects and side-effect order.

- [ ] **Step 1: Point financial regression tests at service interfaces**

Add direct imports:

```js
import {
  approveIncomeRequest,
  approveSalaryAdvanceRequest,
  approveSalaryRequest
} from '../src/approvals.js';
import { getTotalIncome } from '../src/payroll.js';
```

Keep the Worker route assertions. Add service assertions using fresh fixtures so both the direct business interface and HTTP integration are protected.

- [ ] **Step 2: Verify the direct imports fail**

Run:

```bash
node --test test/approval-regression.test.js
```

Expected: FAIL because `approvals.js` and `payroll.js` do not exist.

- [ ] **Step 3: Complete audit ownership**

Move these existing functions into `src/audit.js`:

```js
audit
auditStatement
logEvent
logError
sanitizeLogPayload
makeId
makeStoreId
nowIso
safeJson
```

Keep `sanitizeLogPayload` and `makeStoreId` re-exported from `src/index.js`.

- [ ] **Step 4: Extract store/member reads**

Move only shared read/authorization helpers into `stores.js`. Keep user state, registration state transitions, and store chooser rendering in `telegram.js` later.

Use direct dependencies:

```js
import { adminIds, isGlobalAdmin } from './security.js';
```

- [ ] **Step 5: Extract current payroll calculation**

Move `getTotalIncome` with its existing SQL unchanged:

```sql
SELECT COALESCE(SUM(commission_income - fine), 0) AS total
FROM income_records
WHERE store_id = ? AND telegram_id = ? AND approved_at >= ?
```

The `cycle_start` lookup and empty-member fallback must remain identical. Do not introduce `amount_micros` or change the formula in this task.

- [ ] **Step 6: Extract approvals without reliability redesign**

Move existing approval/rejection functions and their SQL verbatim. Import only:

```js
import { audit, auditStatement, makeId, nowIso } from './audit.js';
import {
  absenceFineRecordDraft,
  approvedIncomeRecordDrafts
} from './money.js';
import { getStore } from './stores.js';
import { getTotalIncome } from './payroll.js';
```

Do not add conditional updates, unique constraints, `409` behavior, or ledger writes here. Those are intentionally deferred to the unified-ledger plan where they can be changed atomically.

- [ ] **Step 7: Re-export existing named interfaces**

In `src/index.js`:

```js
export {
  approveAbsenceFineRequest,
  approveLeaveRequest,
  cancelAbsenceForApprovedLeave,
  rejectAbsenceFineRequest
} from './approvals.js';
```

Other approval functions may stay module-only unless an existing test/public import requires compatibility.

- [ ] **Step 8: Run focused and full verification**

Run:

```bash
node --check src/audit.js
node --check src/stores.js
node --check src/payroll.js
node --check src/approvals.js
node --test test/approval-regression.test.js test/money.test.js test/security.test.js
npm run check
npm test
```

Expected: all tests PASS and the seeded records are byte-for-byte equivalent in type/source/amount fields.

- [ ] **Step 9: Commit**

```bash
git add staffbot-v2-cloudflare/src/index.js \
  staffbot-v2-cloudflare/src/audit.js \
  staffbot-v2-cloudflare/src/stores.js \
  staffbot-v2-cloudflare/src/payroll.js \
  staffbot-v2-cloudflare/src/approvals.js \
  staffbot-v2-cloudflare/test/approval-regression.test.js
git commit -m "refactor: extract payroll approval services"
```

---

### Task 5: Extract absence scanning and notification delivery

**Files:**

- Create: `src/absence.js`
- Modify: `src/index.js`
- Modify: `test/admin-pagination-leave.test.js`

**Interfaces:**

- `absence.js` exports:

```js
ABSENCE_PENDING_COLUMNS
ABSENCE_HISTORY_COLUMNS
absenceApprovalKeyboard
absenceScanDates
completedAttendanceDate
processAbsenceFines
deliverAbsenceNotification
approveAbsenceFineRequest
rejectAbsenceFineRequest
cancelAbsenceForApprovedLeave
```

- Approval functions may be re-exported from `approvals.js`; `absence.js` must not duplicate their implementation.

- [ ] **Step 1: Add direct module imports to the existing absence suite**

Change a representative subset to import from `absence.js`:

```js
import {
  absenceScanDates,
  deliverAbsenceNotification,
  processAbsenceFines
} from '../src/absence.js';
```

Keep the same functions imported from `index.js` under compatibility aliases and assert both references produce the same pure results.

- [ ] **Step 2: Verify the red state**

Run:

```bash
node --test test/admin-pagination-leave.test.js
```

Expected: FAIL because `absence.js` does not exist.

- [ ] **Step 3: Move the absence module**

Move:

```text
absence constants and keyboard
completedAttendanceDate
absenceScanDates
processAbsenceFines
deliverAbsenceNotification
cancelAbsenceNotification
absence decision and approved-leave reconciliation orchestration
```

Use:

```js
import { nowIso, makeId } from './audit.js';
import { addIsoDays, localDate, zonedMidnightIso } from './dates.js';
import { attendanceFineAmount, formatMoney } from './money.js';
import {
  approveAbsenceFineRequest,
  cancelAbsenceForApprovedLeave,
  rejectAbsenceFineRequest
} from './approvals.js';
import { adminIds } from './security.js';
import { isStoreAdmin } from './stores.js';
import { sendMessage } from './telegram-client.js';
```

This dependency direction prevents a cycle: absence delivery may use the low-level client, but it must not import the high-level `telegram.js` flow.

- [ ] **Step 4: Preserve the existing public facade**

Re-export absence interfaces from `src/index.js`. Remove the original definitions only after the direct and compatibility imports both pass.

- [ ] **Step 5: Run the race, retry, and full suites**

Run:

```bash
node --test test/admin-pagination-leave.test.js
npm run check
npm test
```

Expected: every existing absence race, transaction rollback, notification lease, retry, cancellation, and store-timezone test PASS unchanged.

- [ ] **Step 6: Commit**

```bash
git add staffbot-v2-cloudflare/src/index.js \
  staffbot-v2-cloudflare/src/absence.js \
  staffbot-v2-cloudflare/test/admin-pagination-leave.test.js
git commit -m "refactor: extract absence processing"
```

---

### Task 6: Extract the Telegram state machine

**Files:**

- Create: `src/telegram.js`
- Modify: `src/index.js`
- Modify: `test/worker-routing.test.js`
- Create: `test/telegram-flow.test.js`

**Interfaces:**

- `telegram.js` exports:

```js
handleUpdate(update, env) -> Promise<unknown>
attendanceActionReplyMarkup
checkoutApprovalKeyboard
compactCallbackData
incomeAdminNotificationText
```

- Private ownership includes:

```text
handleMessage
handleCallback
income submission flow
manual salary request flow
salary advance submission flow
leave submission flow
attendance check-in/out flow
registration flow
user-state persistence
command matching
menus and inline keyboards
```

- [ ] **Step 1: Add high-value Telegram flow tests**

Create `test/telegram-flow.test.js` with a minimal D1 fixture and mocked `globalThis.fetch`. Cover:

```text
/ping returns the existing pong message
/start for a known active employee returns the existing welcome text and main keyboard
/total returns the existing store name and current total
/cancel clears an active user state and sends the existing cancelled text
an unknown command sends the existing unknown-command text
```

Capture Telegram payloads:

```js
const payloads = [];
globalThis.fetch = async (_url, options) => {
  payloads.push(JSON.parse(options.body));
  return { json: async () => ({ ok: true }) };
};
```

Assert exact `text` and relevant `reply_markup` fields, not only call count.

- [ ] **Step 2: Run the new flow tests against the current Worker**

Initially import `handleUpdate` from `src/index.js`. Add that named facade export before moving its implementation.

Run:

```bash
node --test test/telegram-flow.test.js
```

Expected: PASS against the monolith, establishing a pre-move baseline.

- [ ] **Step 3: Move the Telegram flow**

Move the functions listed under private ownership into `src/telegram.js`. Import business services directly:

```js
import * as approvals from './approvals.js';
import * as absence from './absence.js';
import * as payroll from './payroll.js';
import * as stores from './stores.js';
import { render, t, allLangLabels } from './i18n.js';
import {
  answerCallback,
  editCallbackMessage,
  sendMessage
} from './telegram-client.js';
```

Use named imports rather than module namespaces in final code once the moved call graph is stable. The namespace form is only an intermediate extraction aid.

- [ ] **Step 4: Keep callback data and messages exact**

Compare:

```bash
git diff --word-diff=porcelain -- src/index.js src/telegram.js src/i18n.js
```

Verify no literal callback prefixes, command aliases, language strings, or reply keyboards changed.

- [ ] **Step 5: Point the router call at `handleUpdate`**

The webhook path must call:

```js
await handleUpdate(update, env);
```

from `telegram.js`. Preserve `logEvent` scheduling and the current error-catching boundary.

- [ ] **Step 6: Verify**

Run:

```bash
node --check src/telegram.js
node --test test/telegram-flow.test.js test/worker-routing.test.js test/money.test.js test/security.test.js
npm run check
npm test
```

Expected: all tests PASS and blocked staging recipients still never reach network fetch.

- [ ] **Step 7: Commit**

```bash
git add staffbot-v2-cloudflare/src/index.js \
  staffbot-v2-cloudflare/src/telegram.js \
  staffbot-v2-cloudflare/test/telegram-flow.test.js \
  staffbot-v2-cloudflare/test/worker-routing.test.js
git commit -m "refactor: extract telegram workflow"
```

---

### Task 7: Extract the admin API

**Files:**

- Create: `src/admin-api.js`
- Modify: `src/index.js`
- Modify: `test/approval-regression.test.js`
- Modify: `test/admin-pagination-leave.test.js`

**Interfaces:**

- `admin-api.js` exports:

```js
handleAdminApi(request, env, url, ctx) -> Promise<Response>
attendanceEmployeeStats(env, filters, now = new Date()) -> Promise<object>
normalizeAbsenceFineSetting(input, currentStore = {}, now = new Date()) -> object
normalizeEmployeeAbsenceCheck(input, currentMember, now = new Date()) -> object
```

- Private ownership includes login/session handling, store/member endpoints, income/salary/advance/attendance/absence/leave endpoints, exports, and paged list queries.

- [ ] **Step 1: Add a direct handler contract**

In `test/worker-routing.test.js`:

```js
import { handleAdminApi } from '../src/admin-api.js';
```

Use the existing authenticated fixture to assert:

```text
GET /api/admin/me → current JSON shape
unknown /api/admin path → 404 not_found
unauthenticated protected path → 401 unauthorized
```

- [ ] **Step 2: Verify the direct import fails**

Run:

```bash
node --test test/worker-routing.test.js
```

Expected: FAIL because `admin-api.js` does not exist.

- [ ] **Step 3: Extract the API in functional groups**

Move in this order, running focused tests after each group:

```text
1. session/login helpers
2. store/member handlers
3. income/salary/advance handlers
4. attendance/absence/leave handlers
5. CSV export and paged query orchestration
```

Use direct imports from `approvals.js`, `absence.js`, `admin-query.js`, `dates.js`, `http.js`, `money.js`, `security.js`, `stores.js`, and `audit.js`.

Do not import the Worker facade:

```js
// forbidden
import worker from './index.js';
```

- [ ] **Step 4: Preserve API route and response contracts**

The router continues to dispatch any path starting with `/api/admin/` to:

```js
return handleAdminApi(request, env, url, ctx);
```

Existing approval endpoints must continue to return their current statuses and JSON until the ledger phase explicitly changes concurrency/error semantics.

Re-export `attendanceEmployeeStats`, `normalizeAbsenceFineSetting`, and `normalizeEmployeeAbsenceCheck` from `src/index.js` so the existing named-import contracts remain intact.

- [ ] **Step 5: Run focused API tests after each movement group**

Run:

```bash
node --test test/approval-regression.test.js test/admin-pagination-leave.test.js test/worker-routing.test.js
```

Expected: PASS after every group; do not wait until the entire API has moved to discover a regression.

- [ ] **Step 6: Run full verification**

```bash
node --check src/admin-api.js
npm run check
npm test
```

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add staffbot-v2-cloudflare/src/index.js \
  staffbot-v2-cloudflare/src/admin-api.js \
  staffbot-v2-cloudflare/test/approval-regression.test.js \
  staffbot-v2-cloudflare/test/admin-pagination-leave.test.js \
  staffbot-v2-cloudflare/test/worker-routing.test.js
git commit -m "refactor: extract admin api"
```

---

### Task 8: Extract the admin page and make the Worker entrypoint thin

**Files:**

- Create: `src/admin-page.js`
- Create: `src/router.js`
- Modify: `src/index.js`
- Modify: `test/admin-pagination-leave.test.js`
- Modify: `test/security.test.js`
- Modify: `test/worker-routing.test.js`

**Interfaces:**

- `admin-page.js` exports:

```js
adminHtml(env) -> string
```

- `router.js` default export:

```js
{
  fetch(request, env, ctx) -> Promise<Response>,
  scheduled(controller, env, ctx) -> Promise<void>
}
```

- `index.js` becomes a facade:

```js
export { default } from './router.js';
export * from './security.js';
export * from './money.js';
export * from './dates.js';
export * from './admin-query.js';
export * from './absence.js';
export * from './telegram-client.js';
export { render } from './i18n.js';
```

- [ ] **Step 1: Protect the full admin document**

Add a normalization helper in the test only:

```js
function normalizedHtml(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}
```

Before extraction, obtain `/admin` from the current Worker and assert the page contains all current navigation tab IDs, environment marker, security policy, filter controls, and critical action selectors. Do not snapshot timestamps or other runtime-varying values.

- [ ] **Step 2: Extract the large page with deterministic markers**

Use:

```text
start marker: function adminHtml(env) {
end marker:   final closing brace at end of src/index.js
```

Create a temporary local marker-based extraction script that:

1. Reads `src/index.js`.
2. Verifies each marker occurs exactly once.
3. Writes the exact block to `src/admin-page.js`.
4. Adds only the required imports.
5. Removes the original block.
6. Fails without writing if either marker count is not one.

Delete the temporary script before committing. Inspect the moved block with whitespace-insensitive diff; do not manually retype the embedded HTML/CSS/JavaScript.

- [ ] **Step 3: Create the router**

Move the default Worker object to `src/router.js` and import:

```js
import { handleAdminApi } from './admin-api.js';
import { adminHtml } from './admin-page.js';
import { processAbsenceFines } from './absence.js';
import { logEvent } from './audit.js';
import { html, json } from './http.js';
import {
  isWebhookConfigReady,
  scheduledTasksEnabled,
  serviceEnvironment,
  webhookSecretMatches
} from './security.js';
import { handleUpdate } from './telegram.js';
```

Keep route order, status codes, logging calls, and `ctx.waitUntil` behavior unchanged.

- [ ] **Step 4: Reduce `src/index.js` to compatibility exports**

No business function or HTML literal remains in `index.js`. The default import used by Wrangler and all existing named imports used by tests must still resolve.

- [ ] **Step 5: Add an architectural size guard**

In `test/worker-routing.test.js`:

```js
const indexSource = await readFile(
  new URL('../src/index.js', import.meta.url),
  'utf8'
);

test('keeps the Worker entrypoint as a compatibility facade', () => {
  assert.equal(indexSource.includes('async function handleAdminApi'), false);
  assert.equal(indexSource.includes('function adminHtml'), false);
  assert.equal(indexSource.includes('const TEXT ='), false);
  assert.ok(indexSource.split('\n').length < 120);
});
```

This guard checks only the agreed architectural boundary, not internal formatting.

- [ ] **Step 6: Run full static and behavioral verification**

Run:

```bash
for file in src/*.js; do node --check "$file"; done
npm run check
npm test
git diff --check
```

Expected: every source module parses, all tests PASS, and `src/index.js` is under 120 lines.

- [ ] **Step 7: Commit**

```bash
git add staffbot-v2-cloudflare/src/index.js \
  staffbot-v2-cloudflare/src/router.js \
  staffbot-v2-cloudflare/src/admin-page.js \
  staffbot-v2-cloudflare/test/admin-pagination-leave.test.js \
  staffbot-v2-cloudflare/test/security.test.js \
  staffbot-v2-cloudflare/test/worker-routing.test.js
git commit -m "refactor: make worker entrypoint a thin facade"
```

---

### Task 9: Document, deploy to staging, and run the phase gate

**Files:**

- Create: `docs/ARCHITECTURE.md`
- Modify: `docs/STAGING_RUNBOOK.md`

**Interfaces:**

- Documents the module map, allowed dependency direction, test commands, staging-only deployment command, and explicit handoff to the ledger phase.

- [ ] **Step 1: Write the architecture document**

Include this module table:

```markdown
| Module | Owns | Must not own |
| --- | --- | --- |
| router.js | Worker entrypoints and dispatch | business calculations |
| telegram.js | bot state and interaction flow | raw admin HTML |
| telegram-client.js | Telegram HTTP delivery and staging fence | business decisions |
| admin-api.js | authenticated admin routes | browser rendering logic |
| admin-page.js | admin HTML/CSS/JS | payroll SQL |
| approvals.js | existing approval state transitions | Telegram copy |
| payroll.js | current payroll queries | payment UI |
| absence.js | absence scan and delivery lifecycle | general admin routing |
| money.js | pure legacy money calculations | D1 access |
| dates.js | pure timezone/date calculations | D1 access |
```

State explicitly:

```text
The source of truth is still income_records during this phase.
payroll_entries and amount_micros begin only in the next approved phase.
```

- [ ] **Step 2: Update the staging runbook**

Add the phase-2 verification order:

```bash
npm run check
npm test
npx wrangler deploy --env staging
curl -fsS https://staffbot-v2-staging.staffbot-v2.workers.dev/
```

Record that no command without `--env staging` is permitted in this phase.

- [ ] **Step 3: Run local final verification**

Run:

```bash
npm run check
npm test
git status --short
git diff --check
```

Expected: all tests PASS and only the two documentation files remain uncommitted.

- [ ] **Step 4: Commit documentation**

```bash
git add staffbot-v2-cloudflare/docs/ARCHITECTURE.md \
  staffbot-v2-cloudflare/docs/STAGING_RUNBOOK.md
git commit -m "docs: record modular worker architecture"
```

- [ ] **Step 5: Deploy only the staging environment**

Run:

```bash
npx wrangler deploy --env staging
```

Expected: deployment target is `staffbot-v2-staging`, never `staffbot-v2`.

- [ ] **Step 6: Run staging smoke tests**

Verify:

```text
GET / returns environment=staging
GET /admin loads and identifies staging
admin login/code/me/logout succeeds with the staging bot
/start, /total, income submission, and approval use only allowlisted Telegram IDs
one blocked non-allowlisted delivery is logged and not sent
scheduled automation remains disabled
production GET / still returns the previous production response
```

- [ ] **Step 7: Record the phase result without changing production**

Capture:

```text
final commit SHA
test count and pass count
staging deployment version
staging URL
smoke-test results
production health comparison
```

Do not merge, push, or production-deploy as part of this task.

---

## Completion Gate

Phase 2 is complete only when all of the following are true:

1. Financial approval regression tests cover income, income-linked fine, advance, salary snapshot, cycle boundary, and sequential replay.
2. Worker tests cover health, admin, webhook authentication, and scheduled-task gating.
3. Telegram flow tests verify exact critical messages and reply markup.
4. Every pre-existing test passes without weakened assertions.
5. `src/index.js` is a compatibility facade under 120 lines.
6. Admin HTML, Telegram flow, absence flow, approvals, payroll queries, pure money/date logic, and routing live in separate owner modules.
7. No business rule, database schema, route, response shape, callback payload, or user-visible text changed.
8. No new runtime dependency, framework, or build step was introduced.
9. The refactored commit runs successfully in the isolated staging Worker.
10. Production Worker, production D1, production Telegram bot, and production Cron remain unchanged.

## Deferred to the Next Approved Phase

The following items are deliberately not implemented by this plan:

- `payroll_entries`
- `amount_micros`
- historical financial migration and reconciliation
- immutable entries and reversals
- approval concurrency redesign and `409 already_decided`
- Dashboard APIs and charts
- personal day-16/day-30 payroll
- payment profiles, R2 proof uploads, employee confirmation, disputes, and email

These items start only after this refactor passes the completion gate and the user approves the unified-ledger phase.
