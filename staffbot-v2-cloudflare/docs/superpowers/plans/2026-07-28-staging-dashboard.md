# Staging Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a read-only, multi-store, timezone-correct admin Dashboard in staging that compares gross sales, payroll ledger movements, and actual salary payments without changing production or any financial write path.

**Architecture:** Add one focused `src/dashboard.js` owner module for request validation, per-store local calendar ranges, fixed-count D1 aggregate queries, response folding, and paginated ledger detail. `src/admin-api.js` remains the authenticated route adapter, while `src/admin-page.js` renders the staging-only tab with existing controls, native SVG, accessible data tables, and no client-side financial aggregation.

**Tech Stack:** Cloudflare Workers, Cloudflare D1/SQLite, JavaScript ES modules, Node.js built-in test runner, `node:sqlite`, existing inline admin HTML/CSS/JavaScript, native SVG.

**Design spec:** `docs/superpowers/specs/2026-07-28-dashboard-design.md`

## Global Constraints

- Work only in the existing isolated worktree and branch: `.worktrees/staging-environment/staffbot-v2-cloudflare` on `codex/staging-environment`.
- Dashboard HTML and API are available only when `serviceEnvironment(env) === 'staging'`.
- Do not deploy, migrate, mutate, merge, or push production.
- Dashboard is read-only: no `INSERT`, `UPDATE`, `DELETE`, approval, reversal, salary-cycle, Telegram, email, R2, or payment-proof behavior.
- Payroll totals come only from signed `payroll_entries.amount_micros`.
- Gross sales come from approved legacy `income_records.type='income'`; they are a separate operating metric and never enter payroll totals.
- Actual payments come from `salary_records`; they do not reduce ledger totals.
- All API money values are JavaScript-safe integer micros. Convert legacy `REAL` rows with row-level `ROUND(value * 1000000)` before summing.
- Different currencies are never added together.
- Every selected store uses its own timezone to convert the same visible inclusive date range into `[start_iso, end_iso)`.
- The browser formats and visualizes API values but never recomputes business totals.
- Do not add a chart dependency, CDN resource, framework, database table, migration, precomputed aggregate, or scheduled task.
- Keep the existing four admin languages: Chinese, English, Vietnamese, and Russian.
- Keep existing tabs and their shared filter behavior unchanged; Dashboard uses its own date, employee, store, sort, and pagination state.
- D1 currently documents a maximum of 100 bound parameters and 100 KB SQL text per statement. Pass period collections as one JSON bind and read them through `json_each(?)`, rather than expanding one placeholder set per store-month.
- A store’s legacy gross-sales and salary-payment rows have no historical currency snapshot. Group those rows by the store’s current currency and make the staging currency-history preflight a release gate.

---

## File Map

| File | Responsibility |
| --- | --- |
| `src/dashboard.js` | Dashboard validation, local calendar periods, D1 aggregate queries, response folding, sorting, pagination, and staging availability policy |
| `src/admin-api.js` | Authenticated Dashboard route adapter and HTTP error mapping |
| `src/admin-page.js` | Staging-only tab, independent filters, metric cards, SVG, accessible tables, and ledger-detail interaction |
| `test/dashboard.test.js` | Unit, D1 integration, API, currency, timezone, boundary, pagination, and query-count coverage |
| `test/worker-routing.test.js` | Staging/production admin-document contract |
| `docs/ROADMAP.md` | Mark Dashboard staging proof only after remote acceptance succeeds |
| `docs/reports/2026-07-28-staging-dashboard-validation.md` | Exact staging evidence, limitations, Worker version, and production non-change proof |

---

### Task 1: Dashboard calendar ranges and request contract

**Files:**
- Create: `src/dashboard.js`
- Create: `test/dashboard.test.js`

**Interfaces:**
- Consumes: `dateRange()`, `localDate()`, and `addIsoDays()` from `src/dates.js`; `serviceEnvironment()` from `src/security.js`.
- Produces:
  - `class DashboardInputError extends Error`
  - `dashboardAvailable(env): boolean`
  - `dashboardSelection(dateFromRaw, dateToRaw, fallbackTimezone, now): { date_from, date_to }`
  - `dashboardPeriods(stores, selection): Array<{ store_id, store_currency, timezone, month_key, start_iso, end_iso }>`
  - `dashboardPeriodsJson(periods): string`

- [ ] **Step 1: Write failing tests for environment gating, default month, validation, and per-store ranges**

Create `test/dashboard.test.js` with these imports and assertions:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DashboardInputError,
  dashboardAvailable,
  dashboardPeriods,
  dashboardPeriodsJson,
  dashboardSelection
} from '../src/dashboard.js';

const stores = [
  {
    store_id: 'TOKYO',
    timezone: 'Asia/Tokyo',
    currency: '¥'
  },
  {
    store_id: 'NEW_YORK',
    timezone: 'America/New_York',
    currency: '$'
  }
];

test('enables Dashboard only in staging', () => {
  assert.equal(dashboardAvailable({ ENVIRONMENT: 'staging' }), true);
  assert.equal(dashboardAvailable({ ENVIRONMENT: 'production' }), false);
  assert.equal(dashboardAvailable({}), false);
});

test('defaults Dashboard to the fallback store local current month', () => {
  assert.deepEqual(
    dashboardSelection('', '', 'Asia/Tokyo', new Date('2026-07-31T16:00:00.000Z')),
    { date_from: '2026-08-01', date_to: '2026-08-31' }
  );
});

test('requires two valid ordered Dashboard dates', () => {
  for (const pair of [
    ['2026-07-01', ''],
    ['', '2026-07-31'],
    ['2026-07-32', '2026-08-01'],
    ['2026-08-01', '2026-07-31']
  ]) {
    assert.throws(
      () => dashboardSelection(pair[0], pair[1], 'Asia/Tokyo'),
      (error) => error instanceof DashboardInputError
        && error.code === 'invalid_date_range'
    );
  }
});

