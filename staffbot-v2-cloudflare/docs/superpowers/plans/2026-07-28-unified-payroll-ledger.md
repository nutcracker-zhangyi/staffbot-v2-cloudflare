# StaffBot Unified Payroll Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace payroll aggregation across `income_records.commission_income` and `income_records.fine` with one immutable `payroll_entries.amount_micros` fact field while preserving every current payroll result and keeping production unchanged until a separately approved release.

**Architecture:** Introduce a signed-integer ledger beside the legacy table, backfill it idempotently, and reconcile every employee and payroll period with exact integer comparisons. Continue returning legacy totals while approvals dual-write atomically, then enable shadow comparison in staging and switch reads only after sustained zero-difference evidence. Corrections become reversal entries; the old table remains read-only during a compatibility period.

**Tech Stack:** Cloudflare Workers, Cloudflare D1/SQLite, Wrangler migrations, JavaScript ES modules, Node.js built-in test runner, Node.js built-in SQLite test database.

## Global Constraints

- Work only on `codex/staging-environment` in the existing isolated worktree.
- Do not merge into `main`, push, create a pull request, or deploy production under this plan.
- Remote database commands must name `--env staging`; never run a migration or backfill against production.
- `amount_micros` is the only field used to aggregate ledger salary amounts.
- One unit of store currency equals exactly `1,000,000` micros.
- Every micros value must be a non-zero JavaScript safe integer and fit SQLite signed 64-bit integer storage.
- `income` and `bonus` entries are positive.
- `fine`, `advance`, and `negative_carry` entries are negative.
- `adjustment` entries may have either sign but cannot be zero.
- `reversal` entries equal the exact arithmetic opposite of the referenced entry.
- Ledger ranges are left-closed and right-open: `[period_start, cutoff_at)`.
- A salary payment is not a ledger entry.
- Unknown legacy types stop migration and produce a report; they are never guessed or converted to `adjustment`.
- Legacy zero-effect rows are reported and skipped because they do not affect salary and cannot satisfy the ledger's non-zero sign contract. They remain preserved in `income_records`.
- Historical reconciliation uses exact integer equality with no floating-point tolerance.
- Keep native JavaScript ES modules and do not add a framework, bundler, TypeScript, or runtime dependency.
- Every task ends with focused tests, `npm run check`, `npm test`, an independently reviewable commit, and a clean worktree.
- The dashboard and personal day-16/day-30 payroll scheduler are separate follow-on plans after this ledger cutover is proven.

## Verified Preflight Baseline

- Branch: `codex/staging-environment`
- Starting commit: `653884a`
- Existing migrations: `001` through `018`
- Local baseline: 147 passing tests
- Staging `income_records`: 158 rows
- Supported staging types: 99 `income`, 51 `fine`, 8 `advance`
- Unknown types: 0
- Missing required store, employee, approval time, or administrator values: 0
- Values with precision below one micro: 0
- Values exceeding JavaScript safe-integer range after conversion: 0
- Duplicate legacy `(source, request_id)` groups: 0
- Missing store references: 0
- Missing member references: 0
- Currency distribution: 157 VND rows and 1 USD row
- Zero-effect legacy rows: 16 `fine` rows; these are retained in the old table and excluded from ledger backfill.

## File Structure

- `src/payroll-ledger.js`
  - Own the ledger type/sign contract, micros conversion, legacy mapping, query helpers, entry validation, and reversal draft creation.
- `src/payroll.js`
  - Own old-total, ledger-total, shadow comparison, and read-source selection.
- `src/approvals.js`
  - Atomically update request state, write legacy compatibility rows, and insert ledger rows.
- `db/migrations/019_payroll_entries.sql`
  - Create the immutable ledger table and indexes without backfilling.
- `db/migrations/020_backfill_payroll_entries.sql`
  - Idempotently convert supported, non-zero legacy records.
- `db/schema.sql`
  - Represent the fully migrated schema used by local integration tests.
