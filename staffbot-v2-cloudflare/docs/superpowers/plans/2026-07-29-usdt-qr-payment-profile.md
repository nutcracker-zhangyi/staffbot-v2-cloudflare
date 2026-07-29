# USDT Payment QR Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow an employee to provide a USDT address, a private QR image, or both, and freeze the selected QR version into each automatic payroll without changing its amount or period.

**Architecture:** Store every QR upload as an immutable metadata row plus a private R2 object. The current payment profile points to one active QR version, while each payroll copies that version ID into its immutable payment snapshot. Telegram owns employee upload and administrator delivery; the authenticated admin API owns browser reads.

**Tech Stack:** Cloudflare Workers, D1 SQLite, private R2, Telegram Bot API, generated vanilla admin HTML/JavaScript, Node.js built-in test runner.

## Global Constraints

- Work only in `.worktrees/staging-environment/staffbot-v2-cloudflare` on `codex/staging-environment`.
- Follow TDD for every behavior change: RED, minimal GREEN, full regression gate.
- Do not add npm dependencies.
- Accept USDT address only, QR only, or both; reject USDT with neither.
- Accept Telegram photos only; allow JPEG, PNG, and WebP up to 10 MiB.
- Keep the R2 bucket private and expose no object key, Telegram file ID, token, image body, or public URL in logs or JSON.
- Preserve every superseded QR referenced by a current profile or payroll snapshot.
- Reject profile changes once `current_admin_id IS NOT NULL`.
- Never recalculate `amount_snapshot_micros`, `period_start`, or `cutoff_at` when payment details change.
- Do not enable staging Cron, configure email, migrate production, deploy production, merge, push, or create a pull request.
- Use the current controlled payroll `PAYROLL:DEFAULT:8467459276:2026-08-13` for live staging acceptance.

## File Map

| File | Responsibility |
| --- | --- |
| `db/migrations/022_usdt_payment_qr.sql` | Add immutable QR versions and profile/payroll pointers |
| `db/schema.sql` | Canonical schema matching migration 022 |
| `src/telegram-images.js` | Shared Telegram photo selection, download, MIME and size validation |
| `src/payroll-proofs.js` | Existing payment-proof storage using the shared image helper |
| `src/payroll-payment-qr.js` | QR object keys, R2 storage, compensation and private reads |
| `src/payroll-payments.js` | Profile validation, active QR pointer, payroll snapshot and edit lock |
| `src/payroll-settlement.js` | Copy current QR version into new payroll snapshots |
| `src/telegram.js` | QR-mode buttons, upload states and administrator QR delivery |
| `src/i18n.js` | Chinese, English, Vietnamese and Russian QR flow strings |
| `src/admin-api.js` | QR presence fields and authenticated QR response |
| `src/admin-page.js` | “USDT QR provided” and private view link |
| `test/payroll-payment-qr.test.js` | Schema, R2, compensation and access tests |
| `test/payroll-payments.test.js` | Address/QR validation, snapshot and locking tests |
| `test/payroll-settlement.test.js` | Automatic settlement QR snapshot tests |
| `test/payroll-proofs.test.js` | Characterize existing proof ingestion during helper extraction |
| `test/telegram-flow.test.js` | Telegram address/QR/both workflows |
| `test/admin-payroll.test.js` | Admin JSON, cross-store denial and private image tests |
| `test/worker-routing.test.js` | Generated admin client and route regression |
| `docs/reports/2026-07-29-staging-personal-payroll-validation.md` | Live QR and resumed payment evidence |
| `docs/ROADMAP.md` | Phase 10 staging status |

---

### Task 1: Add the immutable QR schema

**Files:**

- Create: `db/migrations/022_usdt_payment_qr.sql`
- Modify: `db/schema.sql`
- Create: `test/payroll-payment-qr.test.js`

**Interfaces:**

- Produces: `payroll_payment_qr_codes`, `payroll_payment_profiles.usdt_qr_id`, and `payroll_disbursements.usdt_qr_id_snapshot`.
- Preserves: every existing profile and payroll with both new pointer fields set to `NULL`.

- [ ] **Step 1: Write the failing canonical-schema test**