test('builds one UTC range per store local month', () => {
  const periods = dashboardPeriods(stores, {
    date_from: '2026-07-01',
    date_to: '2026-07-31'
  });

  assert.deepEqual(periods, [
    {
      store_id: 'TOKYO',
      store_currency: '¥',
      timezone: 'Asia/Tokyo',
      month_key: '2026-07',
      start_iso: '2026-06-30T15:00:00.000Z',
      end_iso: '2026-07-31T15:00:00.000Z'
    },
    {
      store_id: 'NEW_YORK',
      store_currency: '$',
      timezone: 'America/New_York',
      month_key: '2026-07',
      start_iso: '2026-07-01T04:00:00.000Z',
      end_iso: '2026-08-01T04:00:00.000Z'
    }
  ]);
  assert.deepEqual(JSON.parse(dashboardPeriodsJson(periods)), periods);
});
```

- [ ] **Step 2: Run the focused test and verify it fails because the owner module does not exist**

Run:

```bash
node --test test/dashboard.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/dashboard.js`.

- [ ] **Step 3: Implement the pure request and period helpers**

Create `src/dashboard.js` with this public shape and exact validation behavior:

```js
import { addIsoDays, dateRange, localDate } from './dates.js';
import { serviceEnvironment } from './security.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class DashboardInputError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'DashboardInputError';
    this.code = code;
    this.status = status;
  }
}

export function dashboardAvailable(env) {
  return serviceEnvironment(env) === 'staging';
}

function validIsoDate(value) {
  const text = String(value || '').trim();
  if (!ISO_DATE.test(text)) return '';
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text
    ? ''
    : text;
}

function lastDayOfMonth(isoDate) {
  const [year, month] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

export function dashboardSelection(
  dateFromRaw,
  dateToRaw,
  fallbackTimezone = 'UTC',
  now = new Date()
) {
  const rawFrom = String(dateFromRaw || '').trim();
  const rawTo = String(dateToRaw || '').trim();
  if (!rawFrom && !rawTo) {
    const currentLocalDate = localDate(now, fallbackTimezone || 'UTC');
    const dateFrom = `${currentLocalDate.slice(0, 7)}-01`;
    return {
      date_from: dateFrom,
      date_to: lastDayOfMonth(dateFrom)
    };
  }
  const dateFrom = validIsoDate(rawFrom);
  const dateTo = validIsoDate(rawTo);
  if (!dateFrom || !dateTo || dateFrom > dateTo) {
    throw new DashboardInputError('invalid_date_range');
  }
  return { date_from: dateFrom, date_to: dateTo };
}

function monthSegments(dateFrom, dateTo) {
  const segments = [];
  let cursor = dateFrom;
  while (cursor <= dateTo) {
    const segmentEnd = [lastDayOfMonth(cursor), dateTo].sort()[0];
    segments.push({
      month_key: cursor.slice(0, 7),
      date_from: cursor,
      date_to: segmentEnd
    });
    cursor = addIsoDays(segmentEnd, 1);
  }
  return segments;
}

export function dashboardPeriods(stores, selection) {
  return monthSegments(selection.date_from, selection.date_to).flatMap((segment) =>
    stores.map((store) => {
      const range = dateRange(
        segment.date_from,
        segment.date_to,
        store.timezone || 'UTC'
      );
      return {
        store_id: store.store_id,
        store_currency: store.currency,
        timezone: store.timezone || 'UTC',
        month_key: segment.month_key,
        start_iso: range.startIso,
        end_iso: range.endIso
      };
    })
  );
}

export function dashboardPeriodsJson(periods) {
  return JSON.stringify(periods);
}
```

Do not add database access in this task.

- [ ] **Step 4: Add a two-month clipping test**

Append a test proving `2026-07-15` through `2026-08-10` produces clipped July and August buckets for each store, with `month_key` values `2026-07` and `2026-08` and no overlapping UTC interval for the same store.

- [ ] **Step 5: Run the focused and full test suites**

Run:

```bash
node --test test/dashboard.test.js
npm run check
npm test
git diff --check
```

Expected: focused tests PASS and the existing 187 tests remain green.

- [ ] **Step 6: Commit the calendar contract**

```bash
git add src/dashboard.js test/dashboard.test.js
git commit -m "feat: add dashboard calendar ranges"
```

---

### Task 2: Fixed-count Dashboard aggregate queries

**Files:**
- Modify: `src/dashboard.js`
- Modify: `test/dashboard.test.js`

**Interfaces:**
- Consumes: Task 1 period helpers; `isStoreAdmin()` from `src/stores.js`.
- Produces:
  - `resolveDashboardFilters(env, url, fallbackStoreId, adminId, now): Promise<DashboardFilters>`
  - `loadDashboard(env, filters): Promise<{ ok, filters, groups }>`
  - `sortDashboardEmployees(rows, sortKey, sortDirection): Array`
- `DashboardFilters` exact fields:

```js
{
  storeIds: ['TOKYO'],
  stores: [{ store_id, timezone, currency }],
  employeeId: '',
  dateFrom: '2026-07-01',
  dateTo: '2026-07-31',
  periods: [{ store_id, store_currency, timezone, month_key, start_iso, end_iso }],
  employeeSort: 'net_payroll_micros',
  employeeDir: 'desc'
}
```

- [ ] **Step 1: Extend the D1 fixture with two stores, two currencies, two timezones, and exact financial rows**

In `test/dashboard.test.js`, import:

```js
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createD1 } from './helpers/d1.js';

import {
  loadDashboard,
  resolveDashboardFilters
} from '../src/dashboard.js';

