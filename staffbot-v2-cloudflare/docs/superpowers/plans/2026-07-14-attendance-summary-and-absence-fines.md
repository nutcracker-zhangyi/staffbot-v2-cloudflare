# Attendance Summary and Absence Fines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show attractive multi-employee attendance statistics and create editable absence fines only after an administrator approves an automatically detected absence.

**Architecture:** Keep the existing single-Worker architecture and add one D1 table for absence approvals plus three store settings. An hourly Worker Cron scans each store only through its last completed business day, Telegram callbacks approve or reject the proposed fine, and the existing `income_records` fine path remains the financial source of truth. The attendance API calculates complete server-side totals per store and employee, while the existing admin page renders aggregate cards, a sortable employee summary, and the existing detail tables.

**Tech Stack:** Cloudflare Workers ES modules, Cloudflare D1/SQLite, Wrangler Cron Triggers, Telegram Bot API inline keyboards, server-rendered vanilla HTML/CSS/JavaScript, Node.js built-in test runner.

## Global Constraints

- Employees are expected to work every calendar day, including weekends.
- Only an approved leave request excuses an absence.
- Historical absences may be displayed, but absence approvals and fines begin on the store's current enable date and are never backfilled earlier.
- A store's VND absence fine setting `1.5` means an actual fine of `1,500,000₫`, using the existing `attendanceFineAmount()` conversion.
- The Cron job creates a pending approval after local noon on the following day; it never creates a formal fine directly.
- An approved absence creates one editable `income_records` row with `type = 'fine'` and `source = 'attendance_absence'`.
- A later approved leave cancels the absence; an already-created formal fine keeps `original_fine` and changes `fine` to `0`.
- The admin UI must reuse the current dark theme, CSS variables, table behavior, and responsive horizontal scrolling; do not add a UI dependency.
- Statistics operate on the full filtered result, not the current detail-table page.
- Touch only `db/schema.sql`, one new migration, `src/index.js`, `wrangler.toml`, and the existing test files named below.

---

## File Map

- Create `db/migrations/016_absence_fine_requests.sql`: store settings, absence approval table, and financial idempotency index.
- Modify `db/schema.sql`: make fresh databases match migration 016.
- Modify `src/index.js`: store normalization and form fields, scheduled scan, notification and approval callbacks, leave cancellation, attendance statistics API, and admin UI.
- Modify `wrangler.toml`: hourly Cron Trigger.
- Modify `test/admin-pagination-leave.test.js`: date-window, callback-size, admin UI, and source-structure regression tests.
- Modify `test/money.test.js`: absence-fine amount and approval-draft unit tests.

---

### Task 1: Persist absence settings and approval records

**Files:**
- Create: `db/migrations/016_absence_fine_requests.sql`
- Modify: `db/schema.sql`
- Modify: `src/index.js` in `listAdminStores`, `createAdminStore`, `updateAdminStore`, `normalizeStoreInput`, `adminHtml`, `renderStores`, and `fillStoreForm`
- Test: `test/admin-pagination-leave.test.js`

**Interfaces:**
- Consumes: existing `attendanceFineAmount(store, amount)`, `localDate(date, timezone)`, and store CRUD functions.
- Produces: store fields `absence_fine`, `absence_fine_enabled_at`, and `absence_last_checked_date`; D1 table `absence_fine_requests`; `normalizeAbsenceFineSetting(input, currentStore, now)`.

- [ ] **Step 1: Write failing store-setting and schema tests**

Add `normalizeAbsenceFineSetting` to the imports in `test/admin-pagination-leave.test.js`, then add:

```js
test('enables absence fines from the current store-local date only', () => {
  const now = new Date('2026-07-14T03:30:00.000Z');
  assert.deepEqual(normalizeAbsenceFineSetting(
    { absence_fine_enabled: true, absence_fine: '1.5' },
    { timezone: 'Asia/Tokyo', absence_fine_enabled_at: null },
    now
  ), {
    absence_fine: 1.5,
    absence_fine_enabled_at: '2026-07-14T03:30:00.000Z',
    absence_last_checked_date: '2026-07-13'
  });
});

test('keeps enable time while enabled and resets it after re-enabling', () => {
  const current = {
    timezone: 'Asia/Tokyo',
    absence_fine: 1.5,
    absence_fine_enabled_at: '2026-07-01T00:00:00.000Z',
    absence_last_checked_date: '2026-07-12'
  };
  assert.equal(normalizeAbsenceFineSetting(
    { absence_fine_enabled: true, absence_fine: '2' }, current,
    new Date('2026-07-14T03:30:00.000Z')
  ).absence_fine_enabled_at, current.absence_fine_enabled_at);
  assert.deepEqual(normalizeAbsenceFineSetting(
    { absence_fine_enabled: false, absence_fine: '2' }, current,
    new Date('2026-07-14T03:30:00.000Z')
  ), {
    absence_fine: 2,
    absence_fine_enabled_at: null,
    absence_last_checked_date: null
  });
});

test('admin store form exposes absence fine controls', () => {
  assert.match(source, /storeAbsenceFineEnabledInput/);
  assert.match(source, /storeAbsenceFineInput/);
  assert.match(source, /absence_fine_enabled/);
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
node --test test/admin-pagination-leave.test.js
```

Expected: FAIL because `normalizeAbsenceFineSetting` is not exported and the store form controls do not exist.

- [ ] **Step 3: Add migration 016 and update the canonical schema**

Create `db/migrations/016_absence_fine_requests.sql` with:

```sql
ALTER TABLE stores ADD COLUMN absence_fine REAL NOT NULL DEFAULT 1.5;
ALTER TABLE stores ADD COLUMN absence_fine_enabled_at TEXT;
ALTER TABLE stores ADD COLUMN absence_last_checked_date TEXT;

CREATE TABLE IF NOT EXISTS absence_fine_requests (
  request_id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL,
  telegram_id TEXT NOT NULL,
  business_date TEXT NOT NULL,
  original_fine REAL NOT NULL,
  fine REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  notified_at TEXT,
  decided_at TEXT,
  admin_id TEXT,
  reject_reason TEXT,
  income_record_id TEXT,
  UNIQUE (store_id, telegram_id, business_date)
);

CREATE INDEX IF NOT EXISTS idx_absence_fine_store_status_date
  ON absence_fine_requests (store_id, status, business_date);

CREATE UNIQUE INDEX IF NOT EXISTS idx_income_records_one_absence_fine
  ON income_records (source, request_id)
  WHERE source = 'attendance_absence';
```

Apply the same three store columns, table, and indexes to `db/schema.sql`. Add the three store columns to the seed `INSERT INTO stores` column list and values, using `1.5`, `NULL`, and `NULL`.

- [ ] **Step 4: Implement store-setting normalization and persistence**

Add this exported helper near `normalizeStoreInput`:

```js
export function normalizeAbsenceFineSetting(input, currentStore = {}, now = new Date()) {
  const rawFine = Number(input && input.absence_fine);
  const absenceFine = Number.isFinite(rawFine) && rawFine >= 0
    ? rawFine
    : Number(currentStore.absence_fine ?? 1.5);
  const enabled = input && input.absence_fine_enabled === true;
  if (!enabled) {
    return {
      absence_fine: absenceFine,
      absence_fine_enabled_at: null,
      absence_last_checked_date: null
    };
  }
  if (currentStore.absence_fine_enabled_at) {
    return {
      absence_fine: absenceFine,
      absence_fine_enabled_at: currentStore.absence_fine_enabled_at,
      absence_last_checked_date: currentStore.absence_last_checked_date || null
    };
  }
  const timezone = currentStore.timezone || input.timezone || 'Asia/Tokyo';
  const enabledDate = localDate(now, timezone);
  return {
    absence_fine: absenceFine,
    absence_fine_enabled_at: now.toISOString(),
    absence_last_checked_date: addIsoDays(enabledDate, -1)
  };
}
```

Include the three fields in store SELECT/INSERT/UPDATE lists. For a new store call `normalizeAbsenceFineSetting(body, normalizedStore, new Date())`; for an update call it with the existing store row so changing only the amount does not reset the enable date. Treat the checkbox JSON value as a real boolean, not a truthy string.

- [ ] **Step 5: Add attractive store controls without changing the visual system**

