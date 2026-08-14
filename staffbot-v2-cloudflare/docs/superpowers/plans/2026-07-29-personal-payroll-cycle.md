# StaffBot Personal Payroll Cycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace employee-initiated salary requests with an automatic, per-employee 30-day payroll cycle that settles at local noon on cycle days 16 and 30, then supports payment profiles, split payments, private proof images, employee confirmation, and finance email delivery.

**Architecture:** Keep `payroll_entries.amount_micros` as the only source for payroll arithmetic and create immutable `payroll_disbursements` snapshots at fixed scheduled cutoffs. Put cycle math, settlement, payment workflow, proof storage, and email delivery in focused modules; keep `src/telegram.js`, `src/admin-api.js`, `src/router.js`, and `src/admin-page.js` as adapters. All state transitions use database constraints plus conditional D1 batch statements, while Telegram, R2, and email side effects happen only after committed state and are safe to retry.

**Tech Stack:** Cloudflare Workers, Cloudflare D1/SQLite, private Cloudflare R2 binding, Cloudflare Email Sending binding, Telegram Bot API, JavaScript ES modules, Node.js built-in test runner, `node:sqlite`.

**Design spec:** `docs/superpowers/specs/2026-07-27-personal-payroll-cycle-design.md`

## Global Constraints

- Work only in `.worktrees/staging-environment/staffbot-v2-cloudflare` on `codex/staging-environment`.
- Do not merge into `main`, migrate production, deploy production, or enable production automation.
- The first work date is interpreted in the employee store timezone and is cycle day 1.
- New-registration date buttons always contain local today through local today plus 5 days; the leave 05:00 cutoff never applies.
- Paydays are anchor plus `15 + 30 × n` days and anchor plus `29 + 30 × n` days.
- Every planned cutoff is payday local time 12:00, converted to an immutable UTC `cutoff_at`.
- Payroll ranges are left-closed and right-open: `[period_start, cutoff_at)`.
- Only `payroll_entries.amount_micros` participates in new payroll arithmetic.
- A ledger entry belongs to the segment containing its approval/effective time, not its submission time.
- A salary payment and a payment proof are not payroll ledger entries.
- Positive, zero, and negative cutoffs all create one `payroll_disbursements` row so retries cannot reopen a closed segment.
- Negative carry is one `payroll_entries` row with `type='negative_carry'`, `source='payroll_negative_carry'`, and the payroll ID as `source_id`; do not create a new `income_records` row.
- Existing `salary_requests`, `salary_records`, and legacy money tables remain intact for history and compatibility.
- Old pending salary requests remain visible and separately actionable; they are never silently migrated.
- An unfinished or disputed disbursement never blocks a later scheduled cutoff.
- Bank, USDT, and cash split amounts are non-negative safe integer micros and must total exactly `amount_snapshot_micros`.
- Each non-zero payment method requires at least one proof image before employee confirmation can be requested.
- Payment profiles and proof objects are private. Logs, list APIs, and audit summaries never expose full bank or wallet values.
- The employee or an authorized store administrator must be authenticated before a proof object is read.
- Staging Telegram recipients remain restricted by `TELEGRAM_RECIPIENT_MODE=allowlist`.
- Staging scheduled tasks remain disabled until a separate staging acceptance step explicitly enables and later disables them.
- Use direct Worker bindings for D1, R2, and email; do not call Cloudflare REST APIs from the Worker.
- Do not add a framework, bundler, TypeScript, runtime dependency, public R2 URL, or client-side financial calculation.
- Keep Chinese, English, Vietnamese, and Russian Telegram/admin copy.
- Every implementation task ends with focused tests, `npm run check`, `npm test`, one reviewable commit, and a clean worktree.

## File Map

| File | Responsibility |
| --- | --- |
| `src/payroll-cycle.js` | First-work-date validation, personal payday calculation, fixed local-noon cutoff generation, and due-cutoff enumeration |
| `src/payroll-settlement.js` | Eligible-member scan, immutable payroll snapshots, exact ledger aggregation, cycle-boundary advancement, zero handling, and negative carry |
| `src/payroll-payments.js` | Payment-profile validation, split validation, proof requirements, state transitions, confirmation, dispute, and audit statements |
| `src/payroll-proofs.js` | Telegram file download, private R2 object writes, proof metadata, and authorized object reads |
| `src/payroll-email.js` | Finance email rendering, outbox claim/send/retry behavior, and binding validation |
| `src/payroll-notifications.js` | Payday, payment, confirmation, dispute, and 24-hour reminder delivery with retry timestamps |
| `src/dates.js` | Re-export the small first-work-date helpers only if shared date primitives belong here |
| `src/telegram-client.js` | Add Telegram `getFile`, photo download, and media-send adapters without leaking the bot token |
| `src/telegram.js` | Registration and payroll conversation adapters; remove new entry into the old salary-request flow |
| `src/absence.js` | Prevent absence processing before `payroll_start_date` |
| `src/router.js` | Run absence, settlement, reminders, and email outbox from the scheduled handler |
| `src/admin-api.js` | Member payroll-date fields, automatic payroll list/detail, authorized proof endpoint, and payment actions |
| `src/admin-page.js` | Member first-work-date editor and automatic payroll status/payment UI |
| `src/i18n.js` | Four-language payroll and registration copy; remove active `/salary` help/menu copy |
| `src/security.js` | Payroll binding readiness and proof-access policy helpers |
| `db/migrations/021_personal_payroll_cycle.sql` | Payroll dates, payment profiles, disbursements, proof metadata, email outbox, and constraints |
| `db/schema.sql` | Canonical post-migration schema |
| `wrangler.toml` | Staging email binding configuration after verified addresses are supplied; keep production unchanged |
| `test/payroll-cycle.test.js` | Date window, cycle sequence, DST, and cutoff enumeration |
| `test/payroll-settlement.test.js` | Snapshot boundary, idempotency, catch-up, positive/zero/negative, and concurrent-cutoff behavior |
| `test/payroll-payments.test.js` | Profiles, split validation, proof completeness, confirmation, dispute, and concurrency |
| `test/payroll-proofs.test.js` | R2 object keys, metadata, authorization, upload failure, and streaming reads |
| `test/payroll-email.test.js` | Email rendering, outbox claims, retry, and non-rollback behavior |
| `test/telegram-flow.test.js` | Registration buttons and the full employee/admin Telegram workflow |
| `test/worker-routing.test.js` | Scheduled-task composition and removal of the active salary-request entry |
| `test/admin-payroll.test.js` | Member date management, automatic payroll API, proof authorization, and admin actions |
| `test/staging-config.test.js` | Staging-only R2/email/cron safety contract |
| `docs/reports/2026-07-29-staging-personal-payroll-validation.md` | Remote migration, dry-run, live Telegram/R2/email, and production non-change evidence |

