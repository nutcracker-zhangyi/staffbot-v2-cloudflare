# Payroll Completion Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a confirmed payroll immediately understandable and traceable in the Chinese mobile admin UI.

**Architecture:** Keep the database and management API unchanged. Add narrowly scoped display mappings and store-timezone formatting in the existing generated management client, then cover the rendered list and dossier with browser-style unit tests.

**Tech Stack:** Cloudflare Workers, generated vanilla JavaScript client, Node test runner, linkedom-based browser fixture.

## Global Constraints

- Deploy and verify on staging only; live is outside this task.
- Do not modify payroll calculations, state transitions, Telegram delivery, proof storage, database schema, or API response contracts.
- Preserve HTML escaping and unknown audit actions.
- Continue showing all stored payment proofs.

---

### Task 1: Confirmed payroll list and dossier summary

**Files:**
- Modify: `test/manage-page.test.js`
- Modify: `src/manage-client.js`

**Interfaces:**
- Consumes: `state.stores`, payroll fields `status`, `payroll_id`, `telegram_id`, `confirmed_at`, `period_start`, and `cutoff_at`.
- Produces: `payrollStatusLabel(status, context)`, `payrollClaimLabel(payroll)`, and `formatPayrollDateTime(value, storeId)` for payroll rendering.

- [ ] **Step 1: Write failing list and dossier tests**

Extend the confirmed-payroll fixtures so assertions require:

```js
assert.match(listText, /员工已确认 · 已完成/);
assert.doesNotMatch(listText, /confirmed|未领取/);
assert.match(detailText, /工资已完成/);
assert.match(detailText, /工资 ID.*PAYROLL-1/);
assert.match(detailText, /确认账号.*EMP-1/);
assert.match(detailText, /确认时间.*2026-07-29 11:00.*店铺时区/);
assert.doesNotMatch(detailText, /当前未领取/);
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
node --test --test-name-pattern='confirmed payroll' test/manage-page.test.js
```

Expected: failure because current output contains `confirmed`, `未领取`, and unconverted UTC time.

- [ ] **Step 3: Add minimal confirmed-state rendering**

In `src/manage-client.js`:

```js
function payrollStatusLabel(status, context = 'list') {
  if (status === 'confirmed') return context === 'detail' ? '工资已完成' : '员工已确认';
  return statusLabels[status] || status;
}

function payrollClaimLabel(payroll) {
  if (payroll.status === 'confirmed') return '已完成';
  return claimIsActive(payroll.claim)
    ? '处理人：' + payroll.claim.claimed_by
    : '未领取';
}
```

Add a defensive store-timezone formatter based on `Intl.DateTimeFormat(...).formatToParts()` and use it only for payroll dates. Add payroll ID, confirmation account, and store-timezone confirmation time to completed dossier facts. Omit the claim-status paragraph for completed payrolls.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the same focused command and require zero failures.

- [ ] **Step 5: Commit the completed-state slice**

```bash
git add src/manage-client.js test/manage-page.test.js
git commit -m "fix: clarify completed payroll status"
```

### Task 2: Payment version, employee feedback, and audit translations

**Files:**
- Modify: `test/manage-page.test.js`
- Modify: `src/manage-client.js`

**Interfaces:**
- Consumes: payment attempt fields `status`, `employee_response`, `employee_responded_at`, and audit field `action`.
- Produces: `paymentAttemptStatusLabel(status)`, `employeeResponseLabel(response)`, and `historyActionLabel(action)`.

- [ ] **Step 1: Write a failing traceability test**

Require a completed dossier to contain:

```js
assert.match(detailText, /员工已确认/);
assert.match(detailText, /员工反馈：已确认收到工资/);
assert.match(detailText, /员工确认收到工资/);
assert.doesNotMatch(detailText, /employee_confirmed|confirm_payroll_receipt/);
```

Also assert that both bank and USDT proof captions remain present.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test --test-name-pattern='completed payroll traceability' test/manage-page.test.js
```

Expected: failure because the raw status, response, and audit action are visible.

- [ ] **Step 3: Add minimal translation maps**

Add exact maps for payment-attempt states, employee responses, and known payroll audit actions. Render unknown audit actions with the original value. Pass the payroll store timezone into the attempt and history renderers so submitted, response, proof, and audit timestamps use the same formatter.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same focused command and require zero failures.

- [ ] **Step 5: Run project verification**

```bash
npm test
npm run check
git diff --check
```

Expected: all tests pass, syntax check exits 0, and no whitespace errors are reported.

- [ ] **Step 6: Commit the traceability slice**

```bash
git add src/manage-client.js test/manage-page.test.js
git commit -m "fix: localize payroll completion history"
```

### Task 3: Staging release and mobile verification

**Files:**
- No source changes expected.

**Interfaces:**
- Consumes: the staging Worker and the confirmed payroll `QA-MANAGE-PAYROLL-8467459276-20260912`.
- Produces: a verified staging version ID and browser evidence for the approved acceptance criteria.

- [ ] **Step 1: Deploy only the staging environment**

```bash
npx wrangler deploy --env staging
```

- [ ] **Step 2: Verify the actual mobile list and dossier**

Open the deployed `/manage/` page, enter the wage section, and inspect the confirmed ₫8,000 payroll. Verify all seven acceptance criteria from the design spec, including both proof images.

- [ ] **Step 3: Query the staging D1 record read-only**

Confirm that the payroll remains `confirmed`, its attempt remains `employee_confirmed`, and no amounts or proof metadata changed during this display-only release.