Add translations for `absence_fine_enabled` and `absence_fine` in all four existing language maps. In the store grid render:

```js
'<label>' + L('absence_fine_enabled') +
  '<select id="storeAbsenceFineEnabledInput"><option value="false">' + L('disable') +
  '</option><option value="true">' + L('enable') + '</option></select></label>' +
'<label>' + L('absence_fine') +
  '<input id="storeAbsenceFineInput" inputmode="decimal" value="1.5"></label>'
```

Send `absence_fine_enabled: $('storeAbsenceFineEnabledInput').value === 'true'` and `absence_fine: $('storeAbsenceFineInput').value` in the save body. Populate both controls in `fillStoreForm`, and include the amount and enabled state in the stores table without exposing the internal enable timestamp or checkpoint date.

- [ ] **Step 6: Run checks and commit Task 1**

Run:

```bash
npm run check
node --test test/admin-pagination-leave.test.js
npm test
```

Expected: all commands exit 0.

Commit:

```bash
git add db/schema.sql db/migrations/016_absence_fine_requests.sql src/index.js test/admin-pagination-leave.test.js
git commit -m "feat: add store absence fine settings"
```

---

### Task 2: Detect completed-day absences with an idempotent Cron scan

**Files:**
- Modify: `src/index.js` in the default export and near attendance helpers
- Modify: `wrangler.toml`
- Test: `test/admin-pagination-leave.test.js`

**Interfaces:**
- Consumes: Task 1 store fields and `absence_fine_requests`; existing `attendanceFineAmount`, `notifyStoreAdmins`, `localDate`, `localParts`, and `addIsoDays`.
- Produces: `completedAttendanceDate(now, timezone)`, `absenceScanDates(store, now)`, `absenceApprovalKeyboard(requestId)`, `processAbsenceFines(env, now)`; Worker `scheduled()` handler.

- [ ] **Step 1: Write failing completed-day, catch-up, and callback tests**

Import `absenceApprovalKeyboard`, `absenceScanDates`, and `completedAttendanceDate`, then add:

```js
test('closes the previous business day at store-local noon', () => {
  assert.equal(completedAttendanceDate(new Date('2026-07-15T02:59:00.000Z'), 'Asia/Tokyo'), '2026-07-13');
  assert.equal(completedAttendanceDate(new Date('2026-07-15T03:00:00.000Z'), 'Asia/Tokyo'), '2026-07-14');
  assert.equal(completedAttendanceDate(new Date('2026-07-15T05:00:00.000Z'), 'Asia/Ho_Chi_Minh'), '2026-07-14');
});

test('returns every unprocessed enabled date through the completed date', () => {
  const store = {
    timezone: 'Asia/Tokyo',
    absence_fine_enabled_at: '2026-07-12T03:00:00.000Z',
    absence_last_checked_date: '2026-07-12'
  };
  assert.deepEqual(absenceScanDates(store, new Date('2026-07-15T03:10:00.000Z')), [
    '2026-07-13',
    '2026-07-14'
  ]);
  assert.deepEqual(absenceScanDates({ ...store, absence_fine_enabled_at: null }, new Date('2026-07-15T03:10:00.000Z')), []);
});

test('keeps absence approval callbacks below Telegram limit', () => {
  const requestId = 'ABS-01f21cc1-dcff-4f1a-9bf8-2008d650d46e';
  const buttons = absenceApprovalKeyboard(requestId).flat();
  assert.deepEqual(buttons.map((button) => button.callback_data), [
    `abs:a:${requestId}`,
    `abs:r:${requestId}`
  ]);
  assert.ok(buttons.every((button) => Buffer.byteLength(button.callback_data, 'utf8') <= 64));
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run `node --test test/admin-pagination-leave.test.js`.

Expected: FAIL because the three exports do not exist.

- [ ] **Step 3: Implement the pure scan-window helpers**

Add:

```js
export function completedAttendanceDate(now = new Date(), timezone = 'Asia/Tokyo') {
  const today = localDate(now, timezone);
  const hour = Number(localParts(now, timezone).hour);
  return addIsoDays(today, hour >= 12 ? -1 : -2);
}