```js
test('canonical schema stores versioned private USDT QR references', () => {
  const database = canonicalDatabase();
  assert.deepEqual(columnNames(database, 'payroll_payment_qr_codes'), [
    'qr_id', 'store_id', 'telegram_id', 'object_key',
    'telegram_file_id', 'mime_type', 'size_bytes',
    'uploaded_at', 'superseded_at'
  ]);
  assert.ok(columnNames(database, 'payroll_payment_profiles')
    .includes('usdt_qr_id'));
  assert.ok(columnNames(database, 'payroll_disbursements')
    .includes('usdt_qr_id_snapshot'));
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
node --test test/payroll-payment-qr.test.js
```

Expected: FAIL because `payroll_payment_qr_codes` and both pointer columns do not exist.

- [ ] **Step 3: Add migration 022 and canonical schema**

Use this contract in both files:

```sql
CREATE TABLE payroll_payment_qr_codes (
  qr_id TEXT PRIMARY KEY CHECK (length(trim(qr_id)) > 0),
  store_id TEXT NOT NULL CHECK (length(trim(store_id)) > 0),
  telegram_id TEXT NOT NULL CHECK (length(trim(telegram_id)) > 0),
  object_key TEXT NOT NULL UNIQUE CHECK (length(trim(object_key)) > 0),
  telegram_file_id TEXT NOT NULL
    CHECK (length(trim(telegram_file_id)) > 0),
  mime_type TEXT NOT NULL
    CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes INTEGER NOT NULL
    CHECK (typeof(size_bytes) = 'integer' AND size_bytes > 0),
  uploaded_at TEXT NOT NULL,
  superseded_at TEXT
);

CREATE INDEX idx_payroll_payment_qr_employee_time
  ON payroll_payment_qr_codes (store_id, telegram_id, uploaded_at);

CREATE UNIQUE INDEX idx_payroll_payment_qr_active
  ON payroll_payment_qr_codes (store_id, telegram_id)
  WHERE superseded_at IS NULL;

ALTER TABLE payroll_payment_profiles ADD COLUMN usdt_qr_id TEXT;
ALTER TABLE payroll_disbursements ADD COLUMN usdt_qr_id_snapshot TEXT;
```

Place the two new columns directly after `usdt_details` and
`usdt_details_snapshot` in the canonical `CREATE TABLE` definitions.

- [ ] **Step 4: Add migration-preservation and constraint tests**

Test that:

```js
assert.equal(existingProfile.usdt_qr_id, null);
assert.equal(existingPayroll.usdt_qr_id_snapshot, null);
assert.throws(() => insertSecondUnsupersededQr(database));
assert.doesNotThrow(() => supersedeFirstThenInsertSecond(database));
```

- [ ] **Step 5: Run GREEN**

Run:

```bash
node --test test/payroll-payment-qr.test.js
npm run check
```

Expected: all QR schema tests pass and syntax check exits 0.

- [ ] **Step 6: Commit**

```bash
git add db/schema.sql db/migrations/022_usdt_payment_qr.sql test/payroll-payment-qr.test.js
git commit -m "feat: add versioned USDT payment QR schema"
```

---

### Task 2: Share Telegram image ingestion without changing proof behavior

**Files:**

- Create: `src/telegram-images.js`
- Modify: `src/payroll-proofs.js`
- Modify: `test/payroll-proofs.test.js`

**Interfaces:**

- Produces:

```js
export function largestTelegramPhoto(photo) {}
export async function downloadTelegramImage(
  env,
  photo,
  { maxBytes = 10 * 1024 * 1024 } = {}
) {}
```

- `downloadTelegramImage()` returns:

```js
{
  bytes,
  extension: 'jpg' | 'png' | 'webp',
  file_name,
  mime_type,
  size_bytes,
  telegram_file_id
}
```

- [ ] **Step 1: Extend proof characterization tests**

Add assertions that the existing proof path:

```js
assert.equal(proof.telegram_file_id, 'PHOTO-LARGE');
assert.equal(proof.mime_type, 'image/jpeg');
assert.equal(proof.size_bytes, 4);
assert.equal(bucket.puts.length, 1);
```

Also retain existing oversized, non-image and failed-D1 compensation cases.

- [ ] **Step 2: Run the characterization suite**

Run:

```bash
node --test test/payroll-proofs.test.js
```

Expected: PASS before refactoring.