- `db/audits/019_payroll_ledger_preflight.sql`
  - Return only migration blockers and zero-effect counts.
- `db/audits/020_payroll_ledger_reconcile.sql`
  - Return employee/current-cycle, historical-period, type, store, and currency differences.
- `test/payroll-ledger.test.js`
  - Test pure conversion, validation, aggregation boundaries, idempotent backfill, and reversals.
- `test/payroll-shadow-read.test.js`
  - Test old/new comparison and feature-flag behavior.
- `test/approval-regression.test.js`
  - Prove approval atomicity, idempotency, dual writes, and `409 already_decided`.
- `docs/DATA_MODEL.md`
  - Document the ledger as the payroll source of truth and mark legacy fields as compatibility-only.
- `docs/ARCHITECTURE.md`
  - Document rollout flags, ownership, migration gates, and rollback behavior.

## Safe Rollout Order

```text
pure conversion contract
→ local schema and migration tests
→ staging schema only
→ staging preflight
→ idempotent staging backfill
→ exact reconciliation
→ approval dual-write with legacy reads still authoritative
→ staging shadow reads
→ exact reconciliation again
→ staging ledger read cutover
→ immutable reversal operations
→ compatibility observation period
```

The approved design listed read cutover before write cutover. This plan deliberately uses dual-write before shadow observation because otherwise every approval after the backfill would make the new ledger stale and produce expected mismatches. During dual-write, legacy totals still remain authoritative, so rollback is disabling ledger writes/reads rather than reconstructing old data.

---

### Task 1: Freeze the micros and legacy mapping contract

**Files:**

- Create: `src/payroll-ledger.js`
- Create: `test/payroll-ledger.test.js`
- Modify: `src/index.js`

**Interfaces:**

- Produces:

```js
export const MICROS_PER_UNIT = 1_000_000;
export const PAYROLL_ENTRY_TYPES = new Set([
  'income', 'fine', 'advance', 'bonus',
  'adjustment', 'reversal', 'negative_carry'
]);

amountToMicros(amount) -> number
legacyPayrollImpactMicros(record) -> number
legacyIncomeRecordToPayrollEntry(record, currency, createdAt) -> object | null
validatePayrollEntry(entry, originalEntry = null) -> object
```

- `legacyIncomeRecordToPayrollEntry` returns `null` only for a supported zero-effect row.
- Historical entries use `entry_id = "PAY-MIG-" + record_id`, preserve the old `source`, use the old `record_id` as `source_id`, copy `approved_at` to `effective_at`, and serialize legacy numeric fields into `metadata_json`.

- [ ] **Step 1: Write failing micros conversion tests**

Add tests that require:

```js
assert.equal(amountToMicros(12.34), 12_340_000);
assert.equal(amountToMicros('0.000001'), 1);
assert.equal(amountToMicros(1_200_000_000), 1_200_000_000_000_000);
assert.throws(() => amountToMicros('nope'), /finite number/);
assert.throws(
  () => amountToMicros(Number.MAX_SAFE_INTEGER),
  /safe integer/
);
```

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test test/payroll-ledger.test.js
```

Expected: FAIL because `src/payroll-ledger.js` does not exist.

- [ ] **Step 3: Implement the minimal conversion**

Use:

```js
export const MICROS_PER_UNIT = 1_000_000;

export function amountToMicros(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value)) throw new TypeError('amount must be a finite number');
  const micros = Math.round(value * MICROS_PER_UNIT);
  if (!Number.isSafeInteger(micros)) {
    throw new RangeError('amount micros must be a JavaScript safe integer');
  }
  return micros;
}
```

- [ ] **Step 4: Add failing legacy mapping tests**

Cover exact mappings:

```js
assert.equal(legacyPayrollImpactMicros({
  type: 'income',
  commission_income: 12.34,
  fine: 0
}), 12_340_000);

assert.equal(legacyPayrollImpactMicros({
  type: 'fine',
  commission_income: 0,
  fine: 1.5
}), -1_500_000);

