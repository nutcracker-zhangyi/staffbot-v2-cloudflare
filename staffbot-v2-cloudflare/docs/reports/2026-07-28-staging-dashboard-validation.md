# Staging Dashboard validation evidence

Date: 2026-07-28
Outcome: **follow-up live empty-chart failure recorded; second local fix awaits live retest**

## Scope and safety boundary

- Code under test: `3906a00ec53c84b3ffd796578d68663bf4731ff8`
  (`fix: preserve production mobile admin styles`).
- Staging Worker version:
  `342799f0-73f3-4408-a8ca-936e4625c7a2`.
- The only deployment command was
  `npx wrangler deploy --env staging`.
- No production deploy, migration, flag change, merge, push, or pull request
  occurred.
- Every Wrangler D1 command in this validation used `--env staging --remote`.
  The only write was the explicitly authorized, deterministic, idempotent QA
  insert into staging `payroll_entries`; all later reconciliation commands were
  read-only and reported zero changes and zero rows written.
- Secret names were listed, but secret values were never read or printed.
- Browser inspection did not read cookies, local storage, session storage, or
  authentication tokens.

Phase 9 is `🧪`: verified in staging, not approved or deployed for production.

## Post-validation correction: empty chart rendering

The earlier live-browser observation established that the `$` currency region
contained the localized `该筛选范围没有数据` text. It did **not** establish that
all three empty charts suppressed their SVG output. In particular, the API
retains active employees and returns the fixed seven zero-valued composition
entries when the selected period has no financial rows, so the composition and
employee chart helpers still rendered misleading zero-value SVGs.

A generated-client regression executed the real chart helpers with
`months: []`, seven zero-valued composition entries, and a non-empty active
employee list. The initial focused run failed with 14 passed and 1 failed
because the composition helper returned an SVG. After the minimal UI fix, all
three helpers return the localized no-data state and none returns an SVG.

Automated evidence after the fix:

| Command | Result |
| --- | --- |
| `node --test test/worker-routing.test.js` | 15 passed, 0 failed |
| `npm test` | 223 passed, 0 failed, 0 skipped |
| `npm run test:staging` | 6 passed, 0 failed, 0 skipped |
| `npm run check` | passed |

At that point, this correction had not been deployed or retested in the live
staging browser. The later live retest and the payload gap it exposed are
recorded below. No production content or production deployment was changed.

## Follow-up live failure and second local correction

The first empty-chart fix was deployed to staging Worker version
`9d5a75a1-a78a-42c9-bf59-37ff4a952e42` and retested for
`2027-01-01..2027-01-31`. The Dashboard had active employees and zero amounts.
The monthly trend showed the localized no-data state, but the composition and
employee sections still rendered zero-value SVGs. This live result disproved
the first fix's assumption that no financial rows always meant `months: []`;
an all-zero month bucket can still be present.

The generated-client regression was updated to the API-realistic shape:

- one `2027-01` month containing zero for all ten money fields;
- the fixed seven zero-valued composition entries;
- a non-empty active employee list whose money fields are all zero.

RED returned 14 passed and 1 failed; the current generated monthly helper
returned an all-zero SVG for that payload. The second minimal fix adds one
shared client predicate that treats the group as financially populated only
when any of the ten month money fields is nonzero. All three chart helpers now
use that predicate.

Automated evidence after the second fix:

| Command | Result |
| --- | --- |
| `node --test test/worker-routing.test.js` | 15 passed, 0 failed |
| `npm test` | 223 passed, 0 failed, 0 skipped |
| `npm run test:staging` | 6 passed, 0 failed, 0 skipped |
| `npm run check` | passed |

The second fix has **not** been deployed and has **not** received a live-browser
retest. The table above is local automated evidence, not a claim of live
acceptance.

## Original deployed release gate (before the local empty-chart fix)

The 222-test count below belongs to the code version deployed to staging. The
post-validation local fix and its 223-test gate are recorded in the preceding
section.

| Command | Result |
| --- | --- |
| `npm run check` | passed |
| `npm test` | 222 passed, 0 failed, 0 skipped |
| `npm run test:staging` | 6 passed, 0 failed, 0 skipped |
| `git diff --check` | passed |
| `git status --short` | only the intended evidence documents changed before the final commit |

