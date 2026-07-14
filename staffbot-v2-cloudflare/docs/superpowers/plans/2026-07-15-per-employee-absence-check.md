# Per-Employee Absence Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-store employee switch that removes exempt employees from absence-day calculation and future absence approval generation while preserving their other attendance history.

**Architecture:** Store the current switch and current enable boundary on `store_members`. Reuse the existing member API and form, make disabling atomically cancel pending absence work, then apply the setting in both Cron discovery and derived attendance statistics.

**Tech Stack:** Cloudflare Workers, D1/SQLite migrations, vanilla JavaScript admin UI, Node.js test runner.

## Global Constraints

- Existing and new employees default to daily absence checking enabled.
- The setting is scoped by `store_id + telegram_id`.
- Disabling cancels pending absence approvals and unsent/retrying notifications, but never changes approved fines or decided history.
- Exempt employees remain visible in attendance summaries; only their absence count becomes zero.
- Re-enabling starts a new current calculation boundary and does not backfill the exempt interval.
- Reuse the existing member page and styling; add no page, scheduling system, dependency, or unrelated refactor.

---

### Task 1: Persist the employee absence-check setting

**Files:**
- Create: `staffbot-v2-cloudflare/db/migrations/018_employee_absence_check.sql`
- Modify: `staffbot-v2-cloudflare/db/schema.sql`
- Test: `staffbot-v2-cloudflare/test/admin-pagination-leave.test.js`

**Interfaces:**
- Produces: `store_members.absence_check_enabled` as integer `0|1`.
- Produces: `store_members.absence_check_enabled_at` as nullable ISO timestamp.

- [ ] **Step 1: Write the failing migration test**

Add a test that creates the pre-018 table, applies the migration, and asserts both columns, default `1`, and initialization from `joined_at`:

```js
test('migrates existing members into daily absence checking', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(`CREATE TABLE store_members (store_id TEXT, telegram_id TEXT, joined_at TEXT);`);
  database.exec(`INSERT INTO store_members VALUES ('S1', 'U1', '2026-07-01T00:00:00.000Z');`);
  database.exec(readFileSync('db/migrations/018_employee_absence_check.sql', 'utf8'));
  assert.deepEqual({ ...database.prepare(
    `SELECT absence_check_enabled, absence_check_enabled_at FROM store_members`
  ).get() }, {
    absence_check_enabled: 1,
    absence_check_enabled_at: '2026-07-01T00:00:00.000Z'
  });
});
```

- [ ] **Step 2: Run the test and expect failure**

Run: `node --test --test-name-pattern="migrates existing members" test/admin-pagination-leave.test.js`

Expected: FAIL because migration 018 does not exist.

- [ ] **Step 3: Add the migration and schema fields**

```sql
ALTER TABLE store_members ADD COLUMN absence_check_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE store_members ADD COLUMN absence_check_enabled_at TEXT;
UPDATE store_members
SET absence_check_enabled_at = joined_at
WHERE absence_check_enabled = 1 AND absence_check_enabled_at IS NULL;
```

Add the same columns to `db/schema.sql`.

- [ ] **Step 4: Verify and commit**

Run the targeted test; expected PASS.

```bash
git add staffbot-v2-cloudflare/db/migrations/018_employee_absence_check.sql staffbot-v2-cloudflare/db/schema.sql staffbot-v2-cloudflare/test/admin-pagination-leave.test.js
git commit -m "feat: store employee absence check setting"
```

### Task 2: Save the switch and cancel pending absence work

**Files:**
- Modify: `staffbot-v2-cloudflare/src/index.js`
- Test: `staffbot-v2-cloudflare/test/admin-pagination-leave.test.js`

**Interfaces:**
- Produces: `normalizeEmployeeAbsenceCheck(input, currentMember, now)` returning `{ absence_check_enabled, absence_check_enabled_at }`.
- Updates: `POST /api/admin/stores/:storeId/members` accepts optional `absence_check_enabled`.

- [ ] **Step 1: Write failing helper and database tests**

Cover omitted input preserving the current value, disabling returning `0/null`, and re-enabling returning `1/now.toISOString()`. Add a database test proving an enabled-to-disabled transition:

- updates only the selected store membership;
- cancels matching `pending` requests with `cancellation_reason = 'absence_check_disabled'`;
- cancels their `pending` or `sending` notifications;
- leaves approved requests and income records untouched.

- [ ] **Step 2: Run tests and expect failure**

Run: `node --test --test-name-pattern="employee absence check|disabling absence checks" test/admin-pagination-leave.test.js`

Expected: FAIL because the helper and save behavior are missing.

- [ ] **Step 3: Implement minimal member-save behavior**

Read the existing membership before the upsert. Include both fields in INSERT and conflict UPDATE. When the transition is enabled-to-disabled, append these statements to the same `env.DB.batch(...)`:

```sql
UPDATE absence_fine_requests
SET status = 'cancelled', cancellation_reason = 'absence_check_disabled',
    decided_at = ?, admin_id = ?
WHERE store_id = ? AND telegram_id = ? AND status = 'pending'
```

```sql
UPDATE absence_fine_notifications
SET status = 'cancelled', last_error = 'absence_check_disabled'
WHERE status IN ('pending', 'sending')
  AND request_id IN (
    SELECT request_id FROM absence_fine_requests
    WHERE store_id = ? AND telegram_id = ?
      AND status = 'cancelled'
      AND cancellation_reason = 'absence_check_disabled'
  )
```