## Delivery Order

```text
cycle math
→ schema
→ first-work-date registration and absence boundary
→ immutable settlement
→ scheduled catch-up and reminders
→ payment profiles
→ split payments and private proofs
→ employee confirmation/dispute
→ finance email outbox
→ admin visibility and old-entry removal
→ staging migration and acceptance
```

The order deliberately closes and tests the accounting boundary before adding payment side effects. A later task may consume an earlier public interface, but no task may reach into another module's private helpers.

---

### Task 1: Freeze first-work-date and personal-cutoff math

**Files:**

- Create: `src/payroll-cycle.js`
- Create: `test/payroll-cycle.test.js`
- Modify: `src/index.js`

**Interfaces:**

- Consumes: `addIsoDays()`, `localDate()`, and `zonedMidnightIso()` from `src/dates.js`.
- Produces:

```js
payrollStartDateOptions(store, now = new Date()) -> string[]
validatePayrollStartDate(store, rawDate, now = new Date()) ->
  { ok: true, date: string } | { ok: false, error: string }
payrollCutoff(anchorDate, cycleDay, cycleIndex, timezone) -> {
  scheduled_date: string,
  cutoff_at: string,
  cycle_day: 16 | 30,
  cycle_index: number
}
payrollCutoffsBetween(anchorDate, timezone, afterIso, throughIso) -> object[]
nextPayrollCutoff(anchorDate, timezone, afterIso) -> object
```

- `payrollCutoffsBetween()` returns cutoffs ordered oldest first, strictly after `afterIso`, and at or before `throughIso`.
- `payrollCutoff()` accepts only cycle days 16 and 30 and non-negative integer cycle indexes.

- [ ] **Step 1: Write the failing registration-window tests**

```js
const store = { timezone: 'Asia/Ho_Chi_Minh' };
const now = new Date('2026-07-08T22:30:00.000Z'); // local 05:30 on July 9

assert.deepEqual(payrollStartDateOptions(store, now), [
  '2026-07-09', '2026-07-10', '2026-07-11',
  '2026-07-12', '2026-07-13', '2026-07-14'
]);
assert.deepEqual(validatePayrollStartDate(store, '2026-07-09', now), {
  ok: true,
  date: '2026-07-09'
});
assert.equal(validatePayrollStartDate(store, '2026-07-08', now).ok, false);
assert.equal(validatePayrollStartDate(store, '2026-07-15', now).ok, false);
```

Also call the same functions at local 04:59 and 05:01 and require identical date ranges. Do not call `validateLeaveDate()` or read `leave_same_day_cutoff_hour`.

- [ ] **Step 2: Run RED**

Run:

```bash
node --test test/payroll-cycle.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/payroll-cycle.js`.

- [ ] **Step 3: Implement the registration window**

Use local today plus an inclusive integer offset:

```js
export function payrollStartDateOptions(store, now = new Date()) {
  const timezone = store && store.timezone ? store.timezone : 'Asia/Tokyo';
  const today = localDate(now, timezone);
  return Array.from({ length: 6 }, (_, day) => addIsoDays(today, day));
}

export function validatePayrollStartDate(store, rawDate, now = new Date()) {
  const date = String(rawDate || '').trim();
  const options = payrollStartDateOptions(store, now);
  return options.includes(date)
    ? { ok: true, date }
    : { ok: false, error: 'payroll_start_date_outside_window' };
}
```

- [ ] **Step 4: Write failing cutoff-sequence and DST tests**

Require this exact sequence:

```js
assert.deepEqual(
  [0, 1].flatMap((cycleIndex) => [16, 30].map((cycleDay) =>
    payrollCutoff('2026-07-01', cycleDay, cycleIndex, 'Asia/Tokyo')
  )).map((item) => item.scheduled_date),
  ['2026-07-16', '2026-07-30', '2026-08-15', '2026-08-29']
);
assert.equal(
  payrollCutoff('2026-07-01', 16, 0, 'Asia/Tokyo').cutoff_at,
  '2026-07-16T03:00:00.000Z'
);
```

Add `America/New_York` assertions across the March and November DST changes. The local part must remain 12:00 even though its UTC hour changes.

- [ ] **Step 5: Implement fixed local-noon conversion and due enumeration**

Resolve the target wall-clock hour directly; do not add 12 hours to local midnight because DST transitions can make that assumption incorrect:

```js
function zonedLocalHourIso(isoDate, hour, timezone) {
  const [year, month, day] = isoDate.split('-').map(Number);
  const target = Date.UTC(year, month - 1, day, hour, 0, 0);
  let utc = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(new Date(utc));
    const value = Object.fromEntries(
      parts.filter((part) => part.type !== 'literal')
        .map((part) => [part.type, Number(part.value)])
    );
    const seen = Date.UTC(
      value.year,
      value.month - 1,
      value.day,
      value.hour,
      value.minute,
      value.second
    );
    utc += target - seen;
  }
  return new Date(utc).toISOString();
}

export function payrollCutoff(anchorDate, cycleDay, cycleIndex, timezone) {
  if (![16, 30].includes(cycleDay)) throw new RangeError('invalid payroll cycle day');
  if (!Number.isInteger(cycleIndex) || cycleIndex < 0) {
    throw new RangeError('invalid payroll cycle index');
  }
  const scheduledDate = addIsoDays(
    anchorDate,
    cycleDay - 1 + cycleIndex * 30
  );
  return {
    scheduled_date: scheduledDate,
    cutoff_at: zonedLocalHourIso(scheduledDate, 12, timezone),
    cycle_day: cycleDay,
    cycle_index: cycleIndex
  };
}

export function payrollCutoffsBetween(
  anchorDate,
  timezone,
  afterIso,
  throughIso
) {
  const cutoffs = [];
  for (let cycleIndex = 0; ; cycleIndex += 1) {
    for (const cycleDay of [16, 30]) {
      const cutoff = payrollCutoff(
        anchorDate,
        cycleDay,
        cycleIndex,
        timezone
      );
      if (cutoff.cutoff_at > throughIso) return cutoffs;
      if (cutoff.cutoff_at > afterIso) cutoffs.push(cutoff);
    }
  }
}
```