const schema = readFileSync(
  new URL('../db/schema.sql', import.meta.url),
  'utf8'
);
```

Add `dashboardFixture()` that executes the canonical schema and inserts:

- `TOKYO`, `Asia/Tokyo`, `¥`; members `EMP-1` Alice and `ADMIN-1` Owner.
- `NEW_YORK`, `America/New_York`, `$`; members `EMP-2` Bob and `ADMIN-1` Owner.
- One Tokyo income record at `2026-06-30T15:00:00.000Z`: gross `1000`.
- One Tokyo income ledger entry: `600_000_000`.
- One Tokyo fine: `-50_000_000`.
- One Tokyo advance: `-100_000_000`.
- One Tokyo adjustment: `25_000_000`.
- One Tokyo reversal: `50_000_000` reversing the fine.
- One Tokyo salary record paid `400`.
- One New York income record at `2026-07-01T04:00:00.000Z`: gross `200`.
- One New York income ledger entry: `120_000_000`.
- One New York salary record paid `100`.
- Boundary rows one microsecond before each store-local July start; these must be excluded.

Use `createD1(database, hooks)` so the test can count `.all()` calls.

- [ ] **Step 2: Write the failing exact-aggregate test**

```js
test('aggregates gross sales, ledger types, payments, and currencies exactly', async () => {
  const { env } = dashboardFixture();
  const url = new URL(
    'https://staffbot.test/api/admin/stores/TOKYO/dashboard'
      + '?stores=TOKYO,NEW_YORK'
      + '&date_from=2026-07-01'
      + '&date_to=2026-07-31'
  );
  const filters = await resolveDashboardFilters(
    env,
    url,
    'TOKYO',
    'ADMIN-1'
  );
  const result = await loadDashboard(env, filters);

  assert.equal(result.ok, true);
  assert.equal(result.groups.length, 2);

  const yen = result.groups.find((group) => group.currency === '¥');
  assert.deepEqual(yen.summary, {
    gross_income_micros: 1_000_000_000,
    commission_micros: 600_000_000,
    fine_micros: -50_000_000,
    advance_micros: -100_000_000,
    bonus_micros: 0,
    adjustment_micros: 25_000_000,
    negative_carry_micros: 0,
    reversal_micros: 50_000_000,
    net_payroll_micros: 525_000_000,
    paid_salary_micros: 400_000_000,
    employee_count: 2
  });

  const dollars = result.groups.find((group) => group.currency === '$');
  assert.equal(dollars.summary.gross_income_micros, 200_000_000);
  assert.equal(dollars.summary.net_payroll_micros, 120_000_000);
  assert.equal(dollars.summary.paid_salary_micros, 100_000_000);
});
```

The Tokyo `employee_count` is `2` because it reflects current active members, including the owner; employee filtering must reduce this count to the matching active member. If the product later wants only `role='employee'`, that is a separate metric change and must not be guessed during implementation.

- [ ] **Step 3: Run the focused test and verify the missing exports fail**

Run:

```bash
node --test test/dashboard.test.js
```

Expected: FAIL because `resolveDashboardFilters` and `loadDashboard` are not exported.

- [ ] **Step 4: Implement request resolution with explicit store and employee authorization**

Add imports:

```js
import { adminPage } from './admin-query.js';
import { isStoreAdmin } from './stores.js';
```

Add the exact sort whitelist:

```js
const EMPLOYEE_SORTS = new Set([
  'display_name',
  'gross_income_micros',
  'commission_micros',
  'fine_micros',
  'advance_micros',
  'net_payroll_micros',
  'paid_salary_micros'
]);
```

`resolveDashboardFilters()` must:

1. Parse and deduplicate `stores`, defaulting to `fallbackStoreId`.
2. Call `isStoreAdmin(env, adminId, id)` for every requested store and throw `new DashboardInputError('forbidden_store', 403)` when any fail.
3. Load all requested active stores in one parameterized query using:

```sql
SELECT store_id, timezone, currency
FROM stores
WHERE status = 'active'
  AND store_id IN (SELECT value FROM json_each(?))
ORDER BY store_id
```

Bind `JSON.stringify(storeIds)`. Reject missing or disabled IDs with `unknown_store`.
4. Resolve the visible dates using the fallback store timezone, then build per-store month periods.
5. Parse `employee`; when non-empty and not `all`, verify at least one membership of any status within the selected store IDs using `json_each(?)`, otherwise throw `unknown_employee`. Historical rows for a disabled former employee remain queryable, while `employee_count` still counts only current active members.
6. Accept only the exact employee sort keys above and directions `asc|desc`; invalid explicit values throw `invalid_sort`.
7. Default sorting to `net_payroll_micros desc`.

- [ ] **Step 5: Implement four fixed aggregate queries using one JSON period bind**

Use this shared CTE prefix in each aggregate statement:

```sql
WITH periods AS (
  SELECT
    CAST(json_extract(value, '$.store_id') AS TEXT) AS store_id,
    CAST(json_extract(value, '$.store_currency') AS TEXT) AS store_currency,
    CAST(json_extract(value, '$.month_key') AS TEXT) AS month_key,
    CAST(json_extract(value, '$.start_iso') AS TEXT) AS start_iso,
    CAST(json_extract(value, '$.end_iso') AS TEXT) AS end_iso
  FROM json_each(?)
)
```

Run exactly four `.all()` reads with `Promise.all()`:

1. Active members grouped by current store currency and Telegram ID.
2. Gross sales grouped by `periods.store_currency`, month, and employee:

```sql
SUM(ROUND(r.income * 1000000)) AS gross_income_micros
```

with `r.type='income'`, `r.approved_at >= p.start_iso`, and `r.approved_at < p.end_iso`.
3. Ledger amounts grouped by `e.currency`, month, employee, and `e.type`:

```sql
SUM(e.amount_micros) AS amount_micros
```

with `e.effective_at >= p.start_iso` and `< p.end_iso`.
4. Actual salary payments grouped by `periods.store_currency`, month, and employee:

```sql
SUM(ROUND(s.amount * 1000000)) AS paid_salary_micros
```

with `s.approved_at >= p.start_iso` and `< p.end_iso`.

Every query must include this employee predicate and bind the employee twice after the period JSON:

```sql
AND (? = '' OR source_alias.telegram_id = ?)
```

Do not query once per employee or once per month.

The active-member query must join `stores` and group by
`s.currency, m.telegram_id`; `employee_count` counts each Telegram ID once
per currency even when the same person belongs to two selected stores with
that currency. Financial aggregate queries must still use left joins to
`store_members` and `users` so historical rows for a disabled former member
retain a display name and remain visible.

- [ ] **Step 6: Fold database aggregates into the exact response**

Use these employee money fields initialized to zero:

```js
const MONEY_FIELDS = [
  'gross_income_micros',
  'commission_micros',
  'fine_micros',
  'advance_micros',
  'bonus_micros',
  'adjustment_micros',
  'negative_carry_micros',
  'reversal_micros',
  'net_payroll_micros',
  'paid_salary_micros'
];

