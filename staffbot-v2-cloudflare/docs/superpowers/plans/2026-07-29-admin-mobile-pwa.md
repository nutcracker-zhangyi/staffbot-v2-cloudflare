# Administrator Mobile PWA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an installable, administrator-only mobile PWA at `/manage` for task-first approvals, payroll payment, immutable multi-proof evidence, employee confirmation tracking, and Telegram deep links while keeping employees in Telegram and retaining `/admin`.

**Architecture:** Add a focused `/api/manage` boundary and mobile web shell inside the existing Worker, then reuse the current D1/R2/Telegram business services instead of creating a second backend. Introduce generic leased task claims and immutable payroll payment attempts while retaining `payroll_disbursements` as the compatibility summary consumed by Telegram and `/admin`.

**Tech Stack:** Cloudflare Workers JavaScript, D1/SQLite migrations, private R2 objects, Telegram Bot API, HTML/CSS/vanilla JavaScript PWA, Node.js built-in test runner.

## Global Constraints

- The first product release is administrator-only; employees continue all existing Telegram workflows.
- Keep `/admin` available for desktop tables, CSV export, and fallback administration.
- Do not create a separate React, Vue, Pages, native iOS, or native Android project.
- Do not add runtime or development dependencies.
- Do not rewrite payroll calculation, personal cycle boundaries, the store-local noon cutoff, or the immutable payroll ledger.
- Use the existing `staffbot_admin_session` cookie and Telegram ID plus 10-minute one-time-code login.
- Add a per-session CSRF token for every `/api/manage` mutation.
- Enforce store authorization on every task, payroll, proof, and approval request.
- Keep R2 private; serve proofs only through authenticated Worker endpoints with `Cache-Control: private, no-store`.
- Use a 15-minute task lease; renew while the task page is active and expire after 15 minutes without renewal.
- Only an active store owner or global administrator may force-take over a store task.
- Use integer micros for every payroll split; bank, USDT, and cash must exactly equal `amount_snapshot_micros`.
- Require at least one proof for every non-zero payment method.
- Accept JPEG, PNG, and WebP proofs up to 10 MiB each, with at most 5 proofs per payment method.
- Draft proofs may be deleted by the current claimant; submitted proof rows and R2 objects are immutable.
- Mark abandoned drafts after claim loss or explicit abandonment; delete only unreferenced abandoned draft objects older than 7 days.
- A committed payment is not rolled back when Telegram delivery fails; record per-proof and summary delivery state and allow retry.
- Do not require, configure, or expose email in the PWA.
- Cache only the PWA shell; never cache employee, payroll, account, approval, or proof responses.
- All financial mutations require an online request and current server-side state.
- Deploy and validate only staging. Production merge and deployment require a later explicit “发布 live” instruction.

---

## Planned File Map

### Database

- `db/migrations/023_admin_manage_sessions_and_claims.sql`: CSRF session column and generic task-claim table.
- `db/migrations/024_payroll_payment_attempts.sql`: immutable payment attempts, proof-table rebuild, delivery fields, and idempotent legacy backfill.
- `db/schema.sql`: canonical schema after both migrations.

### Shared backend

- `src/admin-auth.js`: shared OTP, session, CSRF, and logout behavior for `/admin` and `/manage`.
- `src/task-claims.js`: leased claim state transitions and owner takeover authorization.
- `src/manage-read-model.js`: task-first pending lists, approval details, payroll dossier, and history queries.
- `src/manage-api.js`: `/api/manage` routing, validation, authorization, and response mapping.
- `src/payroll-payment-attempts.js`: draft/version lifecycle, immutable submission, and employee response synchronization.
- `src/payroll-proofs.js`: browser upload, draft deletion, attempt-scoped reads, and cleanup.
- `src/payroll-notifications.js`: attempt-scoped employee delivery and retry.
- `src/telegram-client.js`: multipart photo upload from private R2 bytes.
- `src/admin-notifications.js`: administrator task summaries and PWA deep-link keyboards.

### PWA

- `src/manage-page.js`: document shell and environment label.
- `src/manage-assets.js`: manifest, service worker, icon, stylesheet, and browser application responses.
- `src/manage-client.js`: login, navigation, task state, approvals, payroll dossier, payment form, uploads, and offline behavior.

### Existing integration points

- `src/admin-api.js`: consume shared auth and keep existing endpoint behavior.
- `src/router.js`: route PWA assets and API; run abandoned-draft cleanup.
- `src/telegram.js`: replace administrator action keyboards with task summaries and PWA deep links while preserving employee flows.
- `src/payroll-payments.js`: synchronize employee confirmation/dispute with the current payment attempt.
- `src/http.js`: strict PWA asset response helpers without changing `/admin` defaults.
- `src/security.js`: manage-specific security headers.
- `src/stores.js`: explicit store-owner authorization helper.
- `src/index.js`: export newly tested service interfaces.
- `wrangler.toml`, `wrangler.toml.example`: stable production and staging `MANAGE_BASE_URL` values.

### Tests and operations

- `test/admin-auth.test.js`
- `test/manage-routing.test.js`
- `test/manage-page.test.js`
- `test/task-claims.test.js`
- `test/manage-read-model.test.js`
- `test/manage-approvals.test.js`
- `test/payroll-payment-attempts.test.js`
- `test/manage-payroll-api.test.js`
- `test/manage-proof-upload.test.js`
- `test/manage-notifications.test.js`
- `test/manage-security.test.js`
- `test/manage-migrations.test.js`
- Modify existing payroll, proof, receipt, Telegram, routing, staging-config, and module-boundary tests.
- `docs/STAGING_RUNBOOK.md`: PWA deployment and real-device acceptance commands.
- `docs/reports/2026-07-29-staging-admin-mobile-pwa-validation.md`: final staging evidence.

---

### Task 1: Add CSRF Sessions and Generic Task-Claim Schema

**Files:**
- Create: `db/migrations/023_admin_manage_sessions_and_claims.sql`
- Modify: `db/schema.sql`
- Create: `test/manage-migrations.test.js`

**Interfaces:**
- Consumes: Existing `admin_sessions`, `store_members`, and `admin_audit_logs`.
- Produces: Nullable `admin_sessions.csrf_token`.
- Produces: `admin_task_claims(task_type, task_id, store_id, claimed_by, claimed_at, lease_expires_at, updated_at)`.

- [ ] **Step 1: Write failing canonical-schema and migration tests**

Create `test/manage-migrations.test.js` with checks that execute the canonical schema and migration against an old-schema fixture:

```js
test('canonical schema enforces manage CSRF and leased claims', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  const sessionColumns = db.prepare(`
    PRAGMA table_info(admin_sessions)
  `).all().map((column) => column.name);
  assert.ok(sessionColumns.includes('csrf_token'));
  db.prepare(`
    INSERT INTO admin_task_claims (
      task_type, task_id, store_id, claimed_by,
      claimed_at, lease_expires_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'payroll', 'PAYROLL-1', 'STORE-1', 'ADMIN-1',
    '2026-08-01T00:00:00.000Z',
    '2026-08-01T00:15:00.000Z',
    '2026-08-01T00:00:00.000Z'
  );
  assert.throws(() => db.prepare(`
    INSERT INTO admin_task_claims (
      task_type, task_id, store_id, claimed_by,
      claimed_at, lease_expires_at, updated_at
    ) VALUES ('unknown', 'TASK-2', 'STORE-1', 'ADMIN-1', ?, ?, ?)
  `).run(
    '2026-08-01T00:00:00.000Z',
    '2026-08-01T00:15:00.000Z',
    '2026-08-01T00:00:00.000Z'
  ));
});