export function absenceScanDates(store, now = new Date()) {
  if (!store || !store.absence_fine_enabled_at) return [];
  const timezone = store.timezone || 'Asia/Tokyo';
  const enabledDate = localDate(new Date(store.absence_fine_enabled_at), timezone);
  const firstDate = store.absence_last_checked_date
    ? addIsoDays(store.absence_last_checked_date, 1)
    : enabledDate;
  const finalDate = completedAttendanceDate(now, timezone);
  const dates = [];
  for (let date = firstDate; date <= finalDate; date = addIsoDays(date, 1)) dates.push(date);
  return dates;
}

export function absenceApprovalKeyboard(requestId) {
  return [[
    { text: '批准罚款', callback_data: compactCallbackData('abs', 'a', requestId) },
    { text: '驳回', callback_data: compactCallbackData('abs', 'r', requestId) }
  ]];
}
```

Do not put `store_id` in the callback; the approval handler must load the request first and authorize against its stored `store_id`.

- [ ] **Step 4: Implement the idempotent store scan**

Add `processAbsenceFines(env, now = new Date())`. It must:

1. Select active stores where `absence_fine_enabled_at IS NOT NULL`.
2. For every date returned by `absenceScanDates`, select active employees for whom no `attendance_records.type = 'checkin'` and no `leave_requests.status = 'approved'` exists on that date, then keep only rows where `localDate(new Date(member.joined_at), store.timezone) <= businessDate`.
3. Insert each candidate with `INSERT OR IGNORE`, a generated `ABS` request ID, and `attendanceFineAmount(store, store.absence_fine)` in both fine columns.
4. Update `stores.absence_last_checked_date` only after all candidates for that date have been inserted.
5. Select pending rows with `notified_at IS NULL`, notify the store admins with store, employee, business date, and formatted proposed fine, and set `notified_at` only after `notifyStoreAdmins` resolves.

Use this candidate query shape so employees with no attendance rows are included:

```sql
SELECT m.telegram_id,
       m.joined_at,
       COALESCE(NULLIF(m.display_name, ''), NULLIF(u.name, ''), NULLIF(u.username, ''), m.telegram_id) AS display_name
FROM store_members m
LEFT JOIN users u ON u.telegram_id = m.telegram_id
WHERE m.store_id = ?
  AND m.status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM attendance_records a
    WHERE a.store_id = m.store_id
      AND a.telegram_id = m.telegram_id
      AND a.business_date = ?
      AND a.type = 'checkin'
  )
  AND NOT EXISTS (
    SELECT 1 FROM leave_requests l
    WHERE l.store_id = m.store_id
      AND l.telegram_id = m.telegram_id
      AND l.leave_date = ?
      AND l.status = 'approved'
  )