Write an admin audit entry containing the before/after switch values.

- [ ] **Step 4: Verify and commit**

Run targeted tests and `npm test`; expected all PASS.

```bash
git add staffbot-v2-cloudflare/src/index.js staffbot-v2-cloudflare/test/admin-pagination-leave.test.js
git commit -m "feat: manage employee absence checks"
```

### Task 3: Add the switch to the existing employee UI

**Files:**
- Modify: `staffbot-v2-cloudflare/src/index.js`
- Test: `staffbot-v2-cloudflare/test/admin-pagination-leave.test.js`

**Interfaces:**
- Consumes: member API fields from Task 2.
- Produces: localized `absence_check_enabled` label and form/list rendering.

- [ ] **Step 1: Write a failing rendering test**

Assert the admin source contains `memberAbsenceCheck`, includes `absence_check_enabled` in the member list, sends it in save requests, preserves it in status-toggle requests, and defaults the clear/new form to true.

- [ ] **Step 2: Run the test and expect failure**

Run: `node --test --test-name-pattern="member form exposes daily absence checking" test/admin-pagination-leave.test.js`

Expected: FAIL because the control is absent.

- [ ] **Step 3: Extend the member form**

Add translations for Chinese, English, Vietnamese, and Russian. Add a true/false select beside status and commission. Add the field to both member SELECT projections and the list columns. Send a boolean on save and preserve the current value in status-only toggles. Fill the form using:

```js
$('memberAbsenceCheck').value =
  member.absence_check_enabled === 0 ? 'false' : 'true';
```

- [ ] **Step 4: Verify and commit**

Run the targeted test and `npm test`; expected PASS.

```bash
git add staffbot-v2-cloudflare/src/index.js staffbot-v2-cloudflare/test/admin-pagination-leave.test.js
git commit -m "feat: edit employee absence checks"
```

### Task 4: Apply the switch to Cron and statistics

**Files:**
- Modify: `staffbot-v2-cloudflare/src/index.js`
- Test: `staffbot-v2-cloudflare/test/admin-pagination-leave.test.js`

**Interfaces:**
- Consumes: both fields from Task 1.
- Updates: `processAbsenceFines(env, now)` and `attendanceEmployeeStats(env, filters, now)`.

- [ ] **Step 1: Write failing behavior tests**

Extend absence discovery fixtures with an exempt employee and assert no request or notification is created. Add statistics tests proving an exempt employee still has work, late, leave, and fine totals but has `absence_days = 0`. Add a re-enabled employee and assert absence starts at its store-local enable date rather than `joined_at`.

- [ ] **Step 2: Run tests and expect failure**

Run: `node --test --test-name-pattern="exempt employee|re-enabled employee" test/admin-pagination-leave.test.js`

Expected: FAIL because Cron and statistics ignore the switch.

- [ ] **Step 3: Filter Cron candidates**

Add `m.absence_check_enabled = 1`, select `m.absence_check_enabled_at`, and skip candidates whose store-local enable date is later than the business date.

- [ ] **Step 4: Bound only absence calculation**

Select both member fields in `attendanceEmployeeStats`. Continue collecting work, late, leave, and fine events across the selected range. For absence only:

- disabled: `absence_days = 0`;
- enabled: start at the later of joined/query start and the store-local enable date;
- subtract only work/approved-leave dates on or after that absence start.

- [ ] **Step 5: Verify and commit**

Run targeted tests, `npm run check`, `npm test`, and `git diff --check`; all must pass.

```bash
git add staffbot-v2-cloudflare/src/index.js staffbot-v2-cloudflare/test/admin-pagination-leave.test.js
git commit -m "feat: honor employee absence exemptions"
```

### Task 5: Review, merge, migrate, deploy, and verify

**Files:**
- No new source files.

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: migrated D1 database, deployed Worker, and pushed `main`.

- [ ] **Step 1: Final local verification**

Run `npm run check`, `npm test`, and `git diff --check`. Expect syntax success, all tests PASS, and no whitespace errors.

- [ ] **Step 2: Review and merge**

Confirm every changed line belongs to the approved spec, no generated files or secrets are included, and migration 018 is additive. Fast-forward the isolated branch into `main`, then repeat local verification.

- [ ] **Step 3: Apply only pending remote migration**

Run:

```bash
npx wrangler whoami
npx wrangler d1 migrations list staffbot_v2 --remote
npx wrangler d1 migrations apply staffbot_v2 --remote
npx wrangler d1 migrations list staffbot_v2 --remote
```

Expected: only migration 018 is applied, then no migrations remain.

- [ ] **Step 4: Deploy and smoke-test**

Run `npx wrangler deploy`, capture URL/version, and verify:

```bash
curl -fsS -o /dev/null -w '%{http_code}' https://staffbot-v2.staffbot-v2.workers.dev/
curl -fsS https://staffbot-v2.staffbot-v2.workers.dev/admin | rg 'memberAbsenceCheck|absence_check_enabled'
```

Expected: homepage 200, both UI markers present, and deploy output still lists `schedule: 10 * * * *`.

- [ ] **Step 5: Verify defaults and push**

Query remote D1 to confirm existing members are enabled with non-null enable timestamps and no approved fine was changed. Push `main` to `origin/main` only after production verification succeeds.