assert.equal(legacyPayrollImpactMicros({
  type: 'advance',
  commission_income: 0,
  fine: 20
}), -20_000_000);

assert.throws(
  () => legacyPayrollImpactMicros({ type: 'mystery' }),
  /unsupported legacy payroll type/
);
```

Also require a zero fine to return `null` from the draft mapper, and verify every mapped identity/time/currency/metadata field.

- [ ] **Step 5: Implement mapping and validation**

The mapping switch must be exhaustive:

```js
switch (record.type) {
  case 'income':
    amountMicros = amountToMicros(record.commission_income);
    break;
  case 'fine':
  case 'advance':
    amountMicros = -amountToMicros(record.fine);
    break;
  default:
    throw new TypeError(`unsupported legacy payroll type: ${record.type}`);
}
```

Reject invalid signs, zero adjustments, unsafe integers, missing identities, non-ISO effective times, and currency mismatch. A reversal additionally requires an original entry and exact opposite amount.

- [ ] **Step 6: Export and verify**

Re-export the new module from `src/index.js`, then run:

```bash
node --test test/payroll-ledger.test.js
npm run check
npm test
```

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/payroll-ledger.js src/index.js test/payroll-ledger.test.js
git commit -m "feat: define payroll ledger amount contract"
```

---

### Task 2: Create the immutable ledger schema locally

**Files:**

- Create: `db/migrations/019_payroll_entries.sql`
- Modify: `db/schema.sql`
- Modify: `test/payroll-ledger.test.js`

**Interfaces:**

- Consumes: `PAYROLL_ENTRY_TYPES` and validation rules from Task 1.
- Produces: `payroll_entries` and its four required indexes.

- [ ] **Step 1: Write a failing schema test**

Load `db/schema.sql` into `DatabaseSync(':memory:')` and assert:

```js
const columns = database.prepare(`PRAGMA table_info(payroll_entries)`).all();
assert.deepEqual(
  columns.map((column) => column.name),
  [
    'entry_id', 'store_id', 'telegram_id', 'type', 'amount_micros',
    'currency', 'effective_at', 'source', 'source_id', 'created_by',
    'created_at', 'reverses_entry_id', 'metadata_json'
  ]
);
```

Assert the two uniqueness rules reject duplicate non-reversal sources and a second reversal of the same entry.

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test test/payroll-ledger.test.js
```

Expected: FAIL with `no such table: payroll_entries`.

- [ ] **Step 3: Add migration 019 and update the canonical schema**

Create the exact table and indexes from the approved design. Add SQLite `CHECK` constraints for the allowed type set, non-zero amount, valid sign per non-reversal type, and non-empty currency/source/identity fields. Do not add triggers that make historical backfill impossible and do not backfill in migration 019.

- [ ] **Step 4: Verify schema behavior**

Run:

```bash
node --test test/payroll-ledger.test.js
npm run check
npm test
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/019_payroll_entries.sql db/schema.sql test/payroll-ledger.test.js
git commit -m "feat: add immutable payroll ledger schema"
```

---

### Task 3: Add migration preflight and idempotent historical backfill

**Files:**

- Create: `db/audits/019_payroll_ledger_preflight.sql`
- Create: `db/migrations/020_backfill_payroll_entries.sql`
- Modify: `db/schema.sql`
- Modify: `test/payroll-ledger.test.js`

**Interfaces:**

- Consumes: the mapping and schema contracts from Tasks 1-2.
- Produces: one ledger entry per supported, non-zero legacy row.
- Uses `source_id = income_records.record_id`, making repeated execution idempotent through the unique source index and deterministic `entry_id`.

- [ ] **Step 1: Write failing migration tests**

Create an in-memory legacy fixture containing:

```text
income  commission_income=60
fine    fine=5
advance fine=20
fine    fine=0
unknown type=mystery
```

Require preflight to report the unknown row and the zero-effect row. Remove the unknown row, run migration 020 twice, and require exactly three ledger rows with amounts `60_000_000`, `-5_000_000`, and `-20_000_000`.

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test test/payroll-ledger.test.js
```