const TYPE_FIELD = {
  income: 'commission_micros',
  fine: 'fine_micros',
  advance: 'advance_micros',
  bonus: 'bonus_micros',
  adjustment: 'adjustment_micros',
  negative_carry: 'negative_carry_micros',
  reversal: 'reversal_micros'
};
```

Fold rows by `currency`, then `month_key`, then `telegram_id`. Sum only integer micros received from D1. Derive `net_payroll_micros` by adding all ledger type rows on the server. Add:

```js
composition: [
  { type: 'income', amount_micros: 0 },
  { type: 'fine', amount_micros: 0 },
  { type: 'advance', amount_micros: 0 },
  { type: 'bonus', amount_micros: 0 },
  { type: 'adjustment', amount_micros: 0 },
  { type: 'negative_carry', amount_micros: 0 },
  { type: 'reversal', amount_micros: 0 }
]
```

to each currency group so the browser never derives the composition totals from employee rows.

Sort employees with `telegram_id` as the stable final tie-breaker after the
selected metric and direction.

Return filter metadata with this exact public shape:

```js
filters: {
  store_ids: filters.storeIds,
  date_from: filters.dateFrom,
  date_to: filters.dateTo,
  employee: filters.employeeId || null
}
```

Before returning, validate every returned micros value with `Number.isSafeInteger`; throw a `RangeError` if D1 returns an unsafe total.

- [ ] **Step 7: Add sorting, currency, employee-filter, boundary, and fixed-query-count tests**

Add tests proving:

- `employees_sort=gross_income_micros&employees_dir=asc` changes both employee rows and the later chart order.
- Invalid sort input raises `invalid_sort`.
- `employee=EMP-1` removes Bob and changes employee count.
- Tokyo and New York boundary rows before local midnight are excluded.
- Adding 100 extra active members does not change the four aggregate `.all()` calls.
- A same-currency third store merges into the same currency group.
- Empty data returns `groups` with current active-member currency groups and zero summaries, not an error.

- [ ] **Step 8: Run and commit the aggregate slice**

```bash
node --test test/dashboard.test.js
npm run check
npm test
git diff --check
git add src/dashboard.js test/dashboard.test.js
git commit -m "feat: aggregate dashboard financial metrics"
```

Expected: all tests pass and no schema or dependency file changes.

---

### Task 3: Paginated immutable ledger drill-down

**Files:**
- Modify: `src/dashboard.js`
- Modify: `test/dashboard.test.js`

**Interfaces:**
- Consumes: `DashboardFilters` from Task 2 and `adminPage()` from `src/admin-query.js`.
- Produces:
  - `loadDashboardEntries(env, url, filters): Promise<{ ok, entries, pagination: { entries } }>`
- The entry result intentionally excludes `metadata_json`.

- [ ] **Step 1: Write failing tests for reversal visibility, metadata exclusion, boundaries, and pagination**

Seed 101 ledger entries inside the selected local range plus one entry immediately before the range. Add one reversal with `reverses_entry_id='PAY-FINE-1'`.

```js
test('returns immutable ledger detail with reversal and stable pagination', async () => {
  const { env } = dashboardFixtureWithManyEntries();
  const url = new URL(
    'https://staffbot.test/api/admin/stores/TOKYO/dashboard/entries'
      + '?stores=TOKYO'
      + '&date_from=2026-07-01'
      + '&date_to=2026-07-31'
      + '&employee=EMP-1'
      + '&entries_page=1'
  );
  const filters = await resolveDashboardFilters(
    env,
    url,
    'TOKYO',
    'ADMIN-1'
  );
  const result = await loadDashboardEntries(env, url, filters);

  assert.equal(result.entries.length, 100);
  assert.equal(result.pagination.entries.total, 101);
  assert.equal(result.pagination.entries.total_pages, 2);
  assert.ok(result.entries.some((entry) =>
    entry.type === 'reversal'
      && entry.reverses_entry_id === 'PAY-FINE-1'
  ));
  assert.equal(
    Object.prototype.hasOwnProperty.call(result.entries[0], 'metadata_json'),
    false
  );
});
```

- [ ] **Step 2: Run the focused test and verify the missing function fails**

```bash
node --test test/dashboard.test.js
```

Expected: FAIL because `loadDashboardEntries` is not exported.

- [ ] **Step 3: Implement count and page queries with the same period JSON**

Use the period CTE and these predicates:

```sql
JOIN periods p
  ON p.store_id = e.store_id
 AND e.effective_at >= p.start_iso
 AND e.effective_at < p.end_iso