Implement `nextPayrollCutoff()` with the same ordered loop and return the first cutoff whose `cutoff_at` is strictly after `afterIso`.

- [ ] **Step 6: Export and verify**

```bash
node --test test/payroll-cycle.test.js
npm run check
npm test
```

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/payroll-cycle.js src/index.js test/payroll-cycle.test.js
git commit -m "feat: define personal payroll cycle dates"
```

---

### Task 2: Add the automatic payroll schema

**Files:**

- Create: `db/migrations/021_personal_payroll_cycle.sql`
- Modify: `db/schema.sql`
- Create: `test/payroll-settlement.test.js`
- Create: `test/payroll-payments.test.js`

**Interfaces:**

- Consumes: current migrations `001` through `020`.
- Produces:
  - `store_members.payroll_start_date`
  - `store_members.payroll_automation_started_at`
  - `payroll_payment_profiles`
  - `payroll_disbursements`
  - `payroll_payment_proofs`
  - `payroll_email_outbox`

- [ ] **Step 1: Write failing canonical-schema tests**

Load `db/schema.sql` into `DatabaseSync(':memory:')` and assert:

```js
assert.deepEqual(
  columns('payroll_disbursements').filter((name) => [
    'payroll_id', 'store_id', 'telegram_id', 'scheduled_date',
    'period_start', 'cutoff_at', 'amount_snapshot_micros',
    'status', 'bank_micros', 'usdt_micros', 'cash_micros',
    'salary_record_id', 'confirmed_at'
  ].includes(name)),
  [
    'payroll_id', 'store_id', 'telegram_id', 'scheduled_date',
    'period_start', 'cutoff_at', 'amount_snapshot_micros',
    'status', 'bank_micros', 'usdt_micros', 'cash_micros',
    'salary_record_id', 'confirmed_at'
  ]
);
```

Also assert foreign-key-independent uniqueness for:

- `(store_id, telegram_id, scheduled_date)` in `payroll_disbursements`;
- `(store_id, telegram_id)` in `payroll_payment_profiles`;
- `(payroll_id, method, sort_order)` in `payroll_payment_proofs`;
- `payroll_id` in `payroll_email_outbox`.

- [ ] **Step 2: Run RED**

```bash
node --test test/payroll-settlement.test.js test/payroll-payments.test.js
```

Expected: FAIL because the tables and columns do not exist.

- [ ] **Step 3: Create migration 021**

Use these state and amount checks:

```sql
ALTER TABLE store_members ADD COLUMN payroll_start_date TEXT;
ALTER TABLE store_members ADD COLUMN payroll_automation_started_at TEXT;

CREATE TABLE payroll_payment_profiles (
  store_id TEXT NOT NULL,
  telegram_id TEXT NOT NULL,
  accepts_bank INTEGER NOT NULL DEFAULT 0 CHECK (accepts_bank IN (0, 1)),
  accepts_usdt INTEGER NOT NULL DEFAULT 0 CHECK (accepts_usdt IN (0, 1)),
  accepts_cash INTEGER NOT NULL DEFAULT 0 CHECK (accepts_cash IN (0, 1)),
  bank_details TEXT,
  usdt_details TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (store_id, telegram_id)
);

CREATE TABLE payroll_disbursements (
  payroll_id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL,
  telegram_id TEXT NOT NULL,
  payroll_start_date TEXT NOT NULL,
  scheduled_date TEXT NOT NULL,
  cycle_day INTEGER NOT NULL CHECK (cycle_day IN (16, 30)),
  period_start TEXT NOT NULL,
  cutoff_at TEXT NOT NULL,
  amount_snapshot_micros INTEGER NOT NULL
    CHECK (typeof(amount_snapshot_micros) = 'integer'),
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'awaiting_employee_details',
    'awaiting_admin_payment',
    'awaiting_employee_confirmation',
    'disputed',
    'confirmed',
    'skipped_zero',
    'carried_negative'
  )),
  accepts_bank INTEGER NOT NULL DEFAULT 0 CHECK (accepts_bank IN (0, 1)),
  accepts_usdt INTEGER NOT NULL DEFAULT 0 CHECK (accepts_usdt IN (0, 1)),
  accepts_cash INTEGER NOT NULL DEFAULT 0 CHECK (accepts_cash IN (0, 1)),
  bank_details_snapshot TEXT,
  usdt_details_snapshot TEXT,
  bank_micros INTEGER NOT NULL DEFAULT 0 CHECK (bank_micros >= 0),
  usdt_micros INTEGER NOT NULL DEFAULT 0 CHECK (usdt_micros >= 0),
  cash_micros INTEGER NOT NULL DEFAULT 0 CHECK (cash_micros >= 0),
  current_admin_id TEXT,
  negative_carry_entry_id TEXT,
  salary_record_id TEXT,
  employee_notified_at TEXT,
  employee_reminded_at TEXT,
  payment_sent_at TEXT,
  disputed_at TEXT,
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (store_id, telegram_id, scheduled_date)
);
```

Create proof and email tables with the file metadata and claim/retry columns from the design spec. Add indexes for:

```sql
CREATE TABLE payroll_payment_proofs (
  proof_id TEXT PRIMARY KEY,
  payroll_id TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('bank', 'usdt', 'cash')),
  object_key TEXT NOT NULL UNIQUE,
  telegram_file_id TEXT NOT NULL,
  file_name TEXT,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  sort_order INTEGER NOT NULL CHECK (sort_order > 0),
  uploaded_by TEXT NOT NULL,
  superseded_at TEXT,
  uploaded_at TEXT NOT NULL,
  UNIQUE (payroll_id, method, sort_order)
);