Expected: FAIL because the audit and backfill SQL files do not exist.

- [ ] **Step 3: Implement preflight**

The audit must return:

```text
unknown_type_rows
missing_required_rows
sub_micro_precision_rows
unsafe_integer_rows
missing_store_rows
missing_member_rows
duplicate_identity_rows
zero_effect_rows
```

Only `zero_effect_rows` may be non-zero without blocking backfill.

- [ ] **Step 4: Implement deterministic backfill**

Use one `INSERT OR IGNORE ... SELECT` with:

```sql
CASE type
  WHEN 'income' THEN ROUND(commission_income * 1000000)
  WHEN 'fine' THEN -ROUND(fine * 1000000)
  WHEN 'advance' THEN -ROUND(fine * 1000000)
END
```

Filter to supported non-zero effects. Preserve the legacy source in `source`, legacy `record_id` in `source_id`, and legacy fields in `json_object(...)`.

- [ ] **Step 5: Verify**

Run:

```bash
node --test test/payroll-ledger.test.js
npm run check
npm test
```

Expected: all tests PASS and a second backfill changes zero rows.

- [ ] **Step 6: Commit**

```bash
git add db/audits/019_payroll_ledger_preflight.sql db/migrations/020_backfill_payroll_entries.sql db/schema.sql test/payroll-ledger.test.js
git commit -m "feat: add idempotent payroll ledger backfill"
```

---

### Task 4: Add exact reconciliation reports

**Files:**

- Create: `db/audits/020_payroll_ledger_reconcile.sql`
- Create: `test/payroll-reconciliation.test.js`
- Modify: `package.json`

**Interfaces:**

- Produces discrepancy-only result sets for:
  - each employee's current open cycle;
  - every historical `salary_records` period;
  - each store/currency/type subtotal;
  - each store/currency net total.

- [ ] **Step 1: Write failing reconciliation tests**

Build a fixture with two stores, two currencies, two employees, one historical salary period, and one current period. Require zero discrepancy rows after backfill, then alter one ledger amount by one micro and require the exact employee/period row to report `difference_micros = 1`.

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test test/payroll-reconciliation.test.js
```

Expected: FAIL because the reconciliation SQL does not exist.

- [ ] **Step 3: Implement exact SQL**

For the legacy side, sum row-level rounded values:

```sql
SUM(ROUND((commission_income - fine) * 1000000))
```

Do not use:

```sql
ROUND(SUM(commission_income - fine) * 1000000)
```

The row-level rounding order is part of the migration contract. Compare store, employee, and identical left-closed/right-open timestamps.

- [ ] **Step 4: Add focused script and verify**

Add:

```json
"test:ledger": "node --test test/payroll-ledger.test.js test/payroll-reconciliation.test.js"
```

Run:

```bash
npm run test:ledger
npm run check
npm test
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add db/audits/020_payroll_ledger_reconcile.sql test/payroll-reconciliation.test.js package.json
git commit -m "test: add exact payroll ledger reconciliation"
```

## Checkpoint A: Local migration safety

- [ ] Tasks 1-4 are committed separately.
- [ ] Full tests pass.
- [ ] Unknown types block backfill.
- [ ] Zero-effect rows are reported and skipped.
- [ ] Backfill is idempotent.
- [ ] A one-micro mismatch is detected at the correct employee and period.
- [ ] Human reviews the local migration evidence before staging schema changes.

---

### Task 5: Dual-write approved payroll effects atomically

**Files:**

- Modify: `src/payroll-ledger.js`
- Modify: `src/approvals.js`
- Modify: `test/approval-regression.test.js`
- Modify: `wrangler.toml`

**Interfaces:**

- Produces:

```js
payrollEntryInsertStatement(env, entry) -> D1PreparedStatement
payrollLedgerWritesEnabled(env) -> boolean
```

- The staging-only rollout variable starts as:

```toml
PAYROLL_LEDGER_WRITE_MODE = "off"
```

- Supported modes are `off` and `dual`; any other value behaves as `off` and logs a configuration error.

- [ ] **Step 1: Write failing dual-write tests**

For income approval, require two ledger rows: positive `income` and negative `fine`. For salary advance, require one negative `advance`. Require request update, old compatibility insert, new ledger insert, and admin audit to roll back together when any ledger statement fails.

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test test/approval-regression.test.js
```

