# Admin Absence Approvals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated admin navigation page for querying, approving, rejecting, and auditing daily absence approvals already stored in D1.

**Architecture:** Expose `absence_fine_requests` through a store-authorized admin API with separate pending/history pagination and full-range summary queries. Reuse the existing Telegram approval functions with store scoping and configurable rejection reasons, then add one localized admin tab using existing filters, cards, tables, actions, and pagination.

**Tech Stack:** Cloudflare Workers, D1/SQLite, vanilla JavaScript admin UI, Node.js built-in test runner.

## Global Constraints

- Use a standalone “缺勤审批” navigation page, not the existing attendance page.
- Approvals use the current suggested fine; editing remains in the existing income/fine records page.
- Web rejection reason is required and cannot be blank.
- Telegram and web must share the same approval/rejection business logic.
- Only the first concurrent decision may succeed; no duplicate fine may be created.
- Actual approved totals read current `income_records.fine` and group incompatible currencies.
- Reuse existing styling, filters, tables, pagination, permissions, and four admin languages.
- Add no database migration, dependency, Cron change, batch approval, or unrelated refactor.

---

### Task 1: Add store-scoped absence approval API and query results

**Files:**
- Modify: `staffbot-v2-cloudflare/src/index.js`
- Test: `staffbot-v2-cloudflare/test/admin-pagination-leave.test.js`

**Interfaces:**
- Extends: `approveAbsenceFineRequest(env, requestId, adminId, expectedStoreId = '')`.
- Extends: `rejectAbsenceFineRequest(env, requestId, adminId, reason = 'Rejected by admin', expectedStoreId = '')`.
- Produces: `GET /api/admin/stores/:storeId/absence`.
- Produces: `POST /api/admin/stores/:storeId/absence/:requestId/approve`.
- Produces: `POST /api/admin/stores/:storeId/absence/:requestId/reject`.

- [ ] **Step 1: Write failing action tests**

Add tests proving:

```js
const approved = await approveAbsenceFineRequest(env, 'ABS-1', 'ADMIN1', 'STORE1');
assert.equal(approved.ok, true);
assert.equal(database.prepare(
  `SELECT COUNT(*) AS total FROM income_records WHERE source = 'attendance_absence'`
).get().total, 1);

const wrongStore = await approveAbsenceFineRequest(env, 'ABS-2', 'ADMIN1', 'STORE2');
assert.equal(wrongStore.ok, false);

const rejected = await rejectAbsenceFineRequest(
  env, 'ABS-3', 'ADMIN1', 'Employee had approved exception', 'STORE1'
);
assert.equal(rejected.ok, true);
assert.equal(database.prepare(
  `SELECT reject_reason FROM absence_fine_requests WHERE request_id = 'ABS-3'`
).get().reject_reason, 'Employee had approved exception');
```

Add API routing assertions for 400 blank rejection reason, 404 request/store mismatch, and 409 already-decided or concurrently-decided request.

- [ ] **Step 2: Run the action tests and verify failure**

Run:

```bash
node --test --test-name-pattern="store-scoped absence|admin absence action|requires absence rejection reason" test/admin-pagination-leave.test.js
```

Expected: FAIL because the store-scoped parameters and admin routes do not exist.

- [ ] **Step 3: Make existing decision functions store-aware**

Keep Telegram call sites unchanged through default parameters. Restrict the initial pending lookup and the conditional INSERT/UPDATE statements when `expectedStoreId` is present. Trim the web rejection reason before passing it to the core function.

The core functions must continue using conditional `status = 'pending'` writes and return `ok: false` when another actor wins.

- [ ] **Step 4: Add failing GET query tests**

Create a SQLite fixture with:

- pending, approved, rejected, and cancelled requests;
- two stores using VND and USD;
- edited `income_records.fine` values that differ from the original suggestion;
- sent, pending, and failed notification rows;
- multiple employees and dates.

Assert the GET result contains separate `pending` and `history`, status counts from all filtered rows, grouped totals such as:

```js
assert.deepEqual(result.summary.fine_totals, [
  { currency: '$', amount: 20 },
  { currency: '₫', amount: 3000000 }
]);
```

Assert notification aggregation distinguishes `sent`, `not_queued`, and `retrying`, and pagination does not change summary values.

- [ ] **Step 5: Run GET tests and verify failure**

Run:

```bash
node --test --test-name-pattern="admin absence query|absence notification summary|absence totals by currency" test/admin-pagination-leave.test.js
```

Expected: FAIL because the handler is absent.

- [ ] **Step 6: Implement `handleAdminAbsence`**

Route `parts[4] === 'absence'` from the existing admin API after store authorization.

For GET:

- reuse `adminFilters`, `adminStoreWhere`, `listPagedRows`, `addRangeFilter`, and sort allowlists;
- apply employee, business-date, and optional status filters consistently;
- query pending and history separately;
- join stores, members/users, current linked income fine, and an aggregated notification CTE;
- compute summary with dedicated unpaginated queries;
- group approved actual fine totals by currency.

For POST actions:

```text
/api/admin/stores/:storeId/absence/:requestId/approve
/api/admin/stores/:storeId/absence/:requestId/reject
```

Validate the request belongs to `storeId` before deciding. Return:

- 400 for blank/malformed rejection reason;
- 404 for no matching request in the URL store;
- 409 for a non-pending request or a lost concurrent decision;
- 200 for the winning decision.

- [ ] **Step 7: Run verification and commit**

Run:

```bash
node --test --test-name-pattern="store-scoped absence|admin absence|absence notification|absence totals" test/admin-pagination-leave.test.js
npm run check
npm test
git diff --check
```

Expected: targeted tests PASS, full suite PASS, syntax and whitespace checks PASS.

Commit:

```bash
git add staffbot-v2-cloudflare/src/index.js staffbot-v2-cloudflare/test/admin-pagination-leave.test.js
git commit -m "feat: add admin absence approval API"
```

### Task 2: Add the localized standalone absence approval page

**Files:**
- Modify: `staffbot-v2-cloudflare/src/index.js`
- Test: `staffbot-v2-cloudflare/test/admin-pagination-leave.test.js`

**Interfaces:**
- Consumes: Task 1 GET response `{ pending, history, summary, filters, pagination }`.
- Consumes: Task 1 approve/reject routes.
- Produces: `renderAbsence()`, `absenceSummaryPanel(data)`, and standalone tab state.

- [ ] **Step 1: Write failing page-structure tests**

Assert the generated admin page contains:

```js
assert.match(source, /data-tab="absence"/);
assert.match(source, /id="tab-absence"/);
assert.match(source, /renderAbsence/);
assert.match(source, /absence_pending_page/);
assert.match(source, /absence_history_page/);
assert.match(source, /data-absence-status/);
```

Also assert all four translation maps include navigation/title, pending/history, notification state, approve-fine, and required-reason labels.

- [ ] **Step 2: Run the page test and verify failure**

Run:

```bash
node --test --test-name-pattern="admin page exposes standalone absence approvals" test/admin-pagination-leave.test.js
```

Expected: FAIL because the tab is missing.

- [ ] **Step 3: Add navigation and independent state**

Add:

- one navigation button with `data-tab="absence"`;
- `<section id="tab-absence" class="panel hidden"></section>`;
- `absence` page state with `pending_page` and `history_page`;
- `absence` sort state for pending/history;
- an absence status filter synchronized with the existing store/employee/date filters;
- `loadTab()` routing to `renderAbsence()`.

Do not alter the attendance tab layout.

- [ ] **Step 4: Write failing interaction tests**

Assert:

- approved fine totals render per currency;
- pending rows include real `store_id` on action buttons;
- approve calls the new approve URL only after confirmation;
- reject cancellation sends nothing;
- blank/whitespace rejection reason sends nothing and shows the required message;
- nonblank reason is trimmed and sent as JSON;
- successful actions reload only the current absence tab.

- [ ] **Step 5: Implement the page using existing components**

Render in order:

1. shared store/employee/date filters plus status;
2. five summary cards;
3. pending table with approve/reject actions;
4. history table;
5. independent pagers.

Pending columns:

```text
store_id, display_name, business_date, fine, created_at,
notification_status, notification_delivery, action
```

History columns:

```text
store_id, display_name, business_date, status, original_fine,
actual_fine, admin_id, decided_at, decision_reason, income_record_id
```

Map notification aggregation to localized labels, while keeping retry error details out of the table.

- [ ] **Step 6: Verify and commit**

Run:

```bash
node --test --test-name-pattern="standalone absence|absence page|absence action" test/admin-pagination-leave.test.js
npm run check
npm test
git diff --check
```

Expected: all checks PASS.

Commit:

```bash
git add staffbot-v2-cloudflare/src/index.js staffbot-v2-cloudflare/test/admin-pagination-leave.test.js
git commit -m "feat: add admin absence approval page"
```

### Task 3: Whole-feature verification and review

**Files:**
- No planned production changes.
- Test if a review exposes a missing regression: `staffbot-v2-cloudflare/test/admin-pagination-leave.test.js`.

**Interfaces:**
- Consumes: completed Tasks 1 and 2.
- Produces: reviewed feature branch ready for integration.

- [ ] **Step 1: Run final local gates**

Run:

```bash
npm run check
npm test
git diff --check
```

Expected: syntax check passes, every test passes, no whitespace errors.

- [ ] **Step 2: Verify migration scope**

Run:

```bash
BASE=$(git merge-base main HEAD)
git diff --name-status "$BASE"..HEAD
```

Expected: only `src/index.js` and the existing test file changed after the design/plan commits; no migration, dependency, or Wrangler configuration file.

- [ ] **Step 3: Verify local HTTP markers**

Start `npx wrangler dev --local --port 8787`, then run:

```bash
curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/
curl -fsS http://127.0.0.1:8787/admin | rg 'tab-absence|renderAbsence|absence_pending_page'
```

Expected: homepage HTTP 200 and all three admin markers present. Stop the local server afterward.

- [ ] **Step 4: Review the whole branch**

Review requirements, store authorization, HTTP status behavior, concurrency, pagination-independent summaries, currency grouping, exact rejection reason behavior, four-language rendering, and scope hygiene. Fix every Critical or Important finding and repeat the relevant tests.

- [ ] **Step 5: Complete the feature branch**

Use `superpowers:finishing-a-development-branch`. Do not deploy or push unless the user selects that integration option.