WHERE (? = '' OR e.telegram_id = ?)
```

The count query returns `COUNT(*) AS total`. The row query returns only:

```sql
e.entry_id,
e.store_id,
e.telegram_id,
COALESCE(
  NULLIF(m.display_name, ''),
  NULLIF(u.name, ''),
  NULLIF(u.username, ''),
  e.telegram_id
) AS display_name,
e.type,
e.amount_micros,
e.currency,
e.effective_at,
e.source,
e.source_id,
e.created_at,
e.reverses_entry_id
```

Join `store_members m` on both store and employee, join `users u` on employee, order by `e.effective_at DESC, e.entry_id DESC`, and bind `LIMIT`/`OFFSET` from `adminPage(url.searchParams.get('entries_page'), total)`.

- [ ] **Step 4: Add page-two, no-data, and employee-isolation tests**

Verify page two contains one row, an unknown employee was already rejected by filter resolution, and `employee=EMP-1` never returns `EMP-2`.

- [ ] **Step 5: Run and commit the drill-down slice**

```bash
node --test test/dashboard.test.js
npm run check
npm test
git diff --check
git add src/dashboard.js test/dashboard.test.js
git commit -m "feat: add dashboard ledger drilldown"
```

---

### Task 4: Authenticated staging-only Dashboard API

**Files:**
- Modify: `src/admin-api.js:1-150`
- Modify: `src/admin-api.js` near the existing admin handlers
- Modify: `test/dashboard.test.js`

**Interfaces:**
- Consumes:
  - `dashboardAvailable`
  - `DashboardInputError`
  - `resolveDashboardFilters`
  - `loadDashboard`
  - `loadDashboardEntries`
- Produces:
  - `GET /api/admin/stores/:storeId/dashboard`
  - `GET /api/admin/stores/:storeId/dashboard/entries`

- [ ] **Step 1: Write failing route tests**

Use a real `admin_sessions` row and Worker request headers:

```js
const authenticatedHeaders = {
  cookie: 'staffbot_admin_session=dashboard-session'
};
```

Add tests proving:

- staging authenticated request returns `200` and both currency groups;
- production authenticated request returns `404 not_found`;
- no session returns `401 unauthorized`;
- adding an unauthorized store to `stores=` returns `403 forbidden`;
- invalid dates return `400 invalid_date_range`;
- invalid employee sort returns `400 invalid_sort`;
- `/entries` returns pagination under `pagination.entries`;
- POST to either Dashboard route returns `404`.

- [ ] **Step 2: Run tests and verify routes return 404**

```bash
node --test test/dashboard.test.js
```

Expected: FAIL because the current dispatcher has no `dashboard` branch.

- [ ] **Step 3: Add the imports and route branch**

At the top of `src/admin-api.js`:

```js
import {
  DashboardInputError,
  dashboardAvailable,
  loadDashboard,
  loadDashboardEntries,
  resolveDashboardFilters
} from './dashboard.js';
```

In `handleAdminApi()`, after the current `storeId` permission check and before the export branch:

```js
if (parts[4] === 'dashboard') {
  return handleAdminDashboard(
    request,
    env,
    url,
    storeId,
    parts,
    session.telegram_id
  );
}
```

- [ ] **Step 4: Implement exact HTTP mapping**

```js
async function handleAdminDashboard(
  request,
  env,
  url,
  storeId,
  parts,
  adminId
) {
  if (!dashboardAvailable(env) || request.method !== 'GET') {
    return json({ ok: false, error: 'not_found' }, 404);
  }
  try {
    const filters = await resolveDashboardFilters(
      env,
      url,
      storeId,
      adminId
    );
    if (parts.length === 5) {
      return json(await loadDashboard(env, filters));
    }
    if (parts.length === 6 && parts[5] === 'entries') {
      return json(await loadDashboardEntries(env, url, filters));
    }
    return json({ ok: false, error: 'not_found' }, 404);
  } catch (error) {
    if (error instanceof DashboardInputError) {
      return json(
        { ok: false, error: error.code },
        error.status || 400
      );
    }
    throw error;
  }
}
```

Do not modify the global API error body, login flow, or existing store handlers.

- [ ] **Step 5: Run all API and regression tests**

```bash
node --test test/dashboard.test.js
node --test test/worker-routing.test.js
npm run check
npm test
git diff --check
```

- [ ] **Step 6: Commit the API slice**

```bash
git add src/admin-api.js test/dashboard.test.js
git commit -m "feat: expose staging dashboard API"
```

---

### Task 5: Staging-only Dashboard tab, filters, cards, and comparison table

**Files:**
- Modify: `src/admin-page.js:12-310`
- Modify: `src/admin-page.js:325-435`
- Modify: `src/admin-page.js` near existing render and table helpers
- Modify: `test/worker-routing.test.js`

**Interfaces:**
- Consumes: Task 4 JSON response.
- Produces:
  - staging-only `data-tab="dashboard"` and `id="tab-dashboard"`;
  - independent `dashboardFilters`, employee sorting, and page state;
  - `renderDashboard()`, `dashboardFilterPanel()`, `dashboardSummaryCards()`, and `dashboardEmployeeTable()`.

- [ ] **Step 1: Write the admin-document contract tests**

Extend `test/worker-routing.test.js`:

```js
test('shows Dashboard only in staging and keeps production admin unchanged', async () => {
  const staging = await worker.fetch(
    new Request('https://staffbot.test/admin'),
    { ENVIRONMENT: 'staging' },
    context()
  );
  const production = await worker.fetch(
    new Request('https://staffbot.test/admin'),
    { ENVIRONMENT: 'production' },
    context()
  );
  const stagingDocument = normalizedHtml(await staging.text());
  const productionDocument = normalizedHtml(await production.text());

  assert.match(stagingDocument, /data-tab="dashboard"/);
  assert.match(stagingDocument, /id="tab-dashboard"/);
  assert.match(stagingDocument, /data-dashboard-filter/);
  assert.match(stagingDocument, /data-dashboard-employee/);
  assert.doesNotMatch(productionDocument, /data-tab="dashboard"/);
  assert.doesNotMatch(productionDocument, /id="tab-dashboard"/);
});
```

Update the existing complete-admin-contract tab list so Dashboard is asserted separately for staging rather than added to the production-neutral shared loop.

- [ ] **Step 2: Run the document test and verify it fails**

```bash
node --test test/worker-routing.test.js
```

Expected: FAIL because the staging HTML has no Dashboard tab.

- [ ] **Step 3: Add server-side staging markup and default tab**

At the start of `adminHtml(env)`:

```js
const dashboardEnabled = serviceEnvironment(env) === 'staging';
const dashboardNav = dashboardEnabled
  ? '<button data-tab="dashboard" class="active" data-i18n="dashboard">数据看板</button>'
  : '';