test('migration preserves existing admin sessions', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE admin_sessions (
      token TEXT PRIMARY KEY,
      telegram_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO admin_sessions VALUES (
      'SESSION-1', 'ADMIN-1',
      '2099-01-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z'
    );
  `);
  db.exec(migration023);
  assert.equal(
    db.prepare(`SELECT telegram_id FROM admin_sessions`).get().telegram_id,
    'ADMIN-1'
  );
  assert.equal(
    db.prepare(`SELECT csrf_token FROM admin_sessions`).get().csrf_token,
    null
  );
});
```

- [ ] **Step 2: Run the migration test and verify RED**

Run:

```bash
node --test test/manage-migrations.test.js
```

Expected: FAIL because migration 023 and the canonical fields do not exist.

- [ ] **Step 3: Add migration 023**

Create:

```sql
ALTER TABLE admin_sessions ADD COLUMN csrf_token TEXT;

CREATE TABLE admin_task_claims (
  task_type TEXT NOT NULL
    CHECK (task_type IN (
      'income',
      'leave',
      'absence',
      'advance',
      'payroll'
    )),
  task_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  claimed_by TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_type, task_id)
);

CREATE INDEX idx_admin_task_claims_store_expiry
  ON admin_task_claims (store_id, lease_expires_at);
```

Mirror this shape with `IF NOT EXISTS` in `db/schema.sql`.

- [ ] **Step 4: Run the migration tests and full schema tests**

Run:

```bash
node --test test/manage-migrations.test.js test/payroll-settlement.test.js
```

Expected: all tests pass.

- [ ] **Step 5: Commit the schema slice**

```bash
git add \
  staffbot-v2-cloudflare/db/migrations/023_admin_manage_sessions_and_claims.sql \
  staffbot-v2-cloudflare/db/schema.sql \
  staffbot-v2-cloudflare/test/manage-migrations.test.js
git commit -m "feat: add managed task claim schema"
```

---

### Task 2: Extract Shared Admin Authentication and Serve the PWA Shell

**Files:**
- Create: `src/admin-auth.js`
- Create: `src/manage-page.js`
- Create: `src/manage-assets.js`
- Create: `src/manage-client.js`
- Modify: `src/admin-api.js`
- Modify: `src/http.js`
- Modify: `src/router.js`
- Modify: `src/security.js`
- Modify: `src/index.js`
- Create: `test/admin-auth.test.js`
- Create: `test/manage-routing.test.js`
- Modify: `test/worker-routing.test.js`
- Modify: `test/module-boundaries.test.js`

**Interfaces:**
- Produces: `startAdminLogin(request, env): Promise<Response>`.
- Produces: `verifyAdminLogin(request, env): Promise<Response>`.
- Produces: `requireAdminSession(request, env): Promise<AdminSession|null>`.
- Produces: `requireManageMutation(request, session): boolean`.
- Produces: `logoutAdminSession(env, token): Promise<void>`.
- Produces: `manageHtml(env): string`.
- Produces: `handleManageAsset(request, env, url): Response|null`.

- [ ] **Step 1: Write failing auth compatibility and route tests**

Add tests proving the same OTP creates a session with CSRF and both admin surfaces use it:

```js
test('verified login creates one reusable session with CSRF', async () => {
  const response = await verifyAdminLogin(
    requestJson('/api/admin/login/verify', {
      telegram_id: 'ADMIN-1',
      code: '123456'
    }),
    fixture.env
  );
  const session = fixture.database.prepare(`
    SELECT telegram_id, csrf_token FROM admin_sessions
  `).get();
  assert.equal(response.status, 200);
  assert.equal(session.telegram_id, 'ADMIN-1');
  assert.match(session.csrf_token, /^CSRF-/);
});

test('a legacy valid session receives CSRF without another OTP', async () => {
  const session = await requireAdminSession(legacySessionRequest, fixture.env);
  assert.match(session.csrf_token, /^CSRF-/);
  assert.equal(
    fixture.database.prepare(`
      SELECT csrf_token FROM admin_sessions
      WHERE token = 'LEGACY-SESSION'
    `).get().csrf_token,
    session.csrf_token
  );
});

test('serves the manage shell and assets without changing admin', async () => {
  for (const path of [
    '/manage',
    '/manage/app.js',
    '/manage/styles.css',
    '/manage/manifest.webmanifest',
    '/manage/sw.js',
    '/manage/icon.svg'
  ]) {
    const response = await worker.fetch(
      new Request(`https://staffbot.test${path}`),
      fixture.env,
      context()
    );
    assert.equal(response.status, 200, path);
  }
  assert.equal(
    (await worker.fetch(
      new Request('https://staffbot.test/admin'),
      fixture.env,
      context()
    )).status,
    200
  );
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --test test/admin-auth.test.js test/manage-routing.test.js
```

Expected: FAIL because the shared module and `/manage` routes do not exist.

- [ ] **Step 3: Move authentication without changing its contract**

Move `makeNumericCode`, login start, login verify, and session lookup from `admin-api.js` to `admin-auth.js`. Preserve the 10-minute OTP, five-failure lock, seven-day session, and existing response codes. Generate CSRF with:

```js
const csrfToken = makeId('CSRF');
await env.DB.prepare(`
  INSERT INTO admin_sessions (
    token, telegram_id, expires_at, created_at, csrf_token
  ) VALUES (?, ?, ?, ?, ?)
`).bind(
  token,
  telegramId,
  expiresAt,
  now.toISOString(),
  csrfToken
).run();
```

When a valid pre-migration session has `csrf_token = NULL`, atomically assign
one during `requireAdminSession` and return the updated session. This keeps an
already logged-in administrator in place without weakening manage mutations.

For manage mutations require exact equality:

```js
export function requireManageMutation(request, session) {
  if (!session || !session.csrf_token) return false;
  return request.headers.get('x-csrf-token') === session.csrf_token;
}
```

Keep `admin-api.js` login URLs and current `/api/admin` behavior by importing the shared functions.

- [ ] **Step 4: Add the minimal PWA document and asset routes**

`manage-page.js` must emit external asset links only:

```html
<link rel="manifest" href="/manage/manifest.webmanifest">
<link rel="stylesheet" href="/manage/styles.css">
<main id="app" aria-live="polite"></main>
<script src="/manage/app.js" defer></script>
```

`manage-client.js` initially renders login and authenticated placeholders with bottom navigation. `manage-assets.js` returns explicit content types and `Cache-Control: no-cache` for the service worker.

Add routes before the generic 404:

```js
if (request.method === 'GET' && url.pathname === '/manage') {
  return manageDocument(manageHtml(env));
}
if (request.method === 'GET' && url.pathname.startsWith('/manage/')) {
  const asset = handleManageAsset(request, env, url);
  if (asset) return asset;
}
```

- [ ] **Step 5: Add strict manage security headers**

Keep existing `/admin` headers byte-for-byte. Add manage-only headers with:

```text
default-src 'self';
script-src 'self';
style-src 'self';
img-src 'self' blob: data:;
connect-src 'self';
worker-src 'self';
manifest-src 'self';
frame-ancestors 'none';
base-uri 'none';
form-action 'self'
```

Set `Permissions-Policy: geolocation=(), microphone=(), camera=(self)`.

- [ ] **Step 6: Run focused and full routing tests**

Run:

```bash
node --test \
  test/admin-auth.test.js \
  test/manage-routing.test.js \
  test/worker-routing.test.js \
  test/module-boundaries.test.js
npm run check
```

Expected: all tests pass; `/admin` contract tests remain unchanged.

- [ ] **Step 7: Commit the shared-auth and shell slice**

```bash
git add \
  staffbot-v2-cloudflare/src/admin-auth.js \
  staffbot-v2-cloudflare/src/manage-page.js \
  staffbot-v2-cloudflare/src/manage-assets.js \
  staffbot-v2-cloudflare/src/manage-client.js \
  staffbot-v2-cloudflare/src/admin-api.js \
  staffbot-v2-cloudflare/src/http.js \
  staffbot-v2-cloudflare/src/router.js \
  staffbot-v2-cloudflare/src/security.js \
  staffbot-v2-cloudflare/src/index.js \
  staffbot-v2-cloudflare/test/admin-auth.test.js \
  staffbot-v2-cloudflare/test/manage-routing.test.js \
  staffbot-v2-cloudflare/test/worker-routing.test.js \
  staffbot-v2-cloudflare/test/module-boundaries.test.js