- [ ] **Step 3: Extract the helper**

Move photo selection, `getFile`, file download, MIME lookup and two-stage size
validation into `src/telegram-images.js`. Use these exact errors:

```js
throw new Error('telegram image is required');
throw new RangeError('telegram image is too large');
throw new TypeError('telegram upload must be an image');
```

Keep the existing proof module’s public errors by mapping helper errors:

```js
if (error.message === 'telegram image is required') {
  throw new Error('payroll proof photo is required');
}
```

- [ ] **Step 4: Update proof storage to consume the helper**

Replace its duplicate image code with:

```js
const image = await downloadTelegramImage(env, photo, {
  maxBytes: maximumProofBytes(env)
});
```

Keep its existing object key, R2 metadata, database row and compensation logic unchanged.

- [ ] **Step 5: Verify no proof regression**

Run:

```bash
node --test test/payroll-proofs.test.js test/telegram-flow.test.js
npm test
```

Expected: existing proof tests and the full suite pass with no changed user-visible proof behavior.

- [ ] **Step 6: Commit**

```bash
git add src/telegram-images.js src/payroll-proofs.js test/payroll-proofs.test.js
git commit -m "refactor: share Telegram image ingestion"
```

---

### Task 3: Store private QR versions and freeze them into payroll

**Files:**

- Create: `src/payroll-payment-qr.js`
- Modify: `src/payroll-payments.js`
- Modify: `src/payroll-settlement.js`
- Modify: `test/payroll-payment-qr.test.js`
- Modify: `test/payroll-payments.test.js`
- Modify: `test/payroll-settlement.test.js`

**Interfaces:**

- Produces:

```js
export function paymentQrObjectKey(owner, qrId, extension) {}
export async function saveTelegramPaymentQr(
  env, actorId, payrollId, profileInput, photo, now = new Date()
) {}
export async function readPayrollPaymentQr(env, actor, payrollId) {}
```

- Extends:

```js
validatePaymentProfile({
  accepts_bank,
  accepts_usdt,
  accepts_cash,
  bank_details,
  usdt_details,
  usdt_qr_id
});
```

- [ ] **Step 1: Write failing validation and snapshot tests**

Cover these literal cases:

```js
assert.doesNotThrow(() => validatePaymentProfile({
  accepts_usdt: true,
  usdt_details: '',
  usdt_qr_id: 'QR-1'
}));
assert.doesNotThrow(() => validatePaymentProfile({
  accepts_usdt: true,
  usdt_details: '0xabc',
  usdt_qr_id: null
}));
assert.throws(() => validatePaymentProfile({
  accepts_usdt: true,
  usdt_details: '',
  usdt_qr_id: null
}), /USDT address or QR is required/);
```

Set a profile to `QR-1`, settle a payroll, change the profile to `QR-2`, and
assert the old payroll still has `usdt_qr_id_snapshot = 'QR-1'`.

- [ ] **Step 2: Run RED**

Run:

```bash
node --test test/payroll-payments.test.js test/payroll-settlement.test.js test/payroll-payment-qr.test.js
```

Expected: FAIL because QR-aware validation, snapshot fields and storage functions are absent.

- [ ] **Step 3: Implement object key and QR R2 preparation**

Use:

```js
return [
  'payroll-payment-qr',
  encodeURIComponent(owner.store_id),
  encodeURIComponent(owner.telegram_id),
  `${encodeURIComponent(qrId)}.${extension}`
].join('/');
```

`saveTelegramPaymentQr()` must:

1. authorize `actorId` as the payroll employee;
2. require `awaiting_employee_details`, or `awaiting_admin_payment` with
   `current_admin_id IS NULL`;
3. download the validated Telegram image;
4. put it in `PAYROLL_PROOFS` with `onlyIf.etagDoesNotMatch='*'`;
5. execute the QR row, previous-row supersede, profile upsert, payroll snapshot
   update and audit insert in one D1 batch;
6. delete the new R2 object when the D1 batch throws or updates no payroll.

- [ ] **Step 4: Make profile writes QR-aware and locked**

`savePaymentProfile()` must accept an existing QR ID and apply this condition
to every profile/snapshot mutation:

```sql
WHERE payroll_id = ?
  AND telegram_id = ?
  AND status IN ('awaiting_employee_details', 'awaiting_admin_payment')
  AND current_admin_id IS NULL
```

Validation becomes:

```js
if (acceptsUsdt && !usdtDetails && !usdtQrId) {
  throw new TypeError('USDT address or QR is required');
}
```

If USDT is disabled or address-only is selected, set `usdt_qr_id = NULL`,
supersede the old active QR, and set `usdt_qr_id_snapshot = NULL` only on the
still-editable payroll.

- [ ] **Step 5: Copy QR IDs during automatic settlement**

Extend `eligiblePayrollMembers()`, `settlementDraft()` and the insert statement:

```js
usdt_qr_id_snapshot: profile && profile.usdt_qr_id
  ? String(profile.usdt_qr_id)
  : null
```

Change profile validity to:

```js
const acceptsUsdt = Number(profile.accepts_usdt) === 1
  && (
    String(profile.usdt_details || '').trim() !== ''
    || String(profile.usdt_qr_id || '').trim() !== ''
  );
```

- [ ] **Step 6: Add compensation, authorization and lock tests**

Assert:

```js
assert.equal(bucket.deletes[0], newlyWrittenObjectKey);
assert.equal(savedPayroll.amount_snapshot_micros, 8_000_000_000_000);
assert.equal(savedPayroll.usdt_qr_id_snapshot, 'QR-NEW');
await assert.rejects(
  () => saveTelegramPaymentQr(env, employeeId, lockedPayrollId, input, photo),
  /payroll payment details are locked/
);
```

Also require an unauthorized actor to receive 403 from `readPayrollPaymentQr()`.

- [ ] **Step 7: Run GREEN**

Run:

```bash
node --test test/payroll-payment-qr.test.js test/payroll-payments.test.js test/payroll-settlement.test.js
npm test
```

Expected: focused tests and full suite pass.

- [ ] **Step 8: Commit**

```bash
git add src/payroll-payment-qr.js src/payroll-payments.js src/payroll-settlement.js test/payroll-payment-qr.test.js test/payroll-payments.test.js test/payroll-settlement.test.js
git commit -m "feat: snapshot private USDT payment QR codes"
```

---

### Task 4: Add the Telegram address/QR/both workflow

**Files:**

- Modify: `src/payroll-payments.js`
- Modify: `src/telegram.js`
- Modify: `src/i18n.js`
- Modify: `test/telegram-flow.test.js`

**Interfaces:**

- Produces:

```js
export function usdtDetailModeKeyboard(payrollId, language) {}
```

- Adds states:

```text
WAIT_PAYROLL_USDT_MODE
WAIT_PAYROLL_USDT_DETAILS
WAIT_PAYROLL_USDT_QR
```

- Adds callbacks:

```text
pay:um:a:<payrollId>
pay:um:q:<payrollId>
pay:um:b:<payrollId>
```

- [ ] **Step 1: Write failing keyboard and flow tests**

Test all three button modes:

```js
assert.deepEqual(modeCallbacks, [
  `pay:um:a:${payrollId}`,
  `pay:um:q:${payrollId}`,
  `pay:um:b:${payrollId}`
]);
```

Require:

- address-only finishes after text;
- QR-only finishes after one photo and never asks for text;
- both asks for text then photo;
- non-photo in `WAIT_PAYROLL_USDT_QR` keeps the same state;
- the current `8,000,000₫` payroll keeps its amount and cutoff after adding QR.

- [ ] **Step 2: Run RED**

Run:

```bash
node --test test/telegram-flow.test.js
```

Expected: FAIL because mode callbacks and QR upload state do not exist.

- [ ] **Step 3: Add all four-language strings**

Add keys for:

```text
payroll_choose_usdt_details
btn_usdt_address
btn_usdt_qr
btn_usdt_both
payroll_ask_usdt_qr
payroll_usdt_qr_saved
payroll_usdt_qr_failed
payroll_payment_details_locked
payroll_usdt_qr_caption
```

Chinese text must use “USDT 地址”“USDT 二维码”“地址和二维码” consistently.

- [ ] **Step 4: Route buttons and photo messages**

After bank details, or immediately when no bank text is needed, move USDT to
`WAIT_PAYROLL_USDT_MODE`. For mode `b`, set:

```js
{
  ...data,
  usdt_mode: 'both',
  usdt_details: null,
  usdt_qr_id: null
}
```

After receiving the address, move to `WAIT_PAYROLL_USDT_QR`. In the top-level
message handler, process `message.photo` before text validation for that state
and call `saveTelegramPaymentQr()`.

- [ ] **Step 5: Deliver the saved QR to administrators**

Keep the existing administrator text message. If a snapshot QR exists, query
active store admins and call:

```js
await sendPhoto(
  env,
  adminId,
  qr.telegram_file_id,
  render(lang, 'payroll_usdt_qr_caption', {
    payroll_id: payroll.payroll_id
  })
);
```

A failed `sendPhoto` result must log only store ID, payroll ID, admin ID and a
fixed error summary; it must not undo the profile.

- [ ] **Step 6: Run GREEN and callback-length checks**

Run:

```bash
node --test test/telegram-flow.test.js test/payroll-payments.test.js
npm test
```

Assert every generated callback is at most 64 bytes.

- [ ] **Step 7: Commit**

```bash
git add src/payroll-payments.js src/telegram.js src/i18n.js test/telegram-flow.test.js
git commit -m "feat: collect USDT payment QR profiles"
```

---

### Task 5: Expose QR presence and authenticated admin reads

**Files:**

- Modify: `src/admin-api.js`
- Modify: `src/admin-page.js`
- Modify: `test/admin-payroll.test.js`
- Modify: `test/worker-routing.test.js`

**Interfaces:**

- Extends payroll list/detail JSON with:

```js
{
  has_usdt_qr: true,
  usdt_qr_url: `/api/admin/stores/${storeId}/payroll/${payrollId}/usdt-qr`
}
```

- The list returns only `has_usdt_qr`; detail returns both fields.

- [ ] **Step 1: Write failing API permission tests**

Require:

```js
assert.equal(list.payrolls[0].has_usdt_qr, true);
assert.equal('object_key' in list.payrolls[0], false);
assert.equal('telegram_file_id' in detail.payroll, false);
assert.equal(authorizedResponse.status, 200);
assert.equal(crossStoreResponse.status, 403);
assert.equal(unauthenticatedResponse.status, 401);
assert.equal(authorizedResponse.headers.get('cache-control'), 'private, no-store');
```

- [ ] **Step 2: Run RED**

Run:

```bash
node --test test/admin-payroll.test.js test/worker-routing.test.js
```

Expected: FAIL because QR fields and route do not exist.

- [ ] **Step 3: Add the private route**

Before the generic payroll detail branch, route:

```js
if (parts[6] === 'usdt-qr') {
  return readPayrollPaymentQr(env, actor, payrollId);
}
```

`readPayrollPaymentQr()` must join the payroll snapshot QR by payroll ID,
store ID and employee ID before reading R2.

- [ ] **Step 4: Add safe list/detail fields**

Use SQL existence rather than returning the QR row:

```sql
CASE WHEN q.qr_id IS NULL THEN 0 ELSE 1 END AS has_usdt_qr
```

Build the private route only in the detail response and only when
`has_usdt_qr = 1`.

- [ ] **Step 5: Render the admin controls**

Show:

```html
<span>USDT 二维码：已提供</span>
<a target="_blank" rel="noopener" href="...">查看 USDT 二维码</a>
```

When absent, show `USDT 二维码：未提供`. Do not embed the image or object key
in the list table.

- [ ] **Step 6: Run GREEN**

Run:

```bash
node --test test/admin-payroll.test.js test/worker-routing.test.js
npm test
npm run check
```

Expected: API, generated client, full suite and syntax checks pass.

- [ ] **Step 7: Commit**

```bash
git add src/admin-api.js src/admin-page.js test/admin-payroll.test.js test/worker-routing.test.js
git commit -m "feat: view private USDT payment QR codes"
```

---

### Task 6: Deploy and resume the controlled staging payroll

**Files:**

- Modify: `docs/reports/2026-07-29-staging-personal-payroll-validation.md`
- Modify: `docs/ROADMAP.md`

**Interfaces:**

- Consumes all prior tasks.
- Produces reproducible staging evidence without production mutation.

- [ ] **Step 1: Run the full local release gate**