const dashboardPanel = dashboardEnabled
  ? '<section id="tab-dashboard" class="panel"></section>'
  : '';
const defaultTab = dashboardEnabled ? 'dashboard' : 'stores';
```

Insert `dashboardNav` before the store tab, remove the store tab’s unconditional `active` class, add it only when Dashboard is disabled, and insert `dashboardPanel` before `tab-stores`.

Inside the generated script:

```js
let currentTab = ${JSON.stringify(defaultTab)};
const dashboardFilters = {
  dateFrom: '',
  dateTo: '',
  employee: 'all',
  stores: [],
  employeeSort: 'net_payroll_micros',
  employeeDir: 'desc',
  selectedEmployee: '',
  entriesPage: 1
};
```

Do not assign default Dashboard dates into the existing shared `filters`; old tabs must retain their current unfiltered first load.

- [ ] **Step 4: Add exact four-language labels**

Add these keys to every language object:

| Key | Chinese | English | Vietnamese | Russian |
| --- | --- | --- | --- | --- |
| `dashboard` | 数据看板 | Dashboard | Bảng dữ liệu | Панель данных |
| `business_overview` | 经营概况 | Business overview | Tổng quan kinh doanh | Обзор бизнеса |
| `payroll_overview` | 工资概况 | Payroll overview | Tổng quan lương | Обзор зарплаты |
| `gross_income_micros` | 原始营业额 | Gross sales | Doanh thu gốc | Валовая выручка |
| `commission_micros` | 员工提成 | Employee commission | Hoa hồng nhân viên | Комиссия сотрудников |
| `employee_count` | 员工人数 | Employees | Số nhân viên | Сотрудники |
| `net_payroll_micros` | 账本净额 | Ledger net | Số ròng sổ lương | Чистая сумма книги |
| `fine_micros` | 罚款扣减 | Fine deductions | Khấu trừ phạt | Удержания штрафов |
| `advance_micros` | 预支扣减 | Advance deductions | Khấu trừ ứng lương | Удержания авансов |
| `paid_salary_micros` | 实际已付款 | Actually paid | Đã thanh toán | Фактически выплачено |
| `monthly_trend` | 月度趋势 | Monthly trend | Xu hướng theo tháng | Помесячная динамика |
| `payroll_composition` | 工资构成 | Payroll composition | Cơ cấu lương | Состав зарплаты |
| `employee_comparison` | 员工对比 | Employee comparison | So sánh nhân viên | Сравнение сотрудников |
| `view_ledger` | 查看流水 | View ledger | Xem sổ cái | Открыть книгу |
| `ledger_entries` | 账本流水 | Ledger entries | Bút toán sổ lương | Записи книги |
| `reversal` | 冲正 | Reversal | Đảo bút toán | Сторно |
| `dashboard_no_data` | 该筛选范围没有数据 | No data in this range | Không có dữ liệu trong phạm vi này | Нет данных за выбранный период |

- [ ] **Step 5: Add Dashboard query and render state without SVG**

Implement:

```js
function dashboardQuery({
  includeEntries = false,
  detailEmployeeId = ''
} = {}) {
  const params = new URLSearchParams();
  const selectedStores = dashboardFilters.stores.length
    ? dashboardFilters.stores
    : [storeId()];
  params.set('stores', selectedStores.join(','));
  if (dashboardFilters.dateFrom) {
    params.set('date_from', dashboardFilters.dateFrom);
  }
  if (dashboardFilters.dateTo) {
    params.set('date_to', dashboardFilters.dateTo);
  }
  const employeeId = detailEmployeeId
    || (dashboardFilters.employee !== 'all'
      ? dashboardFilters.employee
      : '');
  if (employeeId) {
    params.set('employee', employeeId);
  }
  params.set('employees_sort', dashboardFilters.employeeSort);
  params.set('employees_dir', dashboardFilters.employeeDir);
  if (includeEntries) {
    params.set('entries_page', String(dashboardFilters.entriesPage));
  }
  return params.toString();
}
```

`renderDashboard()` must:

1. Request `/api/admin/stores/${storeId()}/dashboard?${dashboardQuery()}`.
2. Copy `data.filters.date_from` and `date_to` into `dashboardFilters` after the first default-month response.
3. Render a Dashboard-specific filter panel from `stores` and a unique employee list folded from `groups[].employees`.
4. Render one currency section per `groups[]`.
5. Render the confirmed operating cards, payroll cards, monthly numeric table, composition numeric table, and employee comparison table.
6. Divide micros by `1_000_000` only inside `formatDashboardMicros(currency, micros)`.
7. Keep fines and advances negative.
8. Attach `data-dashboard-employee` to “View ledger” buttons.

Add `if (currentTab === 'dashboard') return renderDashboard();` before the store branch in `loadTab()`.

- [ ] **Step 6: Add independent filter and employee-sort bindings**

Dashboard store chips, date inputs, employee selector, and search button update only `dashboardFilters`. Employee table headers set `employeeSort` and toggle `employeeDir`, reset `entriesPage=1`, then call `renderDashboard()`.

Do not call existing `syncFilterInputs()` or mutate shared `filters` for Dashboard.

- [ ] **Step 7: Run UI and full regressions**

```bash
node --test test/worker-routing.test.js
node --test test/dashboard.test.js
npm run check
npm test
git diff --check
```

- [ ] **Step 8: Commit the accessible numeric Dashboard**

```bash
git add src/admin-page.js test/worker-routing.test.js
git commit -m "feat: add staging dashboard overview"
```

At this save point the Dashboard is useful without charts: all confirmed numbers, filters, sorting, currencies, and data tables work.

---

### Task 6: Native SVG charts and ledger-detail interaction

**Files:**
- Modify: `src/admin-page.js`
- Modify: `test/worker-routing.test.js`

**Interfaces:**
- Consumes: Task 5 currency groups and Task 4 `/entries` endpoint.
- Produces:
  - `dashboardLineChart(group)`
  - `dashboardCompositionChart(group)`
  - `dashboardEmployeeChart(group)`
  - `renderDashboardEntries(employeeId)`
  - responsive, labelled SVG plus matching data tables.

- [ ] **Step 1: Write failing static contract tests**

Add assertions that staging HTML contains:

```js
for (const marker of [
  'data-dashboard-chart="monthly"',
  'data-dashboard-chart="composition"',
  'data-dashboard-chart="employees"',
  'role="img"',
  'data-dashboard-table',
  'data-dashboard-entries',
  'data-dashboard-entry-page'
]) {
  assert.match(stagingDocument, new RegExp(marker));
}
assert.doesNotMatch(stagingDocument, /<script[^>]+src=/);
assert.doesNotMatch(stagingDocument, /<link[^>]+cdn/i);
```

- [ ] **Step 2: Run the document test and verify missing chart markers fail**

```bash
node --test test/worker-routing.test.js
```

- [ ] **Step 3: Implement SVG helpers that only scale already-aggregated values**

Use a fixed `viewBox`, escape every label, include `<title>`, and preserve the matching table from Task 5. The chart helpers may calculate visual coordinates and extrema, but must not calculate financial totals.

Required visual behavior:

- Monthly chart: one series each for gross sales, commission, and net payroll.
- Composition chart: seven labelled bars from `group.composition`; negative amounts extend below the zero line.
- Employee chart: use the server-sorted `group.employees` and selected sort metric; show at most the first 20 bars while the complete table remains visible.
- Empty arrays return `<p class="muted">${L('dashboard_no_data')}</p>` instead of an all-zero graph.
- SVG contains `role="img"`, a localized `<title>`, currency, and numeric labels.

Add responsive CSS:

```css
.dashboard-currency-group { display:grid; gap:14px; margin-bottom:20px; }
.dashboard-chart-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); gap:14px; }
.dashboard-chart { overflow:auto; border:1px solid var(--line); border-radius:12px; padding:12px; background:var(--panel-2); }
.dashboard-chart svg { display:block; width:100%; min-width:560px; height:auto; }
.dashboard-negative { color:var(--bad); }
@media (max-width:720px) {
  .dashboard-chart-grid { grid-template-columns:1fr; }
}
```

- [ ] **Step 4: Implement ledger drill-down**

When `[data-dashboard-employee]` is clicked:

1. Set `dashboardFilters.selectedEmployee`.
2. Leave the main `dashboardFilters.employee` unchanged.
3. Reset `entriesPage=1`.
4. Request `/dashboard/entries?${dashboardQuery({ includeEntries: true, detailEmployeeId: employeeId })}`.
5. Render the exact fields from the spec; never render `metadata_json`.
6. Add a visible localized “reversal” badge for `type='reversal'`.
7. Keep `amount_micros` signed and format with the row currency.
8. Bind previous/next controls through `data-dashboard-entry-page`.

Use the Task 5 query-builder signature so opening a detail does not silently replace the main comparison filter:

```js
function dashboardQuery({ includeEntries = false, detailEmployeeId = '' } = {})
```

and the employee parameter must prefer `detailEmployeeId`, then the main Dashboard employee filter.

- [ ] **Step 5: Add source assertions for signed values and safe fields**

Assert the page source:

- divides `amount_micros` only in `formatDashboardMicros`;
- never references `metadata_json` inside Dashboard rendering;
- contains the reversal badge path;
- uses `data-dashboard-entry-page` for detail pagination;
- retains the complete employee data table beside the 20-bar visual limit.

- [ ] **Step 6: Run the complete local gate**

```bash
node --test test/worker-routing.test.js
node --test test/dashboard.test.js
npm run check
npm test
git diff --check
```

Expected: all existing and new tests pass; `package.json` remains unchanged.

- [ ] **Step 7: Commit charts and detail**

```bash
git add src/admin-page.js test/worker-routing.test.js
git commit -m "feat: visualize dashboard payroll data"
```

---

### Task 7: Staging validation, production non-change proof, and documentation

**Files:**
- Create: `docs/reports/2026-07-28-staging-dashboard-validation.md`
- Modify: `docs/ROADMAP.md`

**Interfaces:**
- Consumes: completed Tasks 1–6, staging Worker/D1, existing `docs/STAGING_RUNBOOK.md`.
- Produces: reproducible staging evidence and a roadmap state change from Dashboard “not started” to “staging verified”.

- [ ] **Step 1: Run the complete local release gate**

```bash
npm run check
npm test
npm run test:staging
git diff --check
git status --short
```

Expected: all tests pass and the worktree contains no uncommitted implementation changes.

- [ ] **Step 2: Confirm Cloudflare identity and staging-only configuration**

```bash
npx wrangler whoami
npx wrangler d1 migrations list DB --env staging --remote
npx wrangler secret list --env staging
```

Verify secret names only; never print values. Confirm `wrangler.toml` still has:

```toml
[env.staging.vars]
ENVIRONMENT = "staging"
PAYROLL_LEDGER_READ_MODE = "ledger"
PAYROLL_LEDGER_WRITE_MODE = "dual"
SCHEDULED_TASKS_ENABLED = "false"

