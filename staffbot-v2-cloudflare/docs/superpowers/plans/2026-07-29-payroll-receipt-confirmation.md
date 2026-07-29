# Traceable Payroll Receipt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the employee's one-line payroll confirmation with a localized, traceable receipt containing employee identity, store, payroll period, total, non-zero payment splits, confirmation time, and payroll ID.

**Architecture:** Keep the existing confirmation transaction unchanged. Add a pure receipt renderer in `payroll-notifications.js`, enrich the existing employee payroll lookup with read-only store and employee context, and let the Telegram callback edit the original message with the rendered receipt while returning a short callback acknowledgement.

**Tech Stack:** Cloudflare Workers JavaScript, D1/SQLite, Telegram Bot API, Node.js built-in test runner.

## Global Constraints

- Do not add or modify database schema or migrations.
- Do not change payroll calculation, the noon cutoff, period boundaries, payment proof handling, or email delivery behavior.
- Format period and confirmation timestamps in the employee store's timezone to the minute.
- Show only non-zero bank, USDT, and cash split lines.
- Never show bank details, USDT addresses, QR codes, or payment proof contents in the receipt.
- Keep Chinese, English, Vietnamese, and Russian behavior aligned.
- Deploy only to staging; production must remain untouched.

---

### Task 1: Localized payroll receipt renderer

**Files:**
- Create: `test/payroll-receipt.test.js`
- Modify: `src/dates.js`
- Modify: `src/i18n.js`
- Modify: `src/payroll-notifications.js`

**Interfaces:**
- Consumes: A confirmed payroll row containing `employee_name`, `telegram_id`, `store_name`, `timezone`, `period_start`, `cutoff_at`, `amount_snapshot_micros`, `bank_micros`, `usdt_micros`, `cash_micros`, `currency`, `confirmed_at`, and `payroll_id`.
- Produces: `formatLocalDateTime(value, timezone): string` from `src/dates.js`.
- Produces: `payrollReceiptMessage(payroll): string` from `src/payroll-notifications.js`.

- [ ] **Step 1: Write the failing receipt renderer test**

Create `test/payroll-receipt.test.js` with a fixed VND payroll:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  payrollReceiptMessage
} from '../src/payroll-notifications.js';

const confirmedPayroll = {
  employee_name: 'Alice',
  telegram_id: '1001',
  store_name: 'Tokyo Club',
  timezone: 'Asia/Tokyo',
  period_start: '2026-07-30T03:00:00.000Z',
  cutoff_at: '2026-08-13T03:00:00.000Z',
  amount_snapshot_micros: 8_000_000_000_000,
  bank_micros: 5_000_000_000_000,
  usdt_micros: 3_000_000_000_000,
  cash_micros: 0,
  currency: '₫',
  confirmed_at: '2026-08-13T11:15:00.000Z',
  payroll_id: 'PAYROLL:DEFAULT:1001:2026-08-13'
};

test('renders a traceable Chinese payroll receipt in store time', () => {
  assert.equal(
    payrollReceiptMessage({
      ...confirmedPayroll,
      language: 'zh'
    }),
    [
      '✅ 工资收款已确认',
      '',
      '员工：Alice',
      'Telegram ID：1001',
      '店铺：Tokyo Club',
      '',
      '工资周期：',
      '2026/07/30 12:00 至 2026/08/13 12:00',
      '',
      '工资总额：₫8,000,000',
      '银行卡：₫5,000,000',
      'USDT：₫3,000,000',
      '',
      '确认时间：2026/08/13 20:15',
      '工资 ID：PAYROLL:DEFAULT:1001:2026-08-13'
    ].join('\n')
  );
});

test('renders every supported language without unresolved fields', () => {
  for (const language of ['zh', 'en', 'vi', 'ru']) {
    const message = payrollReceiptMessage({
      ...confirmedPayroll,
      language
    });
    assert.match(message, /Alice/);
    assert.match(message, /1001/);
    assert.match(message, /Tokyo Club/);
    assert.match(message, /2026\/07\/30 12:00/);
    assert.match(message, /2026\/08\/13 20:15/);
    assert.match(message, /₫8,000,000/);
    assert.match(message, /₫5,000,000/);
    assert.match(message, /₫3,000,000/);
    assert.doesNotMatch(message, /Cash|现金|Tiền mặt|Наличные/);
    assert.doesNotMatch(message, /\{[a-z_]+\}/);
  }
});
```

This test catches a missing receipt renderer, wrong timezone, wrong micros conversion, omitted identity/period fields, unresolved translations, and accidental display of zero-value payment methods.

- [ ] **Step 2: Run the renderer test and verify RED**

Run:

```bash
node --test test/payroll-receipt.test.js
```

Expected: FAIL because `payrollReceiptMessage` is not exported.

- [ ] **Step 3: Add the local datetime formatter**

Add to `src/dates.js`:

```js
export function formatLocalDateTime(
  value,
  timezone = 'Asia/Tokyo'
) {
  const text = String(value || '').trim();
  if (!text) return '';
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  const parts = localParts(
    date,
    timezone || 'Asia/Tokyo'
  );
  return [
    `${parts.year}/${parts.month}/${parts.day}`,
    `${parts.hour}:${parts.minute}`
  ].join(' ');
}
```

- [ ] **Step 4: Add four-language receipt strings**

In `src/i18n.js`, replace the short `payroll_receipt_confirmed` value with a template containing:

```text
{employee}
{telegram_id}
{store}
{period_start}
{period_end}
{amount}
{payment_methods}
{confirmed_at}
{payroll_id}
```

Add `payroll_receipt_confirmed_ack` for the short callback response and
`payroll_payment_method_amount` for a localized payment split line. Define all
three keys in Chinese, English, Vietnamese, and Russian.

- [ ] **Step 5: Implement the pure receipt renderer**

In `src/payroll-notifications.js`:

```js
import {
  formatLocalDateTime,
  localDate
} from './dates.js';