```

- [ ] **Step 5: Register the scheduled handler and Cron**

Add a comma after the existing `fetch` method and add this sibling property inside the existing default-export object:

```js
async scheduled(controller, env, ctx) {
  ctx.waitUntil(processAbsenceFines(env, new Date(controller.scheduledTime)));
}
```

Add to `wrangler.toml`:

```toml
[triggers]
crons = ["10 * * * *"]
```

- [ ] **Step 6: Run checks and commit Task 2**

Run:

```bash
npm run check
node --test test/admin-pagination-leave.test.js
npm test
```

Expected: all commands exit 0.

Commit:

```bash
git add src/index.js wrangler.toml test/admin-pagination-leave.test.js
git commit -m "feat: detect absences on store schedules"
```

---

### Task 3: Approve, reject, edit, and cancel absence fines

**Files:**
- Modify: `src/index.js` in Telegram callbacks, leave approval, and fine-record helpers
- Test: `test/money.test.js`
- Test: `test/admin-pagination-leave.test.js`

**Interfaces:**
- Consumes: Tasks 1-2 `absence_fine_requests` and `absenceApprovalKeyboard`; existing `updateIncomeFineRecord` provides post-approval editing.
- Produces: `absenceFineRecordDraft(request, adminId, decidedAt, recordId)`, `approveAbsenceFineRequest`, `rejectAbsenceFineRequest`, and `cancelAbsenceForApprovedLeave`.

- [ ] **Step 1: Write failing financial-draft and callback-routing tests**

Import `absenceFineRecordDraft` in `test/money.test.js` and add:

```js
test('creates one editable income fine from an approved absence', () => {
  assert.deepEqual(absenceFineRecordDraft({
    request_id: 'ABS-1',
    store_id: 'STORE1',
    telegram_id: 'U1',
    original_fine: 1500000,
    fine: 1500000
  }, 'ADMIN1', '2026-07-15T03:10:00.000Z', 'REC-1'), {
    record_id: 'REC-1',
    store_id: 'STORE1',
    telegram_id: 'U1',
    income: 0,
    commission_rate: 0.6,
    commission_income: 0,
    original_fine: 1500000,
    fine: 1500000,
    type: 'fine',
    source: 'attendance_absence',
    request_id: 'ABS-1',
    approved_at: '2026-07-15T03:10:00.000Z',
    admin_id: 'ADMIN1'
  });
});
```

Add source assertions to `test/admin-pagination-leave.test.js`:

```js
test('routes compact absence approval callbacks through store authorization', () => {
  assert.match(source, /parts\[0\] === 'abs'/);
  assert.match(source, /approveAbsenceFineRequest/);
  assert.match(source, /rejectAbsenceFineRequest/);
  assert.match(source, /cancelAbsenceForApprovedLeave/);
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
node --test test/money.test.js test/admin-pagination-leave.test.js
```

Expected: FAIL because the draft helper and callback routes do not exist.

- [ ] **Step 3: Implement the formal fine draft and approval transaction**

Add:

```js
export function absenceFineRecordDraft(request, adminId, decidedAt, recordId) {
  return {
    record_id: recordId,
    store_id: request.store_id,
    telegram_id: request.telegram_id,
    income: 0,
    commission_rate: 0.6,
    commission_income: 0,
    original_fine: Number(request.original_fine || 0),
    fine: Number(request.fine || 0),
    type: 'fine',
    source: 'attendance_absence',
    request_id: request.request_id,
    approved_at: decidedAt,
    admin_id: adminId
  };
}
```

Implement `approveAbsenceFineRequest` so the insert is guarded by `SELECT ... FROM absence_fine_requests WHERE request_id = ? AND status = 'pending'`, then updates only that pending row to approved and stores the record ID. The unique partial index from Task 1 is the final duplicate barrier. Use `env.DB.batch` and audit `approve_absence_fine`.

Implement `rejectAbsenceFineRequest` with `UPDATE ... WHERE status = 'pending'`, `decided_at`, `admin_id`, and a fixed reason `Rejected by admin`, then audit `reject_absence_fine`.

- [ ] **Step 4: Route Telegram callbacks and edit the notification message**

In `handleCallback`, add an `abs` branch before the final fallback:

```js
if (parts[0] === 'abs') {
  const requestId = parts[2] || '';
  const request = await env.DB.prepare(
    `SELECT * FROM absence_fine_requests WHERE request_id = ?`
  ).bind(requestId).first();
  if (!request || !(await isStoreAdmin(env, userId, request.store_id))) {
    await audit(env, request ? request.store_id : DEFAULT_STORE_ID, userId, 'unauthorized_absence_callback', data, {});
    return answerCallback(env, callback.id, t(lang, 'no_permission'), true);
  }
  if (parts[1] === 'a') return approveAbsenceFine(env, callback, userId, request, lang);
  if (parts[1] === 'r') return rejectAbsenceFine(env, callback, userId, request, lang);
}
```

The wrapper functions must call the request helpers, edit the original Telegram message with the final decision, answer the callback, and do nothing financial when the request is no longer pending.

- [ ] **Step 5: Cancel or waive absence fines when leave is later approved**

Implement `cancelAbsenceForApprovedLeave(env, storeId, telegramId, leaveDate, adminId)`:

1. Load the matching absence request in `pending`, `approved`, or `rejected` state.
2. If approved and linked to an income record, update that row to `fine = 0` while leaving `original_fine` unchanged.
3. Update the absence request to `cancelled`, set `reject_reason = 'Approved leave'`, and preserve existing decision fields with `COALESCE(decided_at, ?)` and `COALESCE(admin_id, ?)`.
4. Audit `cancel_absence_for_leave`.

Call this helper from `approveLeaveRequest` after the leave row becomes approved. Because both Telegram and admin-site leave approval use `approveLeaveRequest`, one hook covers both paths.

- [ ] **Step 6: Prove the existing edit path accepts absence fines**

Keep `updateIncomeFineRecord` unchanged: it already accepts every `income_records` row where `type === 'fine'`. Add this regression assertion:

```js
test('absence fines use the existing editable fine record path', () => {
  assert.match(source, /found\.type !== 'fine'/);
  assert.match(source, /source: 'attendance_absence'/);
});
```

- [ ] **Step 7: Run checks and commit Task 3**

Run `npm run check && npm test`.

Expected: both commands exit 0.

Commit:

```bash
git add src/index.js test/money.test.js test/admin-pagination-leave.test.js
git commit -m "feat: approve and waive absence fines"
```

---

### Task 4: Return full-range aggregate and per-employee attendance statistics

**Files:**
- Modify: `src/index.js` in `handleAdminAttendance` and new attendance-summary helpers
- Test: `test/admin-pagination-leave.test.js`

**Interfaces:**
- Consumes: Task 1 absence requests and existing `adminFilters`; attendance fine sources `attendance_late`, `attendance_early`, and `attendance_absence`.
- Produces: API properties `summary` and `employee_stats`; `sumAttendanceEmployeeStats(rows)`.

- [ ] **Step 1: Write failing aggregate-helper and API-shape tests**

Import `sumAttendanceEmployeeStats` and add:

```js
test('sums person-day attendance rows without using pagination', () => {
  assert.deepEqual(sumAttendanceEmployeeStats([
    { work_days: 2, late_days: 1, absence_days: 0, leave_days: 1, fine_total: 500000 },
    { work_days: 1, late_days: 0, absence_days: 2, leave_days: 0, fine_total: 1500000 }
  ]), {
    work_days: 3,
    late_days: 1,
    absence_days: 2,
    leave_days: 1,
    fine_total: 2000000
  });
});

test('attendance API returns summary and employee statistics', () => {
  assert.match(source, /employee_stats/);
  assert.match(source, /summary: sumAttendanceEmployeeStats/);
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run `node --test test/admin-pagination-leave.test.js`.

Expected: FAIL because `sumAttendanceEmployeeStats` is not exported and the endpoint lacks both properties.

- [ ] **Step 3: Implement deterministic row aggregation**

Add:

```js
export function sumAttendanceEmployeeStats(rows) {
  return (rows || []).reduce((total, row) => ({
    work_days: total.work_days + Number(row.work_days || 0),
    late_days: total.late_days + Number(row.late_days || 0),
    absence_days: total.absence_days + Number(row.absence_days || 0),
    leave_days: total.leave_days + Number(row.leave_days || 0),
    fine_total: total.fine_total + Number(row.fine_total || 0)
  }), { work_days: 0, late_days: 0, absence_days: 0, leave_days: 0, fine_total: 0 });
}
```

- [ ] **Step 4: Query one complete statistics row per store employee**

Add `attendanceEmployeeStats(env, filters, now = new Date())`. Run one query per selected store so each store uses its own timezone and completed date. The query must start from active `store_members`, apply the optional employee filter, and produce:

- `work_days`: distinct check-in business dates inside the member's eligible range.
- `late_days`: distinct late check-in dates inside that range.
- `leave_days`: distinct approved leave dates inside that range.
- `absence_days`: inclusive eligible calendar days minus the distinct union of check-in dates and approved leave dates.
- `fine_total`: formal fine rows joined back to their source business date: attendance record for `attendance_late`/`attendance_early`, absence request for `attendance_absence`.

For each member define:

```text
start_date = later of selected start date and store-local joined date
end_date   = earlier of selected inclusive end date and completedAttendanceDate(now, store.timezone)
```

When the filter omits a start date, use the member's store-local joined date. When it omits an end date, use the completed attendance date. If `start_date > end_date`, return zeros for that member. Count the union of work and approved-leave dates so a malformed same-day work-plus-leave combination cannot make absence negative.

Return fields:

```js
{
  store_id,
  store_name,
  telegram_id,
  display_name,
  work_days,
  late_days,
  absence_days,
  leave_days,
  fine_total
}
```

- [ ] **Step 5: Attach statistics to the attendance API response**

In `handleAdminAttendance`, after validating filters, call `attendanceEmployeeStats`. Preserve all current pending, approved, rejected, sorting, and pagination behavior. Extend the JSON response with:

```js
employee_stats: employeeStats,
summary: sumAttendanceEmployeeStats(employeeStats)
```

- [ ] **Step 6: Run checks and commit Task 4**

Run `npm run check && npm test`.

Expected: both commands exit 0.

Commit:

```bash
git add src/index.js test/admin-pagination-leave.test.js
git commit -m "feat: aggregate employee attendance statistics"
```

---

### Task 5: Render a beautiful multi-employee attendance summary

**Files:**
- Modify: `src/index.js` inside `adminHtml`, attendance I18N, styles, and `renderAttendance`
- Test: `test/admin-pagination-leave.test.js`

**Interfaces:**
- Consumes: Task 4 API `summary` and `employee_stats`; current filter state, table renderer, sort markers, and responsive styles.
- Produces: five aggregate cards, sortable employee summary table, and `data-attendance-detail` drill-down buttons.

- [ ] **Step 1: Write failing UI structure tests**

Add:

```js
test('attendance page renders five metrics and a multi-employee drill-down table', () => {
  for (const key of ['work_days', 'late_days', 'absence_days', 'leave_days', 'attendance_fine_total']) {
    assert.match(source, new RegExp(`${key}:`));
  }
  assert.match(source, /attendanceEmployeeSummaryTable/);
  assert.match(source, /data-attendance-detail/);
  assert.match(source, /data-status-tone/);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run `node --test test/admin-pagination-leave.test.js`.

Expected: FAIL because the new labels and summary-table renderer do not exist.

- [ ] **Step 3: Add restrained visual styles and translations**

Add all five metric labels, `view_details`, and `employee_attendance_summary` to the four existing language maps. Extend existing CSS rather than replacing it:

```css
.summary-grid.attendance-metrics { grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); }
.summary-card[data-status-tone="warning"] { border-color:rgba(255,180,80,.35); }
.summary-card[data-status-tone="danger"] { border-color:rgba(255,107,107,.35); }
.summary-card[data-status-tone="success"] { border-color:rgba(39,166,68,.30); }
.employee-name-cell { min-width:160px; font-weight:600; }
.metric-cell { text-align:right; font-variant-numeric:tabular-nums; }
```

Use only subtle border tones; do not add saturated card backgrounds or a new component library.

- [ ] **Step 4: Replace attendance approval-count cards with the five business metrics**

Change `attendanceSummaryPanel(data)` to use `data.summary`:

```js
function attendanceSummaryPanel(data) {
  const summary = data.summary || {};
  return '<div class="summary"><h2>' + L('summary') + '</h2>' +
    '<div class="summary-grid attendance-metrics">' + [
      { label:L('work_days'), value:String(summary.work_days || 0), tone:'success' },
      { label:L('late_days'), value:String(summary.late_days || 0), tone:'warning' },
      { label:L('absence_days'), value:String(summary.absence_days || 0), tone:'danger' },
      { label:L('leave_days'), value:String(summary.leave_days || 0), tone:'' },
      { label:L('attendance_fine_total'), value:formatAdminMoneyForUi(summary.fine_total || 0), tone:'warning' }
    ].map((item) => '<div class="summary-card" data-status-tone="' + esc(item.tone) + '">' +
      '<strong>' + esc(item.label) + '</strong><div class="summary-value">' + esc(item.value) + '</div></div>').join('') +
    '</div></div>';
}
```

- [ ] **Step 5: Render and sort one compact row per employee**

Implement `attendanceEmployeeSummaryTable(data)` using the existing table visual language. Columns are `store_id` only when multiple stores are selected, then `display_name`, `work_days`, `late_days`, `absence_days`, `leave_days`, `fine_total`, and `action`. The action value is:

```js
'<button class="secondary" data-attendance-detail="' + esc(row.telegram_id) + '">' +
  L('view_details') + '</button>'
```

Sort the complete `employee_stats` array in memory from `sorts.attendance.summary` before rendering. Numeric columns compare numerically; employee and store names use `localeCompare`. Continue using `tableHeader` so the active arrow matches other tables.

Insert the summary section between the five cards and current detail tables:

```js
attendanceSummaryPanel(data) +
sectionTitle('employee_attendance_summary') +
attendanceEmployeeSummaryTable(data) +
sectionTitle('pending_attendance')
```

- [ ] **Step 6: Bind drill-down without adding a new page**

After rendering, bind each `[data-attendance-detail]` button to:

```js
filters.employee = btn.dataset.attendanceDetail;
const employeeSelect = $('tab-attendance').querySelector('[data-filter-employee]');
if (employeeSelect) employeeSelect.value = filters.employee;
resetPages('attendance');
await renderAttendance();
```

Keep the filter's “all employees” option so one click on Search returns to the full list.

- [ ] **Step 7: Run checks and commit Task 5**

Run:

```bash
npm run check
npm test
```

Expected: both commands exit 0.

Commit:

```bash
git add src/index.js test/admin-pagination-leave.test.js
git commit -m "feat: show employee attendance summary table"
```

---

### Task 6: Verify migration, complete workflows, and visual integrity

**Files:**
- Modify only if verification exposes a defect: files already listed in Tasks 1-5

**Interfaces:**
- Consumes: all prior tasks.
- Produces: a locally verified implementation ready for a separate deploy request.

- [ ] **Step 1: Apply migrations to the local D1 database**

Run:

```bash
npx wrangler d1 migrations apply staffbot_v2 --local
```

Expected: migration `016_absence_fine_requests.sql` applies successfully, or Wrangler reports it was already applied.

- [ ] **Step 2: Verify the local D1 schema**

Run:

```bash
npx wrangler d1 execute staffbot_v2 --local --command "PRAGMA table_info(stores); PRAGMA table_info(absence_fine_requests);"
```

Expected: `stores` includes `absence_fine`, `absence_fine_enabled_at`, and `absence_last_checked_date`; `absence_fine_requests` includes `business_date`, both fine columns, status fields, and `income_record_id`.

- [ ] **Step 3: Run all static and automated verification**

Run:

```bash
npm run check
npm test
git diff --check
```

Expected: syntax check passes, every Node test passes, and `git diff --check` prints nothing.

- [ ] **Step 4: Run the Worker locally and smoke-test the shell**

Run:

```bash
npx wrangler dev --local
```

In a second terminal run:

```bash
curl -fsS http://127.0.0.1:8787/
curl -fsS http://127.0.0.1:8787/admin | rg "storeAbsenceFineEnabledInput|attendanceEmployeeSummaryTable|attendance-metrics"
```

Expected: `/` returns JSON with `"ok":true`; `/admin` contains all three new UI markers.

- [ ] **Step 5: Perform browser visual checks at desktop and mobile widths**

Open the local `/admin`, sign in with a local authorized admin, and verify:

1. At 1280 px width the five cards align cleanly, employee names remain readable, numeric cells align, and the summary table fits without unnecessary wrapping.
2. At 390 px width cards wrap into a readable grid and tables scroll horizontally without clipping buttons.
3. Selecting multiple stores shows the store column; selecting one store keeps the table compact.
4. “查看明细” selects exactly one employee and reloads the existing detail tables.
5. Returning to “全部员工” restores every active employee, including an employee with no attendance records.

Expected: no console errors, overlapping controls, unreadable contrast, or layout shifts.

- [ ] **Step 6: Review the final diff against scope**

Run:

```bash
git status --short
git diff --stat HEAD~5..HEAD
git diff HEAD~5..HEAD -- db/schema.sql db/migrations/016_absence_fine_requests.sql src/index.js wrangler.toml test/admin-pagination-leave.test.js test/money.test.js
```

Expected: only the planned migration, schema, Worker, Wrangler configuration, and two test files changed; no unrelated formatting or refactor is present.

- [ ] **Step 7: Commit verification-only corrections if needed**

If Step 1-6 required a correction, stage only the corrected planned files and run:

```bash
git commit -m "fix: complete absence fine verification"
```

If no correction was required, do not create an empty commit.

Deployment, remote D1 migration, production Cron activation, and live Telegram approval testing are intentionally excluded until the user explicitly requests deployment.