CREATE TABLE payroll_email_outbox (
  payroll_id TEXT PRIMARY KEY,
  recipient TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT,
  claimed_at TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_payroll_disbursements_due
  ON payroll_disbursements (status, employee_reminded_at);
CREATE INDEX idx_payroll_disbursements_store_status
  ON payroll_disbursements (store_id, status, scheduled_date);
CREATE INDEX idx_payroll_proofs_payroll_method
  ON payroll_payment_proofs (payroll_id, method, sort_order);
CREATE INDEX idx_payroll_email_delivery
  ON payroll_email_outbox (status, claimed_at);
```

- [ ] **Step 4: Mirror the migration in `db/schema.sql`**

Keep table definitions identical to migration 021. Do not backfill any existing member date in SQL; an invented date would change payroll and absence history.

- [ ] **Step 5: Test migration upgrade and constraints**

Load migrations `001` through `020`, insert representative existing rows, apply migration 021, then prove:

- existing rows remain;
- new member columns are `NULL`;
- invalid statuses, negative split amounts, duplicate payroll cutoffs, duplicate proof order, and duplicate email outbox rows fail;
- positive, zero, and negative snapshot amounts are accepted.

- [ ] **Step 6: Verify and commit**

```bash
node --test test/payroll-settlement.test.js test/payroll-payments.test.js
npm run check
npm test
git add db/migrations/021_personal_payroll_cycle.sql db/schema.sql test/payroll-settlement.test.js test/payroll-payments.test.js
git commit -m "feat: add personal payroll schema"
```

---

### Task 3: Collect the first work date and enforce the absence boundary

**Files:**

- Modify: `src/telegram.js`
- Modify: `src/i18n.js`
- Modify: `src/absence.js`
- Modify: `src/admin-api.js`
- Modify: `src/admin-page.js`
- Modify: `test/telegram-flow.test.js`
- Modify: `test/admin-pagination-leave.test.js`
- Create: `test/admin-payroll.test.js`

**Interfaces:**

- Consumes: `payrollStartDateOptions()` and `validatePayrollStartDate()` from Task 1.
- Produces:

```js
registrationPayrollDateKeyboard(store, now = new Date()) -> TelegramInlineKeyboard
normalizeMemberPayrollStart(body, currentMember, store, now = new Date()) -> {
  payroll_start_date: string | null,
  payroll_automation_started_at: string | null,
  cycle_start: string
}
```

- [ ] **Step 1: Write failing Telegram registration tests**

Require the conversation:

```text
reg:store:<store>
→ WAIT_REGISTER_NAME
→ employee enters display name
→ WAIT_REGISTER_PAYROLL_DATE
→ six inline buttons reg:paydate:<store>:YYYY-MM-DD
→ chosen date is saved on pending member
→ admins are notified only after the date is saved
```

Assert that registration at 04:59 and 05:01 local time exposes the same six-day rule and that tampered callback dates are rejected.

- [ ] **Step 2: Implement the registration adapter**

Change `finishRegistrationRequest()` so it stores the display name in `user_states.data_json` and sends the date keyboard. Add the `reg:paydate` callback handler, validate the store and date again, then insert/update the pending member with:

```js
{
  payroll_start_date: selectedDate,
  payroll_automation_started_at: zonedMidnightIso(selectedDate, store.timezone),
  cycle_start: zonedMidnightIso(selectedDate, store.timezone)
}
```

Approval changes only `status`; it must not overwrite these three values.

- [ ] **Step 3: Write failing admin member tests**

Require:

- member list includes both payroll date fields;
- new or existing members may receive a valid real calendar date;
- a first-time admin assignment preserves the existing `cycle_start`;
- `payroll_automation_started_at` is set to the admin action time;
- clearing an already active automation date is rejected with `payroll_start_date_required`;
- unchanged edits do not restart automation.

- [ ] **Step 4: Implement admin member date management**

For existing employees, calculate:

```js
const startsAutomation = !currentMember?.payroll_start_date && requestedDate;
const nextAutomationStartedAt = startsAutomation
  ? now.toISOString()
  : currentMember?.payroll_automation_started_at ?? null;
```

Do not apply the six-day Telegram window to the admin form. Validate only a real `YYYY-MM-DD` date. Include before/after date values in `update_member` audit details.

- [ ] **Step 5: Write and implement the absence-boundary test**

In every absence candidate query, select `m.payroll_start_date`. Before creating or counting a missing day:

```js
if (!member.payroll_start_date || businessDate < member.payroll_start_date) {
  continue;
}
```

For SQL aggregates, add the equivalent date predicate. A member without a date must not receive new automatic absence fines.

- [ ] **Step 6: Verify and commit**

```bash
node --test test/payroll-cycle.test.js test/telegram-flow.test.js test/admin-payroll.test.js test/admin-pagination-leave.test.js
npm run check
npm test
git add src/telegram.js src/i18n.js src/absence.js src/admin-api.js src/admin-page.js test/telegram-flow.test.js test/admin-payroll.test.js test/admin-pagination-leave.test.js
git commit -m "feat: collect employee payroll start dates"
```

---

### Task 4: Create immutable payroll snapshots from the unified ledger

**Files:**

- Create: `src/payroll-settlement.js`
- Modify: `src/payroll-ledger.js`
- Modify: `src/index.js`
- Modify: `test/payroll-settlement.test.js`

**Interfaces:**

- Consumes:
  - `payrollCutoffsBetween()` from Task 1.
  - `getLedgerTotalIncomeMicros(env, storeId, telegramId, start, end)` from `src/payroll.js`.
  - `payrollEntryInsertStatement()` and ledger validation from `src/payroll-ledger.js`.
- Produces:

```js
eligiblePayrollMembers(env) -> member[]
settlementDraft(member, cutoff, amountMicros, profile, nowIso) -> object
settlePayrollCutoff(env, member, cutoff, now = new Date()) ->
  { created: boolean, payroll: object }
processPayrollSettlements(env, now = new Date()) -> {
  scanned: number,
  created: number,
  skipped_zero: number,
  carried_negative: number
}
```

- [ ] **Step 1: Write failing fixed-boundary tests**

Insert these ledger rows for one member:

```js
[
  ['2026-07-16T02:59:59.999Z', 10_000_000],
  ['2026-07-16T03:00:00.000Z', 20_000_000]
]
```

For a Tokyo local-noon cutoff at `2026-07-16T03:00:00.000Z`, require the first snapshot to equal `10_000_000` and the second entry to remain in the next segment.

- [ ] **Step 2: Write failing positive/zero/negative tests**

Require:

```js
assert.equal(positive.status, 'awaiting_employee_details');
assert.equal(zero.status, 'skipped_zero');
assert.equal(negative.status, 'carried_negative');
```

For the negative case, assert exactly one new ledger row:

```js
{
  type: 'negative_carry',
  amount_micros: negative.amount_snapshot_micros,
  effective_at: negative.cutoff_at,
  source: 'payroll_negative_carry',
  source_id: negative.payroll_id
}
```

The employee `cycle_start` must equal the fixed `cutoff_at` for all three outcomes.

- [ ] **Step 3: Implement the draft and exact aggregation**

Query only:

```sql
SELECT COALESCE(SUM(amount_micros), 0) AS total_micros
FROM payroll_entries
WHERE store_id = ?
  AND telegram_id = ?
  AND effective_at >= ?
  AND effective_at < ?
```

Reject any result that is not a JavaScript safe integer. Snapshot the current profile into the disbursement; a valid saved profile makes the initial positive status `awaiting_admin_payment`, otherwise use `awaiting_employee_details`.

- [ ] **Step 4: Implement one atomic settlement batch**

Use a deterministic payroll ID derived from store, employee, and scheduled date. Prepare these statements in order:

1. insert the disbursement with `INSERT ... SELECT` from `store_members` only when its current `cycle_start` equals the selected `period_start` and the unique cutoff does not already exist;
2. insert the negative-carry ledger row only when the negative disbursement exists and that exact `(source, source_id)` does not;
3. update `store_members.cycle_start` to the fixed cutoff only when its current value still equals the selected `period_start` and the disbursement exists;
4. insert a sanitized audit row only when the disbursement exists and the same action/target audit row does not.

The first statement must use this concurrency gate:

```sql
INSERT INTO payroll_disbursements (
  payroll_id, store_id, telegram_id, payroll_start_date,
  scheduled_date, cycle_day, period_start, cutoff_at,
  amount_snapshot_micros, currency, status,
  created_at, updated_at
)
SELECT ?, m.store_id, m.telegram_id, m.payroll_start_date,
       ?, ?, m.cycle_start, ?, ?, ?, ?, ?, ?
FROM store_members m
WHERE m.store_id = ?
  AND m.telegram_id = ?
  AND m.cycle_start = ?
  AND NOT EXISTS (
    SELECT 1 FROM payroll_disbursements d
    WHERE d.store_id = m.store_id
      AND d.telegram_id = m.telegram_id
      AND d.scheduled_date = ?
  )
```

Run all four through `env.DB.batch()`. Re-read by the unique store/employee/date key and derive `created` from whether its `created_at` equals the current attempt plus the first statement's `meta.changes`. No statement may create a carry or audit row when the guarded disbursement insert did not occur. A unique-constraint error rolls back the batch; then re-read and return the winning row as `created:false`.

- [ ] **Step 5: Prove retries and catch-up**

Tests must show:

- two calls for one cutoff create one disbursement;
- negative retry creates one carry row;
- a delayed scan creates every missed cutoff in chronological order;
- an unfinished prior positive payroll does not block the next cutoff;
- an existing employee with `payroll_automation_started_at` after an old cutoff does not receive an old snapshot;
- a delayed approval for a newly registered employee does catch up from the chosen first-work date;
- Telegram delivery time is never passed into settlement math.

- [ ] **Step 6: Verify and commit**

```bash
node --test test/payroll-settlement.test.js test/payroll-ledger.test.js
npm run check
npm test
git add src/payroll-settlement.js src/payroll-ledger.js src/index.js test/payroll-settlement.test.js
git commit -m "feat: settle personal payroll cutoffs"
```

---

### Task 5: Schedule settlements and retry payday reminders

**Files:**

- Create: `src/payroll-notifications.js`
- Modify: `src/router.js`
- Modify: `src/telegram-client.js`
- Modify: `src/security.js`
- Modify: `test/payroll-settlement.test.js`
- Modify: `test/worker-routing.test.js`

**Interfaces:**

- Consumes: `processAbsenceFines()` and `processPayrollSettlements()`.
- Produces:

```js
deliverPayrollNotifications(env, now = new Date()) -> summary
processScheduledWork(env, now = new Date()) -> {
  absence: object,
  payroll: object,
  notifications: object,
  email: object
}
```

- [ ] **Step 1: Write failing scheduled-work tests**

Require staging with `SCHEDULED_TASKS_ENABLED=false` to perform zero database or network operations. When enabled in a test environment, require the order:

```text
absence → payroll settlement → payroll notifications → email outbox
```

A failure in Telegram delivery must leave the payroll row and immutable cutoff unchanged.

- [ ] **Step 2: Implement the scheduled coordinator**

Replace the single absence call in `router.scheduled()` with:

```js
ctx.waitUntil(processScheduledWork(env, new Date(controller.scheduledTime)));
```

Keep the existing top-level `scheduledTasksEnabled()` gate.

- [ ] **Step 3: Implement notification claim rules**

Select:

- newly created positive payrolls with `employee_notified_at IS NULL`;
- `awaiting_employee_details` rows whose last successful notification/reminder is at least 24 hours old.

Send the fixed payday, store, period, amount, masked profile, and `确认/修改收款信息` callback. On success conditionally update the appropriate timestamp. On failure record only the Telegram error code/description and retry next scheduled run; never rewrite the snapshot.

- [ ] **Step 4: Verify and commit**

```bash
node --test test/payroll-settlement.test.js test/worker-routing.test.js
npm run check
npm test
git add src/payroll-notifications.js src/router.js src/telegram-client.js src/security.js test/payroll-settlement.test.js test/worker-routing.test.js
git commit -m "feat: schedule payroll settlement reminders"
```

---

### Task 6: Save employee payment profiles

**Files:**

- Create: `src/payroll-payments.js`
- Modify: `src/telegram.js`
- Modify: `src/i18n.js`
- Modify: `test/payroll-payments.test.js`
- Modify: `test/telegram-flow.test.js`

**Interfaces:**

- Produces:

```js
maskPaymentValue(value) -> string
validatePaymentProfile(input) -> normalizedProfile
savePaymentProfile(env, actorId, payrollId, input, now = new Date()) -> payroll
paymentMethodKeyboard(payrollId, profile, lang) -> TelegramInlineKeyboard
```

- Profile input is:

```js
{
  accepts_bank: boolean,
  accepts_usdt: boolean,
  accepts_cash: boolean,
  bank_details: string | null,
  usdt_details: string | null
}
```

- [ ] **Step 1: Write failing validation tests**

Require at least one accepted method. Bank requires non-empty bank details; USDT requires non-empty wallet details; cash requires no account. Reject an employee/payroll identity mismatch. Verify masks never expose more than the last four non-space characters.

- [ ] **Step 2: Implement the employee Telegram flow**

Use buttons for method selection and confirmation. Ask for text only when bank or USDT account details are actually required. Save the reusable profile and copy its current values into the specific payroll snapshot in one D1 batch, then conditionally move:

```text
awaiting_employee_details → awaiting_admin_payment
```

Notify authorized store admins after the committed transition.

- [ ] **Step 3: Prove saved-profile reuse and safe modification**

Tests must show:

- the next payroll displays the saved masked profile;
- the employee may edit it before admin payment;
- editing a reusable profile after admin payment does not rewrite an older payroll snapshot;
- ordinary logs and admin list payloads contain only masks.

- [ ] **Step 4: Verify and commit**

```bash
node --test test/payroll-payments.test.js test/telegram-flow.test.js test/security.test.js
npm run check
npm test
git add src/payroll-payments.js src/telegram.js src/i18n.js test/payroll-payments.test.js test/telegram-flow.test.js
git commit -m "feat: collect payroll payment profiles"
```

---

### Task 7: Validate payment splits and store private proof images

**Files:**

- Create: `src/payroll-proofs.js`
- Modify: `src/payroll-payments.js`
- Modify: `src/telegram-client.js`
- Modify: `src/telegram.js`
- Modify: `src/admin-api.js`
- Modify: `test/payroll-payments.test.js`
- Create: `test/payroll-proofs.test.js`
- Modify: `test/telegram-flow.test.js`

**Interfaces:**

- Produces:

```js
validatePaymentSplit(payroll, input) -> {
  bank_micros: number,
  usdt_micros: number,
  cash_micros: number
}
savePaymentSplit(env, adminId, payrollId, input, now = new Date()) -> payroll
proofObjectKey(payroll, method, proofId, extension) -> string
storeTelegramProof(env, adminId, payrollId, method, photo, now = new Date()) -> proof
proofCompletion(env, payrollId) -> {
  complete: boolean,
  missing_methods: string[]
}
readPayrollProof(env, actor, proofId) -> Response
```

- [ ] **Step 1: Write failing split tests**

Cover exact integer micros:

```js
assert.deepEqual(
  validatePaymentSplit(
    { amount_snapshot_micros: 100_000_000, accepts_bank: 1, accepts_usdt: 1, accepts_cash: 1 },
    { bank_micros: 50_000_000, usdt_micros: 30_000_000, cash_micros: 20_000_000 }
  ),
  { bank_micros: 50_000_000, usdt_micros: 30_000_000, cash_micros: 20_000_000 }
);
```

Reject decimals, unsafe integers, negatives, a wrong total, and non-zero electronic methods not accepted by the employee.

- [ ] **Step 2: Implement conditional split submission**

Allow only authorized store admins and status `awaiting_admin_payment` or `disputed`. Save the split, the current admin, and an audit row in one batch. If correcting a disputed payroll, retain old proof metadata for audit but mark it superseded before accepting replacement proofs.

- [ ] **Step 3: Add Telegram file download helpers**

Call Telegram `getFile` using the largest photo size, then download the returned `file_path` from Telegram's authenticated file endpoint:

```text
https://api.telegram.org/file/bot{BOT_TOKEN}/{file_path}
```

Do not log the URL or bot token. Enforce image MIME type and a configured maximum byte size before `env.PAYROLL_PROOFS.put()`.

- [ ] **Step 4: Store the object before metadata and compensate on failure**

Use a non-public key:

```text
payroll/<store_id>/<payroll_id>/<method>/<proof_id>.<extension>
```

Write R2 with `httpMetadata.contentType`, then insert D1 metadata. If D1 insertion fails, delete exactly the newly written key. Never delete or overwrite an existing object key.

- [ ] **Step 5: Require proof completeness**

For each split method with amount greater than zero, require one active proof row. Support multiple images and monotonically increasing `sort_order`. `上传完成` may move the payroll to `awaiting_employee_confirmation` only when every required method is complete.

- [ ] **Step 6: Implement authorized proof reads**

Add:

```text
GET /api/admin/stores/:storeId/payroll/proofs/:proofId
```

for authorized store admins. Employee proof delivery uses the Telegram file ID when possible; any Worker object-read path must independently verify the employee/payroll relationship or admin store permission before `R2.get()`. Return `Cache-Control: private, no-store`.

- [ ] **Step 7: Verify and commit**

```bash
node --test test/payroll-payments.test.js test/payroll-proofs.test.js test/telegram-flow.test.js test/admin-payroll.test.js
npm run check
npm test
git add src/payroll-proofs.js src/payroll-payments.js src/telegram-client.js src/telegram.js src/admin-api.js test/payroll-payments.test.js test/payroll-proofs.test.js test/telegram-flow.test.js test/admin-payroll.test.js
git commit -m "feat: store private payroll payment proofs"
```

---

### Task 8: Confirm, dispute, and create the formal salary record

**Files:**

- Modify: `src/payroll-payments.js`
- Modify: `src/payroll-notifications.js`
- Modify: `src/telegram.js`
- Modify: `src/i18n.js`
- Modify: `test/payroll-payments.test.js`
- Modify: `test/telegram-flow.test.js`

**Interfaces:**

- Produces:

```js
sendPayrollForEmployeeConfirmation(env, adminId, payrollId, now = new Date()) -> payroll
confirmPayrollReceipt(env, employeeId, payrollId, financeEmail, now = new Date()) -> payroll
disputePayrollPayment(env, employeeId, payrollId, now = new Date()) -> payroll
```

- [ ] **Step 1: Write failing confirmation and concurrency tests**

Require one successful transition:

```text
awaiting_employee_confirmation → confirmed
```

and one deterministic salary record:

```js
{
  record_id: `SAL-AUTO-${payroll.payroll_id}`,
  request_id: payroll.payroll_id,
  amount: payroll.amount_snapshot_micros / 1_000_000,
  period_start: payroll.period_start,
  period_end: payroll.cutoff_at,
  approved_at: confirmedAt,
  admin_id: payroll.current_admin_id
}
```

Two repeated/concurrent confirmations must create one salary record and one outbox row.

- [ ] **Step 2: Implement atomic confirmation**

Use one D1 batch whose inserts all select from the payroll row while its status is `awaiting_employee_confirmation`, followed by the conditional status update:

1. insert deterministic `salary_records`;
2. insert one `payroll_email_outbox`;
3. insert sanitized confirmation audit;
4. update status and timestamps.

Return `already_processed` when the conditional update changes zero rows. Confirmation must not change `cycle_start`, `period_start`, `cutoff_at`, or the snapshot.

- [ ] **Step 3: Implement disputes and corrections**

The employee-only dispute callback conditionally changes:

```text
awaiting_employee_confirmation → disputed
```

Notify store admins with the payroll ID and masked summary. Admin correction reuses Task 7's split/proof flow and sends a new confirmation request without deleting the original payroll, audit rows, or superseded proof metadata.

- [ ] **Step 4: Prove next-cycle independence**

Create a disputed or unconfirmed payroll, run a later cutoff, and assert a distinct later disbursement is created with a new period and amount.

- [ ] **Step 5: Verify and commit**

```bash
node --test test/payroll-payments.test.js test/telegram-flow.test.js test/payroll-settlement.test.js
npm run check
npm test
git add src/payroll-payments.js src/payroll-notifications.js src/telegram.js src/i18n.js test/payroll-payments.test.js test/telegram-flow.test.js test/payroll-settlement.test.js
git commit -m "feat: confirm and dispute payroll payments"
```

---

### Task 9: Send finance email from an independent outbox

**Files:**

- Create: `src/payroll-email.js`
- Modify: `src/router.js`
- Modify: `src/security.js`
- Modify: `wrangler.toml`
- Create: `test/payroll-email.test.js`
- Modify: `test/staging-config.test.js`
- Modify: `test/worker-routing.test.js`

**Interfaces:**

- Produces:

```js
payrollEmailConfig(env) -> {
  recipient: string,
  sender: string,
  ready: boolean
}
renderPayrollEmail(payroll, proofs) -> {
  subject: string,
  text: string
}
deliverPayrollEmailOutbox(env, now = new Date()) -> summary
```

- [ ] **Step 1: Write failing render and redaction tests**

Require store, employee, period, snapshot, split, admin, confirmation time, and proof count/object references. Do not include bot token, public R2 URLs, or unmasked reusable-profile values outside the specific confirmed payroll snapshot.

- [ ] **Step 2: Write failing outbox retry tests**

Require:

- missing binding/config leaves the row pending with a sanitized error;
- a send failure increments `attempt_count` and does not modify confirmed payroll;
- a later success marks only the outbox row sent;
- two workers cannot successfully claim the same pending row.

- [ ] **Step 3: Implement claim/send/finalize**

Claim with a conditional update from `pending` or an expired `sending` lease to `sending`, increment attempts, render after claim, then call the `PAYROLL_EMAIL` binding. Mark `sent` only after the binding succeeds. Store only a bounded, sanitized error string.

- [ ] **Step 4: Configure verified-address bindings only after values exist**

After the user supplies a verified finance recipient and verified sender, write those exact values into one staging `send_email` binding named `PAYROLL_EMAIL` plus `PAYROLL_FINANCE_EMAIL` and `PAYROLL_FROM_EMAIL` staging variables. Do not invent addresses and do not add a production binding in this task. Until the values are supplied, keep `wrangler.toml` unchanged, complete the source implementation and mock tests, and record live email as a remaining staging acceptance gate.

- [ ] **Step 5: Verify and commit**

```bash
node --test test/payroll-email.test.js test/staging-config.test.js test/worker-routing.test.js
npm run check
npm test
git add src/payroll-email.js src/router.js src/security.js wrangler.toml test/payroll-email.test.js test/staging-config.test.js test/worker-routing.test.js
git commit -m "feat: deliver payroll confirmation emails"
```

If verified addresses have not been supplied, omit `wrangler.toml` from the commit and use:

```bash
git add src/payroll-email.js src/router.js src/security.js test/payroll-email.test.js test/staging-config.test.js test/worker-routing.test.js
git commit -m "feat: add payroll email outbox delivery"
```

---

### Task 10: Add automatic payroll administration and retire new salary requests

**Files:**

- Modify: `src/admin-api.js`
- Modify: `src/admin-page.js`
- Modify: `src/telegram.js`
- Modify: `src/i18n.js`
- Modify: `test/admin-payroll.test.js`
- Modify: `test/worker-routing.test.js`
- Modify: `test/telegram-flow.test.js`

**Interfaces:**

- Produces:
  - `GET /api/admin/stores/:storeId/payroll`
  - `GET /api/admin/stores/:storeId/payroll/:payrollId`
  - `POST /api/admin/stores/:storeId/payroll/:payrollId/split`
  - existing proof-read route from Task 7

- [ ] **Step 1: Write failing API authorization and list tests**

Require store-scoped authorization and paginated rows with:

```text
employee
scheduled_date
period_start
cutoff_at
amount_snapshot_micros
currency
bank_micros
usdt_micros
cash_micros
status
current_admin_id
confirmed_at
proof_count
email_status
```

Return masked account values in lists. Reject cross-store payroll and proof access.

- [ ] **Step 2: Implement fixed-count list/detail queries**

Use one aggregate proof/email join per page rather than one query per payroll. Detail may return active and superseded proof metadata but never a public object URL.

- [ ] **Step 3: Render the admin workflow**

Keep old salary requests and historical salary records in clearly labeled read-only/history sections. Add the automatic payroll table and detail actions for split entry, proof progress, dispute correction, and status. Use server-provided micros; the browser only formats them and never calculates authoritative totals.

- [ ] **Step 4: Remove only the active old request entry**

Remove `申请工资` from the persistent employee menu and help copy. `/salary`, translated button labels, and old callback replay must not create a new `salary_requests` row; respond with the new automatic-payroll explanation. Keep old admin approval/rejection handlers so pre-existing pending requests can be handled separately.

- [ ] **Step 5: Verify regression coverage**

Require:

- old pending request approval still works;
- a new `/salary` message creates no row;
- income, fine, advance, attendance, leave, absence, Dashboard, and legacy history tests still pass;
- production admin HTML does not accidentally expose staging-only proof configuration.

- [ ] **Step 6: Verify and commit**

```bash
node --test test/admin-payroll.test.js test/worker-routing.test.js test/telegram-flow.test.js test/approval-regression.test.js
npm run check
npm test
git add src/admin-api.js src/admin-page.js src/telegram.js src/i18n.js test/admin-payroll.test.js test/worker-routing.test.js test/telegram-flow.test.js
git commit -m "feat: administer automatic payroll"
```

---

### Task 11: Migrate and accept the complete staging workflow

**Files:**

- Modify: `docs/ROADMAP.md`
- Create: `docs/reports/2026-07-29-staging-personal-payroll-validation.md`

**Interfaces:**

- Consumes all prior tasks.
- Produces reproducible staging evidence and no production mutation.

- [ ] **Step 1: Run the local release gate**

```bash
npm run check
npm test
npm run test:ledger
npm run test:staging
git diff --check
git status --short
```

Expected: all checks pass and only intended committed changes exist.

- [ ] **Step 2: Prove the migration target before applying it**

```bash
npx wrangler whoami
npx wrangler d1 migrations list staffbot_v2_staging --env staging --remote
```

Record the database name/ID and confirm it is `staffbot_v2_staging`, not production.

- [ ] **Step 3: Apply migration 021 to staging only**

```bash
npx wrangler d1 migrations apply staffbot_v2_staging --env staging --remote
```

Then query table/column/index existence and verify every existing member has `NULL` payroll dates until explicitly assigned.

- [ ] **Step 4: Deploy staging with automation still disabled**

```bash
npx wrangler deploy --env staging
```

Verify `/`, `/admin`, authentication, existing tabs, Dashboard, and automatic payroll list. Confirm production version and production D1 migration state are unchanged.

- [ ] **Step 5: Run controlled payroll fixtures**

Use only existing staging employees/test identities approved by the user. Create ledger fixtures around one fixed cutoff and verify:

- positive, zero, and negative outcomes;
- exact noon boundary;
- one negative carry;
- duplicate scan idempotency;
- prior unfinished payroll plus later independent payroll;
- old `/salary` cannot create a request.

- [ ] **Step 6: Run live Telegram and private R2 acceptance**

With the allowlisted staging bot:

1. register/select a first-work date using buttons;
2. receive a payday reminder;
3. save/modify payment profile;
4. submit a split;
5. upload multiple images for one method and one for each other non-zero method;
6. prove R2 objects are not public;
7. receive payment proof messages;
8. dispute once, correct, resend, and confirm.

Inspect console/log output and confirm no bank/wallet/token/object body leakage.

- [ ] **Step 7: Run live email acceptance**

Only after the user supplies verified finance sender/destination values, configure the staging binding, deploy staging again, confirm one payroll, and verify one received email. Force or simulate one failed attempt and show that payroll stays confirmed while the outbox retries.

- [ ] **Step 8: Controlled cron acceptance**

Temporarily enable the staging cron only with separate explicit approval. Verify one scheduled run, duplicate safety, catch-up, 24-hour reminder selection, and email delivery. Disable staging scheduled tasks again after evidence is captured unless the user explicitly asks to keep them enabled.

- [ ] **Step 9: Record evidence and update the roadmap**

The report must include:

- branch and commits;
- Worker staging URL and version;
- migration list;
- local test counts;
- exact fixture IDs and expected/actual amounts;
- Telegram/R2/email evidence without secrets;
- scheduled-task state after testing;
- known remaining configuration;
- production Worker version and production migration list showing no change.

Mark Phase 10 `🧪` only after every required staging gate passes. If live email or cron is not yet tested, keep it `⏳` and state the exact remaining gate.

- [ ] **Step 10: Commit the report**

```bash
git add docs/ROADMAP.md docs/reports/2026-07-29-staging-personal-payroll-validation.md
git commit -m "docs: record personal payroll staging proof"
```

## Self-Review Results

- **Spec coverage:** All 23 acceptance criteria map to Tasks 1 through 11. The first-work-date rule is Task 1/3; fixed cutoffs and amount boundaries are Task 4; positive/zero/negative behavior is Task 4; payment profiles are Task 6; split/proofs are Task 7; confirmation/dispute/formal salary records are Task 8; email is Task 9; old flow preservation/removal is Task 10; remote staging proof is Task 11.
- **Ledger alignment:** The original design's legacy negative-carry write is superseded by the confirmed unified-ledger architecture. New negative carry is written only to `payroll_entries.amount_micros`.
- **External configuration:** Finance recipient and sender addresses are not guessed. They block only live email acceptance, not local implementation or the rest of staging validation.
- **Production boundary:** No task authorizes production migration, production deploy, merge, or production binding changes.
- **Completeness scan:** The implementation steps contain no deferred implementation detail, speculative feature, framework addition, or undefined cross-task dependency. Verified email addresses remain an explicit external staging-acceptance input and are never guessed.