function receiptPaymentMethodLines(language, payroll) {
  return ['bank', 'usdt', 'cash']
    .filter((method) =>
      Number(payroll[`${method}_micros`]) > 0
    )
    .map((method) => render(
      language,
      'payroll_payment_method_amount',
      {
        method: t(
          language,
          `payroll_profile_${method}`
        ),
        amount: formatMoney(
          { currency: payroll.currency },
          Number(
            payroll[`${method}_micros`]
          ) / 1_000_000
        )
      }
    ));
}

export function payrollReceiptMessage(payroll) {
  const language = payroll.language || 'zh';
  const timezone = payroll.timezone || 'Asia/Tokyo';
  return render(language, 'payroll_receipt_confirmed', {
    employee: payroll.employee_name
      || String(payroll.telegram_id),
    telegram_id: payroll.telegram_id,
    store: payroll.store_name,
    period_start: formatLocalDateTime(
      payroll.period_start,
      timezone
    ),
    period_end: formatLocalDateTime(
      payroll.cutoff_at,
      timezone
    ),
    amount: formatMoney(
      { currency: payroll.currency },
      Number(
        payroll.amount_snapshot_micros
      ) / 1_000_000
    ),
    payment_methods: receiptPaymentMethodLines(
      language,
      payroll
    ).join('\n'),
    confirmed_at: formatLocalDateTime(
      payroll.confirmed_at,
      timezone
    ),
    payroll_id: payroll.payroll_id
  });
}
```

- [ ] **Step 6: Run the renderer test and verify GREEN**

Run:

```bash
node --test test/payroll-receipt.test.js
```

Expected: 2 tests pass.

- [ ] **Step 7: Commit the renderer slice**

```bash
git add \
  staffbot-v2-cloudflare/src/dates.js \
  staffbot-v2-cloudflare/src/i18n.js \
  staffbot-v2-cloudflare/src/payroll-notifications.js \
  staffbot-v2-cloudflare/test/payroll-receipt.test.js
git commit -m "feat: render traceable payroll receipts"
```

---

### Task 2: Use the receipt after employee confirmation

**Files:**
- Modify: `test/telegram-flow.test.js`
- Modify: `src/payroll-payments.js`
- Modify: `src/telegram.js`

**Interfaces:**
- Consumes: `payrollReceiptMessage(payroll): string` from Task 1.
- Produces: `confirmPayrollReceipt(...)` returns the confirmed payroll with `store_name`, `timezone`, and `employee_name`.
- Produces: The `pay:ok:<payroll_id>` callback edits the original message to the detailed receipt and answers the callback with `payroll_receipt_confirmed_ack`.

- [ ] **Step 1: Extend the existing end-to-end confirmation test**

In the existing `admin splits payroll and uploads proof images by payment method`
test in `test/telegram-flow.test.js`, add these assertions after the employee
confirmation callback:

```js
const receipt = fixture.payloads.find((payload) =>
  payload.message_id === 2
  && payload.text
  && payload.text.includes('工资收款已确认')
);
assert.ok(receipt);
assert.match(receipt.text, /员工：Alice/);
assert.match(receipt.text, /Telegram ID：1001/);
assert.match(receipt.text, /店铺：Tokyo Club/);
assert.match(
  receipt.text,
  /2026\/07\/01 09:00 至 2026\/07\/16 12:00/
);
assert.match(receipt.text, /工资总额：\$60\.00/);
assert.match(receipt.text, /银行卡：\$40\.00/);
assert.match(receipt.text, /现金：\$20\.00/);
assert.doesNotMatch(receipt.text, /USDT：/);
assert.match(receipt.text, /确认时间：\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}/);
assert.match(receipt.text, /工资 ID：PAYROLL-ADMIN/);
assert.equal(receipt.reply_markup, undefined);