Expected: FAIL because approvals do not write `payroll_entries`.

- [ ] **Step 3: Add ledger statement construction**

Create ledger entries from the already approved legacy drafts so the same commission snapshot, fine, store, employee, source, request, administrator, and effective time feed both formats.

- [ ] **Step 4: Move approval audit into each database batch**

Use an audit insert statement in the same `env.DB.batch` as the conditional request update and both compatibility/ledger inserts. Do not call a separate post-commit audit write for these financial approvals.

- [ ] **Step 5: Verify atomicity**

Run:

```bash
node --test test/approval-regression.test.js
npm run check
npm test
```

Expected: all tests PASS in both `off` and `dual` modes.

- [ ] **Step 6: Commit**

```bash
git add src/payroll-ledger.js src/approvals.js test/approval-regression.test.js wrangler.toml
git commit -m "feat: dual-write approved payroll entries"
```

---

### Task 6: Harden financial approvals against replay and concurrency

**Files:**

- Modify: `src/approvals.js`
- Modify: `src/admin-api.js`
- Modify: `test/approval-regression.test.js`

**Interfaces:**

- Produces the failure result:

```js
{ ok: false, error: 'already_decided' }
```

- Admin HTTP endpoints map it to:

```http
409 Conflict
{"ok":false,"error":"already_decided"}
```

- [ ] **Step 1: Write failing race tests**

Use the D1 test hooks to simulate two approvers reading `pending`. Require exactly one conditional update to change one row, one compatibility write set, one ledger write set, and one audit record.

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test test/approval-regression.test.js
```

Expected: FAIL because current income and advance replay returns legacy `200 {ok:false}`.

- [ ] **Step 3: Enforce conditional winners**

Every financial request update must include:

```sql
WHERE store_id = ? AND request_id = ? AND status = 'pending'
```

After the batch, check the update statement's change count. A zero count returns `already_decided`; uniqueness errors caused by a replay map to the same result.

- [ ] **Step 4: Map the admin response**

Return HTTP 409 only for `already_decided`. Preserve current status codes and response shapes for all unrelated errors.

- [ ] **Step 5: Verify**

Run:

```bash
node --test test/approval-regression.test.js
npm run check
npm test
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/approvals.js src/admin-api.js test/approval-regression.test.js
git commit -m "fix: make financial approvals single-winner"
```

---

### Task 7: Add shadow reads while returning legacy totals

**Files:**

- Modify: `src/payroll.js`
- Create: `test/payroll-shadow-read.test.js`
- Modify: `wrangler.toml`
- Modify: `src/audit.js`

**Interfaces:**

- Produces:

```js
getLegacyTotalIncomeMicros(env, storeId, telegramId, start, end) -> Promise<number>
getLedgerTotalIncomeMicros(env, storeId, telegramId, start, end) -> Promise<number>
comparePayrollTotals(env, storeId, telegramId, start, end) -> Promise<object>
```

- In `shadow` mode, `getTotalIncome` returns the converted legacy total and logs only mismatches.
- Initial staging value:

```toml
PAYROLL_LEDGER_READ_MODE = "legacy"
```

- Supported values: `legacy`, `shadow`, `ledger`.

- [ ] **Step 1: Write failing read-mode tests**

Require:

```text
legacy -> query/return old result only
shadow equal -> return old result and no mismatch
shadow unequal -> return old result and write redacted mismatch log
ledger -> return amount_micros / 1,000,000
```

Test an entry exactly at `end` is excluded.

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test test/payroll-shadow-read.test.js
```

Expected: FAIL because read modes do not exist.

