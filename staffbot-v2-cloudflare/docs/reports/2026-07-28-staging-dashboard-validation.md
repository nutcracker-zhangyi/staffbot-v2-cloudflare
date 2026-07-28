# Staging Dashboard validation evidence

Date: 2026-07-28
Outcome: **blocked — staging acceptance is incomplete**

## Scope and safety boundary

- Code under test: `3906a00ec53c84b3ffd796578d68663bf4731ff8`
  (`fix: preserve production mobile admin styles`).
- Staging Worker version:
  `342799f0-73f3-4408-a8ca-936e4625c7a2`.
- The only deployment command was
  `npx wrangler deploy --env staging`.
- No production deploy, migration, flag change, merge, push, or pull request
  occurred.
- Every Wrangler D1 command in this validation used `--env staging --remote`
  and contained only `SELECT` or `PRAGMA`. Wrangler reported zero changes and
  zero rows written.
- Secret names were listed, but secret values were never read or printed.
- Browser inspection did not read cookies, local storage, session storage, or
  authentication tokens.

Phase 9 remains `⬜`. The evidence below does not establish full staging
acceptance and must not be described as production-ready.

## Local release gate

| Command | Result |
| --- | --- |
| `npm run check` | passed |
| `npm test` | 222 passed, 0 failed, 0 skipped |
| `npm run test:staging` | 6 passed, 0 failed, 0 skipped |
| `git diff --check` | passed |
| `git status --short` | clean before remote preflight and deployment |

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
| Ledger net | 1,309,400,000,000,000 | ₫1,309,400,000 |
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
- The `$` store had no July financial rows and rendered the localized
  `该筛选范围没有数据` state.
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
  `₫27,000,000`, actual payment `₫19,800,000`.
- Ledger detail rendered 22 immutable rows in descending time order.
- The table showed the documented safe fields and did not expose
  `metadata_json`.
- Pagination rendered `第 1 / 1 页，共 22 条`; previous and next controls were
  correctly disabled for the available data.

## Production non-change proof

Production was accessed only through read-only `GET /` and `GET /admin`.

- Production `/admin` had no staging banner.
- DOM marker count for Dashboard navigation, panel, chart, and filter selectors
  was 0.
- The complete returned HTML had no case-insensitive `dashboard` text.
- Production authentication was intentionally not initiated: the normal login
  flow writes a login code/session and sends a Telegram message, which would
  violate this task's production read-only boundary.

## Blocking acceptance gaps

1. Staging contains **zero** `payroll_entries.type='reversal'` rows. No employee
   can satisfy the required fine + advance + reversal + payment history case,
   and the visible reversal badge cannot be verified with real data.
2. The largest staging employee ledger has 29 rows; the page size is 100.
   Pagination controls and the single-page state were verified, but a live
   transition to page 2 cannot be exercised with current staging data.
3. Chrome blocked direct navigation to authenticated
   `/api/admin/stores/{hand-edited-id}/dashboard` URLs with
   `ERR_BLOCKED_BY_CLIENT` before a response was available. The live `403`
   permission response was therefore not captured. Local authenticated route
   tests cover the `403` contract but do not replace remote acceptance.
4. The available browser-control surface did not expose a network-request list.
   UI data loading succeeded and application console inspection was clean, but
   a request-by-request network-panel record was not captured.

Because these required checks are incomplete, the Dashboard is not marked
staging-verified in `docs/ROADMAP.md`.