[env.staging.triggers]
crons = []
```

- [ ] **Step 3: Audit the legacy currency limitation before accepting totals**

Run this read-only query against staging:

```bash
npx wrangler d1 execute DB --env staging --remote --command "
SELECT
  store_id,
  action,
  created_at,
  json_extract(details_json, '$.currency') AS recorded_currency
FROM admin_audit_logs
WHERE action IN ('create_store', 'update_store')
  AND json_extract(details_json, '$.currency') IS NOT NULL
ORDER BY store_id, created_at;
"
```

Compare the recorded sequence with current `stores.currency`.

- If each store has one observed currency, continue and record that evidence.
- If one store has multiple historical currencies, stop staging acceptance and report that legacy gross-sales and salary-payment currency attribution is historically ambiguous. Do not add a migration or rewrite history inside this Dashboard phase.

- [ ] **Step 4: Deploy only staging**

```bash
npx wrangler deploy --env staging
```

Record the returned staging Worker version ID. Never run a deploy command without `--env staging`.

- [ ] **Step 5: Run health and page smoke checks**

```bash
curl -fsS https://staffbot-v2-staging.staffbot-v2.workers.dev/
curl -fsS https://staffbot-v2-staging.staffbot-v2.workers.dev/admin
curl -fsS https://staffbot-v2.staffbot-v2.workers.dev/
```

Expected:

- staging `/` reports `"environment":"staging"`;
- staging `/admin` contains `STAGING 测试环境` and `data-tab="dashboard"`;
- production `/` remains healthy;
- no production deployment or migration occurs.

- [ ] **Step 6: Perform authenticated staging acceptance**

In the staging admin UI:

1. Verify Dashboard is the default tab.
2. Select one store and one month; compare gross sales with a read-only `income_records` micros query.
3. Compare net payroll and type breakdown with `SUM(amount_micros)` and grouped `payroll_entries.type`.
4. Compare actual payment with row-rounded `salary_records.amount`.
5. Select two stores with different timezones and verify local-month boundaries.
6. Select two currencies and verify separate currency sections.
7. Select an employee with fine, advance, reversal, and payment history; verify cards, charts, table, and ledger detail.
8. Verify an empty range renders the localized no-data state.
9. Verify detail pagination and reversal badge.
10. Attempt a hand-edited unauthorized store ID and confirm `403`.
11. Authenticate against production admin and confirm no Dashboard tab is present.

- [ ] **Step 7: Write the validation report and update the roadmap**

Create `docs/reports/2026-07-28-staging-dashboard-validation.md` containing:

- commit SHA and staging Worker version ID;
- local test counts;
- selected store IDs in redacted form when necessary;
- exact date ranges and currencies tested;
- SQL/API reconciliation totals;
- timezone boundary cases;
- permission result;
- currency-history preflight outcome;
- production health and absence-of-Dashboard proof;
- known limitation that legacy gross/payment currency uses current store currency;
- explicit statement that no production migration or deploy occurred.

Update `docs/ROADMAP.md` Phase 9 from `⬜` to `🧪` only after every required staging check passes. Do not mark production rollout complete.

- [ ] **Step 8: Verify and commit the evidence**

```bash
rg -n "Dashboard|production|currency|timezone|Worker version" \
  docs/reports/2026-07-28-staging-dashboard-validation.md \
  docs/ROADMAP.md