```bash
npm run check
npm test
npm run test:ledger
npm run test:staging
git diff --check
git status --short
```

Expected: every test passes and the worktree is clean.

- [ ] **Step 2: Prove the remote target and pending migration**

```bash
npx wrangler whoami
npx wrangler d1 migrations list staffbot_v2_staging --env staging --remote
```

Expected: only `022_usdt_payment_qr.sql` is pending for
`staffbot_v2_staging`; record the database name and ID without printing secrets.

- [ ] **Step 3: Apply migration 022 to staging only**

```bash
npx wrangler d1 migrations apply staffbot_v2_staging --env staging --remote
```

Then query table, columns and indexes. Verify the current controlled payroll
still has:

```text
amount_snapshot_micros = 8000000000000
cutoff_at = 2026-08-13T05:00:00.000Z
status = awaiting_admin_payment
usdt_qr_id_snapshot = NULL
```

- [ ] **Step 4: Deploy staging with safety switches unchanged**

```bash
npx wrangler deploy --env staging
```

Record Worker version and verify:

```text
SCHEDULED_TASKS_ENABLED=false
TELEGRAM_RECIPIENT_MODE=allowlist
no Email Sending binding
no Cron trigger
```

- [ ] **Step 5: Add QR to the current payroll through Telegram**

Using employee `8467459276`:

1. reopen “确认/修改收款信息”;
2. select bank and USDT;
3. select `地址和二维码`;
4. retain `QA-BANK-0001` and `QA-USDT-0001`;
5. upload one test QR image.

Verify D1:

```sql
SELECT amount_snapshot_micros, period_start, cutoff_at,
       usdt_qr_id_snapshot, current_admin_id
FROM payroll_disbursements
WHERE payroll_id = 'PAYROLL:DEFAULT:8467459276:2026-08-13';
```

Expected: amount, period and cutoff unchanged; QR snapshot non-null;
`current_admin_id` remains null.

- [ ] **Step 6: Verify private Telegram and admin access**

- The same-store administrator receives the QR image.
- Authenticated admin route returns 200 with `private, no-store`.
- Cross-store/unauthenticated reads return 403/401.
- Direct R2/public URL access is unavailable.
- Logs contain no object key, Telegram file ID, address text, bot token or image body.

- [ ] **Step 7: Resume the existing payment flow**

Use a bank/USDT split that totals exactly `8,000,000₫`:

```text
bank = 5,000,000₫
USDT = 3,000,000₫
cash = 0₫
```

Upload two bank proof images and one USDT proof image. Complete upload, dispute
once, correct and resend, then confirm receipt. Verify:

- one confirmed `salary_records` row;
- one pending email outbox row with missing-configuration error isolated from payroll;
- superseded proof rows remain private;
- next-period ledger total remains `5,000,000₫`;
- no duplicate salary record or payroll.

- [ ] **Step 8: Update evidence and roadmap**

Record:

- commits, staging URL and Worker version;
- migration 022 status;
- local test counts;
- QR ID and R2 privacy evidence without object key;
- unchanged amount/cutoff and next-period amount;
- proof IDs, split and confirmed salary record;
- Cron false, email unconfigured and production unchanged.

Keep Phase 10 at `🧪` until live email and controlled Cron receive separate approval.

- [ ] **Step 9: Commit the evidence**

```bash
git add docs/ROADMAP.md docs/reports/2026-07-29-staging-personal-payroll-validation.md
git commit -m "docs: record USDT QR staging proof"
```

## Self-Review Results

- **Spec coverage:** Tasks 1–5 cover every data, R2, Telegram, admin, privacy,
  locking and backward-compatibility requirement. Task 6 covers the exact
  controlled payroll and all staging-only boundaries.
- **Type consistency:** `usdt_qr_id` is the current profile pointer;
  `usdt_qr_id_snapshot` is the payroll pointer; `qr_id` identifies the immutable
  QR row; `has_usdt_qr` is the only list exposure.
- **Failure safety:** R2-before-D1 uploads have explicit compensation; profile
  and snapshot mutations share one guarded batch; administrator photo delivery
  cannot roll back the profile.
- **Scope:** No QR recognition, chain validation, QR generation, public URL,
  email attachment, dependency, Cron, production mutation or unrelated refactor
  is included.