git commit -m "feat: serve authenticated admin pwa shell"
```

---

### Task 3: Implement Leased Task Claims

**Files:**
- Create: `src/task-claims.js`
- Create: `test/task-claims.test.js`
- Modify: `src/stores.js`
- Modify: `src/index.js`

**Interfaces:**
- Consumes: `TaskRef = {task_type, task_id, store_id}` and `actorId: string`.
- Produces: `claimTask(env, actorId, task, now): Promise<TaskClaim>`.
- Produces: `renewTaskClaim(env, actorId, task, now): Promise<TaskClaim>`.
- Produces: `releaseTaskClaim(env, actorId, task, now): Promise<void>`.
- Produces: `forceTakeoverTask(env, actorId, task, reason, now): Promise<TaskClaim>`.
- Produces: `requireActiveTaskClaim(env, actorId, task, now): Promise<TaskClaim>`.
- Produces: `isStoreOwner(env, telegramId, storeId): Promise<boolean>`.

- [ ] **Step 1: Write state-transition and concurrency tests**

Cover claim, same-owner renewal, blocked second owner, 15-minute expiry, release, owner takeover, rejected admin takeover, and audit:

```js
test('an expired fifteen-minute lease can be claimed by another admin', async () => {
  await claimTask(env, 'ADMIN-1', task, at('2026-07-29T00:00:00Z'));
  await assert.rejects(
    claimTask(env, 'ADMIN-2', task, at('2026-07-29T00:14:59Z')),
    /task_claimed/
  );
  const claim = await claimTask(
    env,
    'ADMIN-2',
    task,
    at('2026-07-29T00:15:00Z')
  );
  assert.equal(claim.claimed_by, 'ADMIN-2');
  assert.equal(claim.lease_expires_at, '2026-07-29T00:30:00.000Z');
});
```

- [ ] **Step 2: Run the claim tests and verify RED**

Run:

```bash
node --test test/task-claims.test.js
```

Expected: FAIL because `task-claims.js` does not exist.

- [ ] **Step 3: Implement atomic claim and renewal**

Use one conditional upsert:

```sql
INSERT INTO admin_task_claims (
  task_type, task_id, store_id, claimed_by,
  claimed_at, lease_expires_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(task_type, task_id) DO UPDATE SET
  store_id = excluded.store_id,
  claimed_by = excluded.claimed_by,
  claimed_at = CASE
    WHEN admin_task_claims.claimed_by = excluded.claimed_by
      THEN admin_task_claims.claimed_at
    ELSE excluded.claimed_at
  END,
  lease_expires_at = excluded.lease_expires_at,
  updated_at = excluded.updated_at
WHERE admin_task_claims.store_id = excluded.store_id
  AND (
    admin_task_claims.claimed_by = excluded.claimed_by
    OR admin_task_claims.lease_expires_at <= excluded.updated_at
  )
```

After the mutation, read the row and throw `task_claimed` unless the requested actor owns the unexpired lease.

- [ ] **Step 4: Implement release and audited force takeover**

Release must delete only the matching actor’s active row. Force takeover first requires `isGlobalAdmin` or `isStoreOwner`; it records the prior actor, new actor, reason, and time in `admin_audit_logs`.

- [ ] **Step 5: Run focused tests**

Run:

```bash
node --test test/task-claims.test.js test/security.test.js
```

Expected: all tests pass.

- [ ] **Step 6: Commit the claim service**

```bash
git add \
  staffbot-v2-cloudflare/src/task-claims.js \
  staffbot-v2-cloudflare/src/stores.js \
  staffbot-v2-cloudflare/src/index.js \
  staffbot-v2-cloudflare/test/task-claims.test.js
git commit -m "feat: add leased admin task claims"
```

---

### Task 4: Add the Manage API Session, Stores, Claims, and Task Read Model

**Files:**
- Create: `src/manage-api.js`
- Create: `src/manage-read-model.js`
- Create: `test/manage-read-model.test.js`
- Modify: `src/router.js`
- Modify: `src/index.js`
- Modify: `test/manage-routing.test.js`

**Interfaces:**
- Produces: `handleManageApi(request, env, url, ctx): Promise<Response>`.
- Produces: `listManageStores(env, adminId): Promise<ManageStore[]>`.
- Produces: `listManageTasks(env, adminId, filters, now): Promise<ManageTask[]>`.
- Produces: `manageTaskDetail(env, adminId, task): Promise<ManageTaskDetail|null>`.
- API: `GET /api/manage/session`.
- API: `GET /api/manage/stores`.
- API: `GET /api/manage/tasks?store_id=STORE-1&type=income`.
- API: `POST /api/manage/tasks/:type/:id/claim|renew|release|takeover`.

- [ ] **Step 1: Write failing read-model and API tests**

Seed one pending item for each first-release task type and assert urgency order and store isolation:

```js
test('lists only authorized pending tasks in urgency order', async () => {
  const tasks = await listManageTasks(
    fixture.env,
    'ADMIN-1',
    { store_id: 'STORE-1', type: '' },
    new Date('2026-07-29T12:00:00.000Z')
  );
  assert.deepEqual(
    tasks.map((item) => item.task_type),
    ['payroll', 'absence', 'leave', 'advance', 'income']
  );
  assert.ok(tasks.every((item) => item.store_id === 'STORE-1'));
  assert.ok(tasks.every((item) => 'claim' in item));
});
```

Test 401 without session, 403 for another store, 403 without CSRF, 409 for an occupied task, and 200 for claim/renew/release.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --test test/manage-read-model.test.js test/manage-routing.test.js
```

Expected: FAIL because the manage API and read model do not exist.

- [ ] **Step 3: Implement normalized task rows**

Every task row must expose this exact shape:

```js
{
  task_type: 'payroll',
  task_id: 'PAYROLL-1',
  store_id: 'STORE-1',
  store_name: 'Tokyo Club',
  employee_id: 'EMP-1',
  employee_name: 'Alice',
  amount_micros: 100_000_000,
  currency: '₫',
  business_date: '2026-07-29',
  submitted_at: '2026-07-29T03:00:00.000Z',
  status: 'awaiting_admin_payment',
  urgency: 500,
  claim: {
    claimed_by: 'ADMIN-2',
    claimed_at: '2026-07-29T03:05:00.000Z',
    lease_expires_at: '2026-07-29T03:20:00.000Z',
    active: true
  }
}
```

Urgency is deterministic: disputed payroll `600`, unpaid payroll `500`, absence `400`, leave `300`, advance `200`, income `100`; within a class sort by oldest submitted time and stable task ID.

- [ ] **Step 4: Implement authenticated API routing**

Route `/api/manage/` before `/api/admin/`. Every route first calls
`requireAdminSession`. Every non-GET request verifies
`requireManageMutation`. Decode all IDs and recheck store access before
calling claim services.

- [ ] **Step 5: Run focused tests and syntax check**

Run:

```bash
node --test \
  test/manage-read-model.test.js \
  test/manage-routing.test.js \
  test/task-claims.test.js
npm run check
```

Expected: all tests pass.

- [ ] **Step 6: Commit the manage API foundation**

```bash
git add \
  staffbot-v2-cloudflare/src/manage-api.js \
  staffbot-v2-cloudflare/src/manage-read-model.js \
  staffbot-v2-cloudflare/src/router.js \
  staffbot-v2-cloudflare/src/index.js \
  staffbot-v2-cloudflare/test/manage-read-model.test.js \
  staffbot-v2-cloudflare/test/manage-routing.test.js
git commit -m "feat: expose mobile admin task api"
```

---

### Task 5: Add Claim-Protected Approval APIs

**Files:**
- Modify: `src/manage-api.js`
- Modify: `src/manage-read-model.js`
- Modify: `src/approvals.js`
- Create: `test/manage-approvals.test.js`
- Modify: `test/approval-regression.test.js`

**Interfaces:**
- Produces: `manageApprovalDetail(env, adminId, storeId, type, id): Promise<object|null>`.
- API: `GET /api/manage/stores/:storeId/approvals/:type/:id`.
- API: `POST /api/manage/stores/:storeId/approvals/:type/:id/approve`.
- API: `POST /api/manage/stores/:storeId/approvals/:type/:id/reject` with `{reason: string}`.
- API: `POST /api/manage/stores/:storeId/approvals/:type/:id/notify/retry`.
- Consumes: `requireActiveTaskClaim`.
- Consumes: existing approval functions for `income`, `leave`, `absence`, and `advance`.

- [ ] **Step 1: Write failing approval API tests**

For each type, assert:

- authorized detail includes source facts and audit history;
- mutation without the claim returns `409 task_claim_required`;
- approval with the claim changes the existing business table exactly once;
- rejection without a non-blank reason returns `400 rejection_reason_required`;
- stale replay returns `409 already_decided`;
- Telegram failure does not undo the decision.
- failed result delivery is recorded and can be retried from the decided record.

Use one table-driven test:

```js
for (const type of ['income', 'leave', 'absence', 'advance']) {
  test(`${type} approval requires the current task claim`, async () => {
    const response = await managePost(
      `/api/manage/stores/STORE-1/approvals/${type}/${ids[type]}/approve`
    );
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'task_claim_required');
  });
}
```

- [ ] **Step 2: Run the approval tests and verify RED**

Run:

```bash
node --test test/manage-approvals.test.js
```

Expected: FAIL because manage approval routes do not exist.

- [ ] **Step 3: Add approval detail loaders**

Map each task type to its existing table and facts. Return only fields required by the mobile detail, plus:

```js
{
  task,
  request,
  employee,
  store,
  attachments: [],
  history: auditRows
}
```

Do not include unrelated employee records or raw storage keys.

- [ ] **Step 4: Add claim-protected decisions**

Call `requireActiveTaskClaim` immediately before the existing approval service. Preserve existing atomic decision rules. On success, release the task claim and send the existing employee result notification. Catch Telegram failures, call `logError`, return:

```js
{
  ok: true,
  notification: {
    status: 'failed',
    retryable: true
  }
}
```

Do not change the committed approval. Insert
`approval_notification_failed` in `admin_audit_logs` with the recipient,
decision, and safe Telegram error summary. The retry route reconstructs the
approved or rejected message from the decided business row, records
`approval_notification_retried` on success, and refuses pending or
cross-store records.

- [ ] **Step 5: Run focused and regression tests**

Run:

```bash
node --test \
  test/manage-approvals.test.js \
  test/approval-regression.test.js \
  test/admin-pagination-leave.test.js
```

Expected: all tests pass.

- [ ] **Step 6: Commit approval APIs**

```bash
git add \
  staffbot-v2-cloudflare/src/manage-api.js \
  staffbot-v2-cloudflare/src/manage-read-model.js \
  staffbot-v2-cloudflare/src/approvals.js \
  staffbot-v2-cloudflare/test/manage-approvals.test.js \
  staffbot-v2-cloudflare/test/approval-regression.test.js
git commit -m "feat: add claim-protected mobile approvals"
```

---

### Task 6: Build the Task-First Home and Approval UI

**Files:**
- Modify: `src/manage-client.js`
- Modify: `src/manage-page.js`
- Modify: `src/manage-assets.js`
- Create: `test/manage-page.test.js`
- Create: `test/helpers/manage-dom.js`

**Interfaces:**
- Consumes: session, stores, tasks, claims, approval detail, approve, and reject APIs from Tasks 2–5.
- Produces: browser functions `loadTasks()`, `openTask(type, id)`, `claimCurrentTask()`, `renewCurrentClaim()`, `releaseCurrentTask()`, and `submitApproval(decision)`.

- [ ] **Step 1: Write a failing client behavior test**

Run the actual generated client in a deterministic minimal DOM harness. Mock
only the HTTP boundary; assert the rendered and interactive result, not the
client source text:

```js
test('manage client renders task-first navigation and claims a task', async () => {
  const browser = manageDom({
    session: { telegram_id: 'ADMIN-1', csrf_token: 'CSRF-1' },
    stores: [{ store_id: 'STORE-1', name: 'Tokyo Club' }],
    tasks: [{
      task_type: 'income', task_id: 'INC-1', store_id: 'STORE-1',
      employee_name: 'Alice', status: 'pending', claim: null
    }]
  });
  await browser.run(MANAGE_APP_JS);
  assert.deepEqual(browser.navigationLabels(), [
    '待办', '审批', '工资', '更多'
  ]);
  await browser.clickButton('领取');
  assert.deepEqual(browser.lastRequest(), {
    method: 'POST',
    path: '/api/manage/tasks/income/INC-1/claim',
    csrf: 'CSRF-1'
  });
});
```

- [ ] **Step 2: Run the page test and verify RED**

Run:

```bash
node --test test/manage-page.test.js
```

Expected: FAIL because the mobile controls do not exist.

- [ ] **Step 3: Implement login and navigation state**

Use one client state object:

```js
const state = {
  session: null,
  csrfToken: '',
  stores: [],
  storeId: '',
  tasks: [],
  activeNav: 'tasks',
  currentTask: null,
  claimTimer: 0,
  online: navigator.onLine
};
```

Accept a return path only when it starts with `/manage/`; after login, open that task path. Keep all user-visible copy in Chinese for this first administrator release.

- [ ] **Step 4: Implement task cards and approval detail**

Render status, employee, store, amount/date, handler, and urgency. Disable mutation buttons when offline, unclaimed, claimed by another admin, or lease-expired. Renew every five minutes while an owned task detail remains visible.

- [ ] **Step 5: Implement approve and reject**

Approval requires one confirmation tap. Rejection opens a required reason field. On 409, refresh detail and show the current handler/result instead of replaying.

- [ ] **Step 6: Run page, API, and routing tests**

Run:

```bash
node --test \
  test/manage-page.test.js \
  test/manage-approvals.test.js \
  test/manage-routing.test.js
```

Expected: all tests pass.

- [ ] **Step 7: Commit the mobile approval UI**

```bash
git add \
  staffbot-v2-cloudflare/src/manage-client.js \
  staffbot-v2-cloudflare/src/manage-page.js \
  staffbot-v2-cloudflare/src/manage-assets.js \
  staffbot-v2-cloudflare/test/manage-page.test.js \
  staffbot-v2-cloudflare/test/helpers/manage-dom.js
git commit -m "feat: build task-first mobile approval ui"
```

---

### Task 7: Add Immutable Payroll Payment Attempt Schema and Backfill

**Files:**
- Create: `db/migrations/024_payroll_payment_attempts.sql`
- Modify: `db/schema.sql`
- Modify: `test/manage-migrations.test.js`
- Modify: `test/payroll-settlement.test.js`
- Modify: `test/payroll-proofs.test.js`

**Interfaces:**
- Produces: `payroll_payment_attempts`.
- Produces: `payroll_disbursements.current_payment_attempt_id`.
- Rebuilds: `payroll_payment_proofs` with compatibility-nullable `attempt_id`, nullable `telegram_file_id`, `telegram_delivered_at`, and attempt-scoped ordering. All new writes after feature integration require a non-null attempt.

- [ ] **Step 1: Add failing schema, migration, and backfill tests**

Assert valid statuses, unique payroll/version, immutable legacy rows, preserved proof objects, and idempotent migration:

```js
test('backfills one version for an existing evidenced payroll', () => {
  oldDb.exec(oldPayrollAndProofFixture);
  oldDb.exec(migration024);
  const attempt = oldDb.prepare(`
    SELECT version, status, bank_micros, usdt_micros
    FROM payroll_payment_attempts
    WHERE payroll_id = 'PAYROLL-1'
  `).get();
  assert.deepEqual({ ...attempt }, {
    version: 1,
    status: 'submitted',
    bank_micros: 70_000_000,
    usdt_micros: 30_000_000
  });
  assert.equal(
    oldDb.prepare(`
      SELECT attempt_id FROM payroll_payment_proofs
      WHERE proof_id = 'PROOF-1'
    `).get().attempt_id,
    'ATTEMPT:LEGACY:PAYROLL-1'
  );
});
```

- [ ] **Step 2: Run migration tests and verify RED**

Run:

```bash
node --test test/manage-migrations.test.js test/payroll-proofs.test.js
```

Expected: FAIL because migration 024 and attempt fields do not exist.

- [ ] **Step 3: Create the payment-attempt table**

Use:

```sql
CREATE TABLE payroll_payment_attempts (
  attempt_id TEXT PRIMARY KEY,
  payroll_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL CHECK (status IN (
    'draft',
    'submitted',
    'employee_confirmed',
    'employee_disputed',
    'abandoned'
  )),
  bank_micros INTEGER NOT NULL DEFAULT 0,
  usdt_micros INTEGER NOT NULL DEFAULT 0,
  cash_micros INTEGER NOT NULL DEFAULT 0,
  submitted_by TEXT,
  submitted_at TEXT,
  employee_response TEXT CHECK (
    employee_response IS NULL
    OR employee_response IN ('confirmed', 'disputed')
  ),
  idempotency_key_hash TEXT,
  employee_responded_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (payroll_id, version)
);
```

Add indexes on `(payroll_id, version)` and `(status, updated_at)`.
Add a partial unique index on `(payroll_id, idempotency_key_hash)` where the
hash is not null.

- [ ] **Step 4: Rebuild proof metadata and backfill**

The rebuilt proof table must preserve `proof_id`, `payroll_id`, method, object key, file name, MIME type, size, order, uploader, `superseded_at`, and upload time. Keep `attempt_id` nullable only so the migration can preserve compatibility during incremental staging deployment. Add:

```sql
CREATE UNIQUE INDEX idx_payroll_proofs_attempt_order
  ON payroll_payment_proofs (attempt_id, method, sort_order)
  WHERE attempt_id IS NOT NULL;

CREATE UNIQUE INDEX idx_payroll_proofs_legacy_order
  ON payroll_payment_proofs (payroll_id, method, sort_order)
  WHERE attempt_id IS NULL;
```

Backfill `ATTEMPT:LEGACY:<payroll_id>` only when a payroll has a proof, non-zero split, or a status of `awaiting_employee_confirmation`, `disputed`, or `confirmed`. Map `confirmed` to `employee_confirmed`, `disputed` to `employee_disputed`, and other evidenced rows to `submitted`. Set `current_payment_attempt_id` to that attempt.

For an old proof belonging to a payroll with `payment_sent_at`, backfill
`telegram_delivered_at = payment_sent_at`; otherwise leave it null. This
prevents a historical delivered proof from being resent after migration.

- [ ] **Step 5: Run schema and payroll regression tests**

Run:

```bash
node --test \
  test/manage-migrations.test.js \
  test/payroll-settlement.test.js \
  test/payroll-payments.test.js \
  test/payroll-proofs.test.js
```

Expected: all tests pass and existing payroll creation still creates no attempt until an administrator begins payment.

- [ ] **Step 6: Commit immutable payment storage**

```bash
git add \
  staffbot-v2-cloudflare/db/migrations/024_payroll_payment_attempts.sql \
  staffbot-v2-cloudflare/db/schema.sql \
  staffbot-v2-cloudflare/test/manage-migrations.test.js \
  staffbot-v2-cloudflare/test/payroll-settlement.test.js \
  staffbot-v2-cloudflare/test/payroll-proofs.test.js
git commit -m "feat: add immutable payroll payment attempts"
```

---

### Task 8: Implement Payment Attempt Lifecycle and Payroll Dossier API

**Files:**
- Create: `src/payroll-payment-attempts.js`
- Modify: `src/manage-read-model.js`
- Modify: `src/manage-api.js`
- Modify: `src/payroll-payments.js`
- Modify: `src/index.js`
- Create: `test/payroll-payment-attempts.test.js`
- Create: `test/manage-payroll-api.test.js`
- Modify: `test/payroll-payments.test.js`

**Interfaces:**
- Produces: `createOrResumeDraftAttempt(env, adminId, payrollId, now): Promise<PaymentAttempt>`.
- Produces: `saveAttemptSplit(env, adminId, attemptId, input, now): Promise<PaymentAttempt>`.
- Produces: `submitPaymentAttempt(env, adminId, attemptId, idempotencyKey, now): Promise<PaymentAttempt>`.
- Produces: `abandonDraftAttempt(env, adminId, attemptId, now): Promise<void>`.
- Produces: `loadPayrollDossier(env, adminId, storeId, payrollId): Promise<PayrollDossier|null>`.
- API: `GET /api/manage/stores/:storeId/payroll`.
- API: `GET /api/manage/stores/:storeId/payroll/:payrollId`.
- API: `POST /api/manage/stores/:storeId/payroll/:payrollId/attempts/draft`.
- API: `PUT /api/manage/stores/:storeId/payroll/:payrollId/attempts/:attemptId/split`.

- [ ] **Step 1: Write lifecycle and dossier tests**

Cover one draft per payroll, next version after dispute, exact integer split, rejected payment method, claim requirement, and complete history:

```js
test('a disputed payroll creates version two without changing version one', async () => {
  const draft = await createOrResumeDraftAttempt(
    env,
    'ADMIN-1',
    'PAYROLL-1',
    at('2026-07-29T04:00:00Z')
  );
  assert.equal(draft.version, 2);
  assert.equal(
    database.prepare(`
      SELECT status FROM payroll_payment_attempts
      WHERE payroll_id = 'PAYROLL-1' AND version = 1
    `).get().status,
    'employee_disputed'
  );
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --test \
  test/payroll-payment-attempts.test.js \
  test/manage-payroll-api.test.js
```

Expected: FAIL because the lifecycle module and endpoints do not exist.

- [ ] **Step 3: Implement draft creation and split validation**

Require payroll status `awaiting_admin_payment` or `disputed`, active payroll claim, and store permission. Reuse `validatePaymentSplit` against the payroll snapshot. Allocate the next version with `MAX(version) + 1` inside a conditional batch and return an existing editable draft only when owned by the current claimant.

- [ ] **Step 4: Integrate the existing split compatibility path**

Update `savePaymentSplit` so the existing `/admin` and not-yet-retired
Telegram path also creates or resumes the payroll's current draft attempt and
writes the same integer split to the attempt and
`payroll_disbursements` in one batch. If a payroll has pre-feature
split/proof evidence but no current attempt, adopt it as version 1 and attach
its null-attempt proof rows before allowing another version. New proof writes
after this point must have a non-null `attempt_id`. The PWA entry point
requires the active claim; the temporary compatibility wrapper keeps its
existing store-admin authorization until Task 13 retires its Telegram action
buttons.

- [ ] **Step 5: Implement the dossier read model**

Return:

```js
{
  payroll: {
    payroll_id,
    store_id,
    employee_id,
    employee_name,
    period_start,
    cutoff_at,
    amount_snapshot_micros,
    currency,
    status,
    payment_profile,
    claim
  },
  attempts: [{
    attempt_id,
    version,
    status,
    bank_micros,
    usdt_micros,
    cash_micros,
    submitted_by,
    submitted_at,
    employee_response,
    employee_responded_at,
    proofs: [{
      proof_id,
      method,
      mime_type,
      size_bytes,
      uploaded_by,
      uploaded_at,
      url
    }]
  }],
  history: []
}
```

Mask bank and USDT text as current `/admin` does. Expose the authorized USDT QR endpoint, never the R2 key.

- [ ] **Step 6: Implement list, dossier, draft, and split routes**

Every write requires CSRF and the active payroll claim. Map invalid split to 400, missing resource to 404, claim conflict to 409, and authorization failure to 403.

- [ ] **Step 7: Run focused tests**

Run:

```bash
node --test \
  test/payroll-payment-attempts.test.js \
  test/manage-payroll-api.test.js \
  test/admin-payroll.test.js \
  test/payroll-payments.test.js
```

Expected: all tests pass and existing `/admin` payroll detail remains compatible.

- [ ] **Step 8: Commit attempt lifecycle and dossier**

```bash
git add \
  staffbot-v2-cloudflare/src/payroll-payment-attempts.js \
  staffbot-v2-cloudflare/src/manage-read-model.js \
  staffbot-v2-cloudflare/src/manage-api.js \
  staffbot-v2-cloudflare/src/payroll-payments.js \
  staffbot-v2-cloudflare/src/index.js \
  staffbot-v2-cloudflare/test/payroll-payment-attempts.test.js \
  staffbot-v2-cloudflare/test/manage-payroll-api.test.js \
  staffbot-v2-cloudflare/test/payroll-payments.test.js
git commit -m "feat: add mobile payroll dossier and drafts"
```

---

### Task 9: Add Browser Proof Upload, Draft Deletion, and Private Reads

**Files:**
- Modify: `src/payroll-proofs.js`
- Modify: `src/manage-api.js`
- Modify: `src/manage-read-model.js`
- Create: `test/manage-proof-upload.test.js`
- Modify: `test/payroll-proofs.test.js`
- Modify: `test/admin-payroll.test.js`

**Interfaces:**
- Produces: `storeBrowserDraftProof(env, adminId, attemptId, method, file, now): Promise<ProofRow>`.
- Produces: `deleteBrowserDraftProof(env, adminId, proofId, now): Promise<void>`.
- Produces: `cleanupAbandonedDraftProofs(env, now): Promise<{deleted:number, failed:number}>`.
- API: `POST /api/manage/stores/:storeId/payroll/:payrollId/attempts/:attemptId/proofs`.
- API: `DELETE /api/manage/stores/:storeId/payroll/:payrollId/attempts/:attemptId/proofs/:proofId`.
- API: `GET /api/manage/stores/:storeId/payroll/proofs/:proofId`.

- [ ] **Step 1: Write failing upload, delete, and authorization tests**

Use `File` and `FormData` in Node:

```js
const form = new FormData();
form.set('method', 'bank');
form.set(
  'proof',
  new File(
    [new Uint8Array([0xff, 0xd8, 0xff, 0xd9])],
    'receipt.jpg',
    { type: 'image/jpeg' }
  )
);
```

Assert object-before-metadata ordering, rollback deletion after D1 failure, 10 MiB limit, 5-per-method limit, current-claimant requirement, draft-only deletion, submitted-proof immutability, private cache headers, and cross-store denial.

- [ ] **Step 2: Run proof tests and verify RED**

Run:

```bash
node --test test/manage-proof-upload.test.js
```

Expected: FAIL because browser proof functions and routes do not exist.

- [ ] **Step 3: Implement file validation and private object storage**

Validate MIME and signature for JPEG, PNG, and WebP. Generate keys that include store, payroll, attempt, method, and proof ID:

```text
payroll/<store>/<payroll>/<attempt>/<method>/<proof>.<ext>
```

Use R2 conditional put. Insert metadata with `telegram_file_id = NULL` and `telegram_delivered_at = NULL`. If metadata insertion fails, delete only the newly created object.

Update `storeTelegramProof` to attach the payroll's
`current_payment_attempt_id`; reject a new Telegram proof when the current
split has no draft attempt. This keeps the compatibility path versioned until
its administrator buttons are retired in Task 13.

- [ ] **Step 4: Implement draft-only deletion**

Require active claim ownership and attempt status `draft`. Delete the D1 proof row conditionally, then delete its R2 object. If R2 deletion fails after the row changes, audit and log the orphan key for cleanup; never restore a stale editable proof row.

- [ ] **Step 5: Update private reads**

Join through `attempt_id` and payroll, verify actor store scope, and return `private, no-store`. Preserve employee access to proofs belonging to their payroll and existing `/admin` proof URLs.

- [ ] **Step 6: Run proof regression tests**

Run:

```bash
node --test \
  test/manage-proof-upload.test.js \
  test/payroll-proofs.test.js \
  test/admin-payroll.test.js
```

Expected: all tests pass.

- [ ] **Step 7: Commit browser proof handling**

```bash
git add \
  staffbot-v2-cloudflare/src/payroll-proofs.js \
  staffbot-v2-cloudflare/src/manage-api.js \
  staffbot-v2-cloudflare/src/manage-read-model.js \
  staffbot-v2-cloudflare/test/manage-proof-upload.test.js \
  staffbot-v2-cloudflare/test/payroll-proofs.test.js \
  staffbot-v2-cloudflare/test/admin-payroll.test.js
git commit -m "feat: add private mobile payroll proof uploads"
```

---

### Task 10: Build the Payroll Dossier and Single-Page Payment UI

**Files:**
- Modify: `src/manage-client.js`
- Modify: `src/manage-assets.js`
- Modify: `test/manage-page.test.js`
- Modify: `test/manage-payroll-api.test.js`

**Interfaces:**
- Consumes: payroll list, dossier, claim, draft, split, proof upload/delete, and private proof APIs.
- Produces: browser functions `openPayroll()`, `startPayrollPayment()`, `savePaymentDraft()`, `uploadProof()`, `deleteDraftProof()`, and `submitPayrollPayment()`.

- [ ] **Step 1: Add a failing payroll UI behavior test**

Reuse the minimal DOM harness with a mocked dossier. Exercise the real client
and assert values and enabled actions from rendered state:

```js
test('payroll payment enables submit only for an exact evidenced split', async () => {
  const browser = manageDom({ payroll: payrollDossier });
  await browser.run(MANAGE_APP_JS);
  await browser.openPayroll('PAYROLL-1');
  browser.enterAmount('bank', '70');
  browser.enterAmount('usdt', '30');
  assert.equal(browser.text('差额'), '0');
  assert.equal(browser.button('提交付款并通知员工').disabled, true);
  await browser.upload('bank', jpegProof);
  await browser.upload('usdt', pngProof);
  assert.equal(browser.button('提交付款并通知员工').disabled, false);
  assert.equal(browser.paymentHistory().length, 1);
});
```

- [ ] **Step 2: Run the page test and verify RED**

Run:

```bash
node --test test/manage-page.test.js
```

Expected: FAIL because payroll dossier/payment controls do not exist.

- [ ] **Step 3: Implement dossier-first navigation**

Opening a payroll shows facts and every attempt before any edit controls. “领取并开始付款” claims the task, creates/resumes a draft, then opens the single payment page.

- [ ] **Step 4: Implement integer-micros split input**

Display localized currency values, but convert fields to micros before sending. Show `已分配 / 工资总额 / 差额` and keep final submit disabled until the difference is zero and each non-zero method has a proof.

- [ ] **Step 5: Implement multi-image upload**

Provide separate camera and photo-library inputs so mobile browsers do not
force one source:

```html
<input
  type="file"
  accept="image/jpeg,image/png,image/webp"
  capture="environment"
>
<input
  type="file"
  accept="image/jpeg,image/png,image/webp"
  multiple
>
```

Upload each image independently, show per-file progress/error, and retry only the failed image. Draft delete requires confirmation; submitted history has no delete control.

- [ ] **Step 6: Run UI and API tests**

Run:

```bash
node --test \
  test/manage-page.test.js \
  test/manage-payroll-api.test.js \
  test/manage-proof-upload.test.js
```

Expected: all tests pass.

- [ ] **Step 7: Commit the mobile payroll UI**

```bash
git add \
  staffbot-v2-cloudflare/src/manage-client.js \
  staffbot-v2-cloudflare/src/manage-assets.js \
  staffbot-v2-cloudflare/test/manage-page.test.js \
  staffbot-v2-cloudflare/test/manage-payroll-api.test.js
git commit -m "feat: build mobile payroll payment dossier"
```

---

### Task 11: Submit Payment Atomically and Deliver R2 Proofs to Telegram

**Files:**
- Modify: `src/payroll-payment-attempts.js`
- Modify: `src/payroll-notifications.js`
- Modify: `src/telegram-client.js`
- Modify: `src/manage-api.js`
- Create: `test/manage-notifications.test.js`
- Modify: `test/payroll-payment-attempts.test.js`
- Modify: `test/payroll-proofs.test.js`
- Modify: `test/telegram-flow.test.js`

**Interfaces:**
- Produces: `sendPhotoBytes(env, chatId, bytes, filename, mimeType, caption): Promise<TelegramResult>`.
- Produces: `deliverPaymentAttempt(env, adminId, attemptId, now): Promise<DeliveryResult>`.
- API: `POST /api/manage/stores/:storeId/payroll/:payrollId/attempts/:attemptId/submit` with `Idempotency-Key`.
- API: `POST /api/manage/stores/:storeId/payroll/:payrollId/attempts/:attemptId/notify/retry`.

- [ ] **Step 1: Write failing submission and delivery tests**

Cover exact split, missing proof, lost claim, same idempotency key, already submitted retry, R2-to-Telegram multipart upload, stored `file_id`, per-proof delivery time, summary failure, and payment persistence:

```js
test('Telegram failure does not roll back submitted payment evidence', async () => {
  telegram.failSummary = true;
  const response = await submitAttempt();
  assert.equal(response.status, 200);
  const row = database.prepare(`
    SELECT status FROM payroll_payment_attempts
    WHERE attempt_id = 'ATTEMPT-1'
  `).get();
  assert.equal(row.status, 'submitted');
  assert.equal(
    database.prepare(`
      SELECT status FROM payroll_disbursements
      WHERE payroll_id = 'PAYROLL-1'
    `).get().status,
    'awaiting_employee_confirmation'
  );
  assert.equal((await response.json()).notification.status, 'failed');
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --test \
  test/manage-notifications.test.js \
  test/payroll-payment-attempts.test.js
```

Expected: FAIL because submission and R2-byte delivery are not implemented.

- [ ] **Step 3: Implement idempotent final D1 submission**

Validate active claim, draft status, exact split, accepted methods, and required proofs. In one D1 batch:

- update attempt `draft -> submitted`;
- copy split and `current_payment_attempt_id` into `payroll_disbursements`;
- update payroll to `awaiting_employee_confirmation`;
- insert audit containing version and proof IDs;
- release the task claim.

Store a SHA-256 hash of the client `Idempotency-Key` in
`payroll_payment_attempts.idempotency_key_hash` and audit details. Return the
existing submitted attempt for an identical replay. A different key against
a submitted attempt returns 409.

- [ ] **Step 4: Add multipart Telegram photo upload**

`sendPhotoBytes` must use `FormData`, not expose `BOT_TOKEN`, and return the Bot API JSON:

```js
const form = new FormData();
form.set('chat_id', String(chatId));
form.set('caption', caption);
form.set(
  'photo',
  new File([bytes], filename, { type: mimeType })
);
```

Apply the staging recipient allowlist before any network request.

- [ ] **Step 5: Deliver and checkpoint each proof**

For each undelivered proof in the submitted attempt:

- use existing `telegram_file_id` when present;
- otherwise read the private R2 object and upload its bytes;
- extract the largest returned Telegram photo `file_id`;
- set `telegram_file_id` and `telegram_delivered_at` only after Telegram success.

After all proofs, send the traceable payment summary and confirmation/problem keyboard. Set `payment_sent_at` only after the summary succeeds. Retry reads only proofs without `telegram_delivered_at`; already delivered images are not resent.

- [ ] **Step 6: Return committed state even when delivery fails**

The submit endpoint catches delivery errors, stores a safe error summary in `employee_notification_error`, and returns HTTP 200 with:

```js
{
  ok: true,
  attempt,
  notification: {
    status: 'failed',
    retryable: true
  }
}
```

The explicit retry endpoint requires store permission and returns 409 if the attempt is no longer current.

- [ ] **Step 7: Run focused and Telegram regression tests**

Run:

```bash
node --test \
  test/manage-notifications.test.js \
  test/payroll-payment-attempts.test.js \
  test/payroll-proofs.test.js \
  test/telegram-flow.test.js
```

Expected: all tests pass.

- [ ] **Step 8: Commit atomic submission and delivery**

```bash
git add \
  staffbot-v2-cloudflare/src/payroll-payment-attempts.js \
  staffbot-v2-cloudflare/src/payroll-notifications.js \
  staffbot-v2-cloudflare/src/telegram-client.js \
  staffbot-v2-cloudflare/src/manage-api.js \
  staffbot-v2-cloudflare/test/manage-notifications.test.js \
  staffbot-v2-cloudflare/test/payroll-payment-attempts.test.js \
  staffbot-v2-cloudflare/test/payroll-proofs.test.js \
  staffbot-v2-cloudflare/test/telegram-flow.test.js
git commit -m "feat: submit mobile payroll with retryable evidence delivery"
```

---

### Task 12: Synchronize Employee Confirmation and Dispute with Payment Versions

**Files:**
- Modify: `src/payroll-payments.js`
- Modify: `src/payroll-payment-attempts.js`
- Modify: `src/payroll-notifications.js`
- Modify: `src/manage-read-model.js`
- Modify: `test/payroll-payments.test.js`
- Modify: `test/payroll-receipt.test.js`
- Modify: `test/payroll-payment-attempts.test.js`
- Modify: `test/telegram-flow.test.js`

**Interfaces:**
- Produces: `recordAttemptEmployeeResponse(env, employeeId, payrollId, response, now): Promise<PaymentAttempt>`.
- Consumes: current Telegram callback functions `confirmPayrollReceipt` and `disputePayrollPayment`.

- [ ] **Step 1: Write failing version-response tests**

Assert:

- employee confirmation marks the current attempt `employee_confirmed`;
- employee dispute marks it `employee_disputed`;
- version 1 values and proofs do not change;
- a dispute creates no version 2 until an administrator starts payment;
- later confirmation makes version 2 current while version 1 remains visible;
- replayed employee callbacks change nothing.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --test \
  test/payroll-payments.test.js \
  test/payroll-payment-attempts.test.js \
  test/telegram-flow.test.js
```

Expected: FAIL because employee responses do not update payment attempts.

- [ ] **Step 3: Add employee-response statements to existing batches**

Do not add a second non-atomic transaction. Extend the current confirmation and dispute D1 batches with a conditional update against `payroll_disbursements.current_payment_attempt_id` and current attempt status `submitted`.

Confirmation sets:

```text
status = employee_confirmed
employee_response = confirmed
employee_responded_at = confirmedAt
```

Dispute sets:

```text
status = employee_disputed
employee_response = disputed
employee_responded_at = disputedAt
```

Keep existing salary-record compatibility behavior. Do not require email configuration.

- [ ] **Step 4: Update receipt and dossier history**

The employee receipt continues to show employee, store, period, total, split, confirmation time, and payroll ID; add the payment version. The manage dossier shows every attempt and highlights the latest confirmed version.

- [ ] **Step 5: Run payroll and Telegram regression tests**

Run:

```bash
node --test \
  test/payroll-payments.test.js \
  test/payroll-receipt.test.js \
  test/payroll-payment-attempts.test.js \
  test/telegram-flow.test.js
```

Expected: all tests pass.

- [ ] **Step 6: Commit employee response versioning**

```bash
git add \
  staffbot-v2-cloudflare/src/payroll-payments.js \
  staffbot-v2-cloudflare/src/payroll-payment-attempts.js \
  staffbot-v2-cloudflare/src/payroll-notifications.js \
  staffbot-v2-cloudflare/src/manage-read-model.js \
  staffbot-v2-cloudflare/test/payroll-payments.test.js \
  staffbot-v2-cloudflare/test/payroll-receipt.test.js \
  staffbot-v2-cloudflare/test/payroll-payment-attempts.test.js \
  staffbot-v2-cloudflare/test/telegram-flow.test.js
git commit -m "feat: preserve payroll dispute and confirmation versions"
```

---

### Task 13: Add Administrator Telegram Deep Links and Draft Cleanup

**Files:**
- Create: `src/admin-notifications.js`
- Modify: `src/telegram.js`
- Modify: `src/router.js`
- Modify: `src/payroll-proofs.js`
- Modify: `src/security.js`
- Modify: `wrangler.toml`
- Modify: `wrangler.toml.example`
- Create: `test/manage-security.test.js`
- Modify: `test/telegram-flow.test.js`
- Modify: `test/security.test.js`
- Modify: `test/staging-config.test.js`
- Modify: `test/worker-routing.test.js`

**Interfaces:**
- Produces: `manageTaskUrl(env, task): string`.
- Produces: `manageTaskKeyboard(env, task): TelegramInlineKeyboard`.
- Produces: `notifyStoreAdminsOfTask(env, storeId, task, text): Promise<DeliverySummary>`.
- Consumes: `cleanupAbandonedDraftProofs`.

- [ ] **Step 1: Write failing deep-link, environment, and cleanup tests**

Assert:

```js
assert.equal(
  manageTaskUrl(env, {
    task_type: 'payroll',
    task_id: 'PAYROLL-1',
    store_id: 'STORE-1'
  }),
  'https://staffbot-v2-staging.staffbot-v2.workers.dev/manage/tasks/payroll/PAYROLL-1?store=STORE-1'
);
```

Also assert encoded IDs, no open redirect input, a “去处理” URL button for every new admin task, no removal of employee keyboards, seven-day draft cleanup, no submitted object deletion, and scheduled cleanup disabled in staging with current configuration.

- [ ] **Step 2: Run security and flow tests and verify RED**

Run:

```bash
node --test \
  test/manage-security.test.js \
  test/telegram-flow.test.js \
  test/staging-config.test.js
```

Expected: FAIL because deep-link helpers and configuration do not exist.

- [ ] **Step 3: Configure stable base URLs**

Set:

```toml
[vars]
MANAGE_BASE_URL = "https://staffbot-v2.staffbot-v2.workers.dev"

[env.staging.vars]
MANAGE_BASE_URL = "https://staffbot-v2-staging.staffbot-v2.workers.dev"
```

Keep all current staging safety variables and no-Cron override unchanged.

- [ ] **Step 4: Add task notification helpers**

Validate `MANAGE_BASE_URL` as HTTPS and construct paths only from server-owned task fields. Replace administrator inline approval/correction buttons for first-release task types with a concise summary and one URL button:

```js
{
  inline_keyboard: [[{
    text: '去处理',
    url: manageTaskUrl(env, task)
  }]]
}
```

Do not alter employee menus, payroll confirmation, or dispute buttons. For a
stale administrator callback from an older Telegram message, answer with a
short “请在管理程序中处理” alert and a fresh deep link; do not execute the old
approval, split, or proof mutation.

- [ ] **Step 5: Add abandoned-draft cleanup to scheduled work**

Call cleanup after payroll settlement and before delivery jobs. Select attempts with status `abandoned` and `updated_at <= now - 7 days`; delete only proof rows still pointing to those attempts, then delete their R2 keys and audit each outcome.

- [ ] **Step 6: Run security, scheduling, and Telegram tests**

Run:

```bash
node --test \
  test/manage-security.test.js \
  test/telegram-flow.test.js \
  test/security.test.js \
  test/staging-config.test.js \
  test/worker-routing.test.js
```

Expected: all tests pass.

- [ ] **Step 7: Commit deep links and cleanup**

```bash
git add \
  staffbot-v2-cloudflare/src/admin-notifications.js \
  staffbot-v2-cloudflare/src/telegram.js \
  staffbot-v2-cloudflare/src/router.js \
  staffbot-v2-cloudflare/src/payroll-proofs.js \
  staffbot-v2-cloudflare/src/security.js \
  staffbot-v2-cloudflare/wrangler.toml \
  staffbot-v2-cloudflare/wrangler.toml.example \
  staffbot-v2-cloudflare/test/manage-security.test.js \
  staffbot-v2-cloudflare/test/telegram-flow.test.js \
  staffbot-v2-cloudflare/test/security.test.js \
  staffbot-v2-cloudflare/test/staging-config.test.js \
  staffbot-v2-cloudflare/test/worker-routing.test.js
git commit -m "feat: link admin notifications to mobile tasks"
```

---

### Task 14: Finish Installability, Offline Safety, Full Regression, and Staging Acceptance

**Files:**
- Modify: `src/manage-assets.js`
- Modify: `src/manage-client.js`
- Modify: `src/manage-page.js`
- Modify: `test/manage-page.test.js`
- Modify: `test/manage-security.test.js`
- Modify: `docs/STAGING_RUNBOOK.md`
- Create: `docs/reports/2026-07-29-staging-admin-mobile-pwa-validation.md`

**Interfaces:**
- Consumes: all prior APIs and UI.
- Produces: installable manifest, app-shell-only service worker, online/offline mutation guards, and final staging evidence.

- [ ] **Step 1: Add failing installability and cache-safety behavior tests**

Fetch and parse the manifest response. Execute the service-worker asset in a
fake worker global, trigger `install` and `fetch`, and assert calls made to the
cache and network boundaries. The install event must cache exactly:

```js
[
  '/manage',
  '/manage/app.js',
  '/manage/styles.css',
  '/manage/manifest.webmanifest',
  '/manage/icon.svg'
]
```

and explicitly bypasses `/api/`, proof URLs, and non-GET requests.

- [ ] **Step 2: Run page and security tests and verify RED**

Run:

```bash
node --test test/manage-page.test.js test/manage-security.test.js
```

Expected: FAIL until the final manifest, service worker, and offline guards are complete.

- [ ] **Step 3: Complete PWA install and offline behavior**

Register `/manage/sw.js` from the client. Use cache-first only for the fixed shell list. Use network-only for `/api/`. On `offline`, show a persistent banner and disable login verification, claim, renew, release, approve, reject, upload, delete, submit, takeover, and notification retry. On `online`, reload session and current task state before enabling actions.

- [ ] **Step 4: Run the complete local verification gate**

Run:

```bash
npm run check
npm test
git diff --check
```

Expected: syntax passes, all tests pass, and there are no whitespace errors.

- [ ] **Step 5: Apply and verify staging migrations**

Run:

```bash
npx wrangler d1 migrations list staffbot_v2_staging --env staging --remote
npx wrangler d1 migrations apply staffbot_v2_staging --env staging --remote
npx wrangler d1 execute staffbot_v2_staging --env staging --remote --command \
  "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('admin_task_claims','payroll_payment_attempts') ORDER BY name"
```

Expected: migrations 023 and 024 are applied and both tables are returned.

- [ ] **Step 6: Deploy staging only and smoke test**

Run:

```bash
npx wrangler deploy --env staging
curl -fsS https://staffbot-v2-staging.staffbot-v2.workers.dev/
curl -fsS https://staffbot-v2-staging.staffbot-v2.workers.dev/manage | \
  rg '/manage/app.js|manifest.webmanifest'
curl -fsS \
  https://staffbot-v2-staging.staffbot-v2.workers.dev/manage/manifest.webmanifest
curl -fsS \
  https://staffbot-v2-staging.staffbot-v2.workers.dev/admin | \
  rg 'STAGING 测试环境'
```

Expected: health identifies staging, `/manage` and manifest are available, and `/admin` is unchanged.

- [ ] **Step 7: Complete real-device and business-flow acceptance**

On iPhone Safari and Android Chrome, record pass/fail evidence for:

1. OTP login and add-to-home-screen.
2. Telegram deep link returning to the original task after login.
3. Store switching and task urgency order.
4. Income/fine, leave/absence, and advance approval.
5. Two-admin claim conflict, lease expiry, release, and owner takeover.
6. Bank plus USDT split equal to the fixed payroll.
7. Camera and library upload, multiple images, single-image retry, and draft delete.
8. Submit, employee confirmation, traceable receipt, and immutable history.
9. Employee dispute, version 2 payment, final confirmation, and preserved version 1.
10. Telegram failure, committed payment, retry, and no resend of delivered proofs.
11. Offline banner and disabled financial actions.
12. Cross-store and unauthenticated proof denial.

- [ ] **Step 8: Write the staging validation report**

Record:

- commit hash and deployed staging version;
- migration list and backfill reconciliation counts;
- local test total;
- device/browser versions;
- each acceptance result;
- Telegram delivery failure/retry evidence;
- proof-history screenshots or IDs without exposing private content;
- known limitations;
- explicit statement that production was not deployed.

- [ ] **Step 9: Commit acceptance documentation**

```bash
git add \
  staffbot-v2-cloudflare/src/manage-assets.js \
  staffbot-v2-cloudflare/src/manage-client.js \
  staffbot-v2-cloudflare/src/manage-page.js \
  staffbot-v2-cloudflare/test/manage-page.test.js \
  staffbot-v2-cloudflare/test/manage-security.test.js \
  staffbot-v2-cloudflare/docs/STAGING_RUNBOOK.md \
  staffbot-v2-cloudflare/docs/reports/2026-07-29-staging-admin-mobile-pwa-validation.md
git commit -m "docs: validate admin mobile pwa on staging"
```

- [ ] **Step 10: Stop at the production gate**

Report staging results to the user. Do not run a production migration, production deploy, merge to `main`, or change the production Telegram webhook. Wait for an explicit “发布 live” instruction.