## Cloudflare staging preflight

- Wrangler version: `4.100.0`.
- `wrangler whoami`: authenticated successfully. Account email and account ID
  are intentionally omitted.
- `npx wrangler d1 migrations list DB --env staging --remote`:
  `No migrations to apply`.
- `npx wrangler secret list --env staging` returned these names only:
  `ADMIN_IDS`, `BOT_TOKEN`, `STAGING_ALLOWED_TELEGRAM_IDS`, and
  `WEBHOOK_SECRET`.
- `wrangler.toml` retained the required named-environment settings:
  `ENVIRONMENT=staging`, `PAYROLL_LEDGER_READ_MODE=ledger`,
  `PAYROLL_LEDGER_WRITE_MODE=dual`,
  `SCHEDULED_TASKS_ENABLED=false`, recipient mode `allowlist`, and no staging
  Cron triggers.

## Currency-history preflight

The required read-only `admin_audit_logs` query returned five rows across three
stores. Each store had exactly one observed historical currency:

| Store | Historical currency values | Current currency |
| --- | --- | --- |
| `001` | `$` | `$` |
| `DEFAULT` | `₫` | `₫` |
| `STORE_…8219` | `₫` | `₫` |

No store had multiple historical currencies, so this preflight did not block
deployment.

Known limitation: legacy gross-sales and salary-payment rows do not store their
own currency. Dashboard attribution therefore uses the current store currency.
A future store-currency change would make historical attribution ambiguous.

## Deployment and public smoke checks

- Staging deploy completed at
  `https://staffbot-v2-staging.staffbot-v2.workers.dev`.
- Staging `GET /` returned
  `{"ok":true,"service":"staffbot-v2","environment":"staging","admin":"/admin"}`.
- Staging `GET /admin` contained `STAGING 测试环境`,
  `data-tab="dashboard"`, `id="tab-dashboard"`, and all three Dashboard chart
  markers.
- Production `GET /` returned
  `{"ok":true,"service":"staffbot-v2","admin":"/admin"}`.

## Financial reconciliation

The authenticated staging UI defaulted to Dashboard and selected the
`DEFAULT` store for 2026-07-01 through 2026-07-31. That store uses
`Asia/Ho_Chi_Minh`, so the exact left-closed/right-open UTC range was:

```text
[2026-06-30T17:00:00.000Z, 2026-07-31T17:00:00.000Z)
```

Independent read-only SQL and the visible Dashboard agreed exactly:

| Metric | SQL micros | Visible amount |
| --- | ---: | ---: |
| Approved gross sales (`income_records.type='income'`) | 2,274,000,000,000,000 | ₫2,274,000,000 |
| Ledger income | 1,364,400,000,000,000 | ₫1,364,400,000 |
| Ledger fine | -16,100,000,000,000 | ₫-16,100,000 |
| Ledger advance | -38,900,000,000,000 | ₫-38,900,000 |
| Ledger bonus | 1,000 | ₫0.001 |
| Ledger adjustment | 1,000,000 | ₫1 |
| Ledger reversal | -1,000,000 | ₫-1 |
| Ledger net | 1,309,400,000,001,000 | ₫1,309,400,000.001 |
| Row-rounded salary payments | 22,800,003,700,000 | ₫22,800,003.7 |

The payment query used `SUM(ROUND(amount * 1000000))`, preserving row-level
rounding independently of ledger totals.

## Timezone, currency, UI, and accessibility evidence

- Two authorized stores were selected together:
  - `001`: `Asia/Tokyo`, July UTC range
    `[2026-06-30T15:00:00.000Z, 2026-07-31T15:00:00.000Z)`;
  - `DEFAULT`: `Asia/Ho_Chi_Minh`, July UTC range
    `[2026-06-30T17:00:00.000Z, 2026-07-31T17:00:00.000Z)`.
- The browser rendered two distinct currency regions, `$` and `₫`; values were
  never merged.
- The `$` store had no July financial rows and visibly contained the localized
  `该筛选范围没有数据` state. As corrected above, that observation did not prove
  that every empty chart suppressed its SVG.
- The default populated Dashboard rendered three native SVG charts with
  `role="img"` and valid `aria-labelledby` title/description pairs, plus three
  equivalent data tables.