npm run check
npm test
git diff --check
git add docs/reports/2026-07-28-staging-dashboard-validation.md docs/ROADMAP.md
git commit -m "docs: record staging dashboard proof"
```

---

## Final Acceptance Checklist

- [ ] Dashboard is visible and default only in staging.
- [ ] Production HTML and API do not expose Dashboard.
- [ ] Gross sales use approved `income_records.type='income'`.
- [ ] Payroll metrics use signed `payroll_entries.amount_micros` only.
- [ ] Actual payments use row-rounded `salary_records.amount` and do not change ledger totals.
- [ ] Multi-store dates use each store timezone.
- [ ] Currency groups never merge different currencies.
- [ ] Main data load uses a fixed number of aggregate queries, not one query per employee or month.
- [ ] D1 period collections use one bound JSON parameter with `json_each(?)`.
- [ ] Dashboard returns only safe integer micros.
- [ ] Ledger detail excludes `metadata_json` and preserves reversal rows.
- [ ] Native SVG has accessible titles, labels, and equivalent tables.
- [ ] Existing tabs, filters, exports, Telegram, Cron, salary cycles, and financial writes remain unchanged.
- [ ] Full local tests and staging acceptance pass.
- [ ] Staging evidence is committed.
- [ ] No production deploy, migration, flag change, merge, push, or PR occurred without separate approval.

## D1 Documentation References

- D1 limits: `https://developers.cloudflare.com/d1/platform/limits/`
- D1 prepared statements: `https://developers.cloudflare.com/d1/worker-api/prepared-statements/`
- D1 JSON query pattern: `https://developers.cloudflare.com/d1/sql-api/query-json/`