const receiptAck = fixture.payloads.find((payload) =>
  payload.callback_query_id === 'callback-1001'
  && payload.text === '确认成功。'
);
assert.ok(receiptAck);
```

This test catches failure to identify the employee, failure to use the store
timezone, wrong split filtering, a lingering keyboard, and an oversized callback
answer.

- [ ] **Step 2: Run the Telegram flow test and verify RED**

Run:

```bash
node --test test/telegram-flow.test.js
```

Expected: FAIL because the edited message still contains only
`已确认收到工资，谢谢。`.

- [ ] **Step 3: Enrich the employee payroll lookup**

Change `employeePayroll` in `src/payroll-payments.js` to select from
`payroll_disbursements d` and left-join:

```sql
JOIN stores s
  ON s.store_id = d.store_id
LEFT JOIN store_members m
  ON m.store_id = d.store_id
 AND m.telegram_id = d.telegram_id
LEFT JOIN users u
  ON u.telegram_id = d.telegram_id
```

Return:

```sql
d.*,
s.name AS store_name,
s.timezone,
COALESCE(
  NULLIF(m.display_name, ''),
  NULLIF(u.name, ''),
  NULLIF(u.username, ''),
  d.telegram_id
) AS employee_name
```

Keep the existing `payroll_id` and employee `telegram_id` authorization
conditions unchanged.

- [ ] **Step 4: Render the detailed receipt in the callback**

In `src/telegram.js`, import `payrollReceiptMessage` beside
`sendPayrollForEmployeeConfirmation`. Capture the return value from
`confirmPayrollReceipt`, then:

```js
const receipt = payrollReceiptMessage({
  ...payroll,
  language: lang
});
await editCallbackMessage(env, callback, receipt);
return answerCallback(
  env,
  callback.id,
  t(lang, 'payroll_receipt_confirmed_ack')
);
```

Keep the existing error branches unchanged.

- [ ] **Step 5: Run targeted tests and verify GREEN**

Run:

```bash
node --test \
  test/payroll-receipt.test.js \
  test/payroll-payments.test.js \
  test/telegram-flow.test.js
```

Expected: all targeted tests pass.

- [ ] **Step 6: Commit the callback integration**

```bash
git add \
  staffbot-v2-cloudflare/src/payroll-payments.js \
  staffbot-v2-cloudflare/src/telegram.js \
  staffbot-v2-cloudflare/test/telegram-flow.test.js
git commit -m "feat: show traceable payroll confirmation receipts"
```

---

### Task 3: Full verification and staging release

**Files:**
- Verify only; no planned source changes.

**Interfaces:**
- Consumes: Completed Tasks 1 and 2.
- Produces: A tested staging Worker version; production remains unchanged.

- [ ] **Step 1: Run syntax and full test checks**

Run:

```bash
npm run check
npm test
```

Expected: syntax check succeeds and the complete test suite passes with no
warnings or failures.

- [ ] **Step 2: Review the complete change scope**

Run from the Git root:

```bash
git status --short
git diff HEAD~2..HEAD --check
git diff HEAD~2..HEAD --stat
git diff HEAD~2..HEAD -- \
  staffbot-v2-cloudflare/src \
  staffbot-v2-cloudflare/test
```

Expected: only the planned receipt, query, callback, localization, date helper,
and test changes appear; no secrets or production configuration changes appear.

- [ ] **Step 3: Verify Cloudflare identity and staging migrations**

Run:

```bash
npx wrangler whoami
npx wrangler d1 migrations list \
  staffbot_v2_staging \
  --remote \
  --env staging \
  --config wrangler.toml
```

Expected: the authenticated Cloudflare account is shown and there are no new
schema migrations for this feature.

- [ ] **Step 4: Deploy only the staging configuration**

Run:

```bash
npx wrangler deploy \
  --env staging \
  --config wrangler.toml
```

Expected: deployment succeeds for
`staffbot-v2-staging.staffbot-v2.workers.dev`; no production deploy command is
run.

- [ ] **Step 5: Smoke-test staging HTTP routes**

Run:

```bash
curl -fsS \
  https://staffbot-v2-staging.staffbot-v2.workers.dev/
curl -fsS \
  https://staffbot-v2-staging.staffbot-v2.workers.dev/admin
```

Expected: the Worker health response and admin login page are both returned.

- [ ] **Step 6: Report Telegram acceptance steps**

Ask the user to create or reuse one staging payroll awaiting employee
confirmation, then verify:

1. The original message changes into the detailed receipt.
2. Employee name, Telegram ID, store, period, total, and non-zero splits are
   correct.
3. Confirmation time uses the store timezone.
4. The payroll ID is visible.
5. The confirmation buttons disappear.