- A full-page screenshot was visually inspected. Cards, charts, negative
  values, tables, filter controls, and the staging banner rendered without a
  visible layout failure.
- Application-origin console errors/warnings: 0. Warnings emitted by unrelated
  Chrome extensions were excluded from the application result.

## Employee and detail evidence

Employee `898…2970` was selected because staging history contains fine,
advance, and actual-payment records.

- Overview row: fine `₫-2,100,000`, advance `₫-2,100,000`, net
  `₫27,000,000.001`, actual payment `₫19,800,000`.
- Ledger detail rendered 1,024 immutable rows in descending time order.
- The table showed the documented safe fields and did not expose
  `metadata_json`.
- Page 1 rendered `第 1 / 11 页，共 1024 条`, displayed the exact QA reversal
  with the localized `冲正` badge, disabled previous, and enabled next.
- Page 2 rendered `第 2 / 11 页，共 1024 条` with 100 rows; previous and next
  were enabled. Returning to page 1 restored the reversal row and badge.

## Authorized retained QA data

The user explicitly authorized a staging-only acceptance fixture in
`payroll_entries` for the existing validated employee. No store or employee was
created.

- Marker: `staging-dashboard-task7-20260728-v1`.
- Source: `qa_dashboard_validation_v1`.
- Inserted 1,002 rows: 1,000 one-micro `bonus` rows, one
  `+1,000,000`-micro adjustment, and its exact `-1,000,000`-micro reversal.
- All rows use one existing store, one existing employee, and one currency.
- QA net effect: `+1,000` micros (`₫0.001`).
- Re-running the exact insert returned zero changes and zero rows written.
- The fixture is intentionally retained for future staging regression checks.

## Permission isolation evidence

The live hand-edited probe used a temporary authenticated staging global-admin
session and requested
`/api/admin/stores/QA-UNAUTHORIZED-STORE-T7/dashboard?date_from=2026-07-01&date_to=2026-07-31`.
It returned HTTP `400` with
`{"ok":false,"error":"unknown_store"}`. This is the designed result for a
global admin: global admins pass `isStoreAdmin` for every store ID, after which
Dashboard store resolution rejects an ID that is not present.

The `400` result is **not** presented as a `403`. Store-scope isolation for a
non-global admin is verified by the automated test
`forbids a Dashboard selection containing a store outside the admin scope` in
`test/dashboard.test.js`. The test authenticates an admin for `TOKYO`, requests
`TOKYO,SINGAPORE`, and asserts HTTP `403` with
`{"ok":false,"error":"forbidden_store"}`.

The user chose not to request another login code from an existing store
administrator. This avoided an unnecessary Telegram message; the automated
`403` contract was accepted as the permission isolation evidence. After the
probe, `POST /api/admin/logout` returned HTTP `200` with `{"ok":true}`.
The local temporary cookie jar and response-body file were deleted. No
non-global temporary session, store, or employee was created; a direct
database session-mint attempt was rejected before execution and caused no
remote write.

## Production non-change proof

Production was accessed only through read-only `GET /` and `GET /admin`.

- Production `/admin` had no staging banner.
- DOM marker count for Dashboard navigation, panel, chart, and filter selectors
  was 0.
- The complete returned HTML had no case-insensitive `dashboard` text.
- Production authentication was intentionally not initiated: the normal login
  flow writes a login code/session and sends a Telegram message, which would
  violate this task's production read-only boundary.

## Acceptance decision

The original live validation established the financial, timezone, currency,
populated-chart, accessibility, detail, pagination, reversal,
production-isolation, and safety evidence recorded above. The later live retest
of Worker version `9d5a75a1-a78a-42c9-bf59-37ff4a952e42` failed the empty-chart
SVG-suppression requirement. The second fix currently has local automated
evidence only. Permission behavior is recorded without conflating the live
global-admin
`400 unknown_store` probe with the non-global-admin automated
`403 forbidden_store` contract.

The first empty-chart fix received a live staging pass and failed as described
above; the second fix has not yet received one. Phase 9 therefore remains `🧪`
evidence rather than production approval, and this report does not authorize a
production migration, deployment, feature enablement, merge, or rollout.