- [ ] **Step 3: Implement explicit queries**

The legacy query uses row-level `ROUND(... * 1000000)`. The ledger query uses `SUM(amount_micros)`. Both use the same `[start, end)` range.

- [ ] **Step 4: Add redacted mismatch logging**

Log store ID, employee ID, start/end, old micros, new micros, and difference. Do not include names, usernames, account information, or payment proof URLs.

- [ ] **Step 5: Verify**

Run:

```bash
node --test test/payroll-shadow-read.test.js
npm run check
npm test
```

Expected: all tests PASS and shadow mode never changes the returned salary.

- [ ] **Step 6: Commit**

```bash
git add src/payroll.js src/audit.js test/payroll-shadow-read.test.js wrangler.toml
git commit -m "feat: add payroll ledger shadow reads"
```

---

### Task 8: Replace ledger edits and deletes with reversals

**Files:**

- Modify: `src/payroll-ledger.js`
- Modify: `src/approvals.js`
- Modify: `src/admin-api.js`
- Modify: `test/approval-regression.test.js`

**Interfaces:**

- Produces:

```js
createReversalDraft(originalEntry, adminId, effectiveAt, entryId) -> object
reversePayrollEntry(env, storeId, entryId, adminId, effectiveAt) -> Promise<object>
```

- [ ] **Step 1: Write failing reversal tests**

Require exact opposite amount/currency/employee/store, a populated `reverses_entry_id`, rejection of a second reversal, and no update/delete against `payroll_entries`.

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test test/payroll-ledger.test.js test/approval-regression.test.js
```

Expected: FAIL because reversal operations do not exist.

- [ ] **Step 3: Implement reversal creation**

Read the original by store and entry ID. In one batch insert the reversal and audit record. The unique reversal index is the concurrency winner.

- [ ] **Step 4: Change legacy admin correction routes**

When ledger write mode is active:

- deleting an effective financial record creates a reversal;
- changing a fine creates a reversal of the old fine and a new corrected fine;
- the old `income_records` row is not deleted or mutated.

Keep the legacy behavior reachable only while write mode is `off`.

- [ ] **Step 5: Verify**

Run:

```bash
node --test test/payroll-ledger.test.js test/approval-regression.test.js
npm run check
npm test
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/payroll-ledger.js src/approvals.js src/admin-api.js test/payroll-ledger.test.js test/approval-regression.test.js
git commit -m "feat: correct payroll entries with reversals"
```

## Checkpoint B: Application cutover safety

- [ ] Approval writes are atomic.
- [ ] Replays and races produce one winner.
- [ ] Shadow mode always returns legacy totals.
- [ ] Every mismatch is observable without sensitive account data.
- [ ] Ledger corrections never mutate or delete financial history.
- [ ] Full tests pass.
- [ ] Human reviews application behavior before staging read cutover.

---

### Task 9: Apply and prove the migration in staging

**Files:**

- Create: `docs/reports/2026-07-28-staging-payroll-ledger-migration.md`
- Modify only if evidence reveals a defect: files owned by Tasks 1-8

**Interfaces:**

- Produces a dated evidence report containing commands, migration IDs, counts, reconciliation result sets, staging Worker version, and rollback settings.

- [ ] **Step 1: Verify identity and unapplied migrations**

Run:

```bash
npx wrangler whoami
npx wrangler d1 migrations list DB --env staging --remote
```

Expected: authenticated account and only reviewed ledger migrations pending.

- [ ] **Step 2: Run preflight before any schema change**

Run:

```bash
npx wrangler d1 execute DB --env staging --remote --json \
  --file db/audits/019_payroll_ledger_preflight.sql
```

Expected: every blocker count is 0; `zero_effect_rows` is recorded separately.

- [ ] **Step 3: Apply schema and backfill migrations**

Run:

```bash
npx wrangler d1 migrations apply DB --env staging --remote
```

Expected: migrations 019 and 020 are applied in order; production is untouched.

- [ ] **Step 4: Re-run backfill idempotency proof**

Execute the backfill insert again as a staging command and record `changes = 0`.

- [ ] **Step 5: Run exact reconciliation**

Run:

```bash
npx wrangler d1 execute DB --env staging --remote --json \
  --file db/audits/020_payroll_ledger_reconcile.sql
```

Expected: every discrepancy result set is empty.

- [ ] **Step 6: Enable dual writes, deploy staging, and exercise flows**

Set staging `PAYROLL_LEDGER_WRITE_MODE = "dual"` while read mode remains `legacy`, then:

```bash
npm run check
npm test
npx wrangler deploy --env staging
```

Manually approve one income with a fine and one salary advance. Confirm old and new rows agree exactly and repeat clicks return 409 without duplicates.

- [ ] **Step 7: Enable shadow reads and observe**

Set staging read mode to `shadow`, deploy staging, exercise Telegram salary viewing and the admin payroll paths, then rerun the exact reconciliation report.

Expected: no `payroll_shadow_mismatch` log and no reconciliation differences.

- [ ] **Step 8: Switch staging reads to ledger**

Set staging read mode to `ledger`, deploy, and repeat the same payroll checks. Rollback is changing only `PAYROLL_LEDGER_READ_MODE` to `legacy`; do not delete ledger rows.

- [ ] **Step 9: Record evidence and commit**

The report must state:

```text
production migrations: not run
production deployment: not run
staging preflight blockers: 0
staging reconciliation differences: 0
staging backfill rerun changes: 0
```

Then run:

```bash
git add docs/reports/2026-07-28-staging-payroll-ledger-migration.md wrangler.toml
git commit -m "docs: record staging payroll ledger proof"
```

---

### Task 10: Document the source-of-truth transition

**Files:**

- Modify: `docs/DATA_MODEL.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/ROADMAP.md`

**Interfaces:**

- Produces the operational contract for future dashboard and personal payroll plans.

- [ ] **Step 1: Update the data model**

Document every ledger column, sign invariant, micros conversion, source uniqueness, reversal behavior, range semantics, zero-effect legacy exclusion, and the distinction between requests, ledger entries, and salary payments.

- [ ] **Step 2: Update architecture and rollback**

Document:

```text
PAYROLL_LEDGER_WRITE_MODE=off|dual
PAYROLL_LEDGER_READ_MODE=legacy|shadow|ledger
```

State that read rollback is flag-only, write rollback leaves already-created immutable entries intact, and old records remain compatibility/audit data.

- [ ] **Step 3: Update the roadmap**

Mark modular refactor complete, unified ledger staging proof complete, and keep dashboard plus personal payroll as the next separately reviewed phases.

- [ ] **Step 4: Verify documentation and code**

Run:

```bash
rg -n "commission_income - fine|payroll_entries|amount_micros|PAYROLL_LEDGER_" docs src
npm run check
npm test
git diff --check
```

Expected: no documentation claims that legacy REAL fields remain the authoritative payroll source after cutover.

- [ ] **Step 5: Commit**

```bash
git add docs/DATA_MODEL.md docs/ARCHITECTURE.md docs/ROADMAP.md
git commit -m "docs: record unified payroll ledger architecture"
```

## Final Definition of Done

- [ ] All supported legacy rows convert deterministically.
- [ ] Unknown types and unsafe values block migration.
- [ ] Zero-effect legacy rows remain preserved and are explicitly reported.
- [ ] Historical backfill is idempotent.
- [ ] Current and historical employee periods reconcile exactly in integer micros.
- [ ] All financial approvals are atomic, idempotent, and single-winner.
- [ ] Payroll reads use one signed amount field after staging cutover.
- [ ] Effective financial history cannot be edited or deleted.
- [ ] Reversals are exact, unique, and audited.
- [ ] Staging is proven with read-only preflight, migration evidence, dual-write checks, shadow checks, and ledger reads.
- [ ] Production schema, code, data, and deployment remain unchanged.
- [ ] Dashboard implementation does not begin until this plan is complete and reviewed.
