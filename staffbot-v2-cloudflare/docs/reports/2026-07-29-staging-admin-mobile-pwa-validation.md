# Admin Mobile PWA Staging Validation

- Validation date: 2026-08-01
- Local/deployed implementation commit: `9da4f4979b44d39ebc3533c1349b299bc0ece8a2`
- Staging Worker version: `f1a0be2e-081b-4223-bd6a-87869e0e7ecb`
- Staging URL: `https://staffbot-v2-staging.staffbot-v2.workers.dev`
- Target environment: staging only
- Production deployed: **NO**

This report separates completed local and staging evidence from the remaining
real-device and authenticated business-flow acceptance.

## Local automated evidence

| Check | Result | Evidence |
| --- | --- | --- |
| Syntax | PASS | `npm run check` |
| Focused PWA behavior | PASS | 102/102 in the manage page, security, and routing test files |
| Full regression | PASS | 571/571 via `npm test` |
| Whitespace | PASS | `git diff --check` |
| Manifest | PASS | Response fetched and parsed as JSON; install metadata and security/cache headers asserted |
| Service worker | PASS | Real `/manage/sw.js` response executed in a fake Worker global |
| Fixed shell install | PASS | Exactly five approved shell URLs cached; install failure propagates |
| Cache boundary | PASS | Cache-first only for exact same-origin shell GET; API, proof, query variant, cross-origin, and non-GET use network only |
| Offline safety | PASS | Persistent banner and mutation guards exercised for login, approvals, splits, uploads, and submit |
| Reconnect safety | PASS | Approval and payroll remain locked until session, stores, and current authority are reloaded; refresh failure remains read-only |

Wrangler `4.100.0` authenticated as `nutcracker.zhangyi@gmail.com`. The staging
dry-run confirmed the `staffbot_v2_staging` D1 database, staging payroll-proof
R2 bucket, disabled scheduled tasks, Telegram allowlist mode, and staging
manage origin before deployment.

## Staging infrastructure evidence

| Check | Status | Evidence |
| --- | --- | --- |
| Remote migration list | PASS | 023 and 024 were the only pending migrations before apply; no migrations remain afterward |
| Migration 023 applied | PASS | Wrangler remote migration apply completed successfully |
| Migration 024 applied | PASS | Wrangler remote migration apply completed successfully |
| `admin_task_claims` table | PASS | Present in remote staging D1 |
| `payroll_payment_attempts` table | PASS | Present in remote staging D1 |
| Backfill reconciliation counts | PASS | 2/2 payrolls have current attempts; 2 version-1 attempts; 4/4 proofs linked; zero invalid or orphan references |
| Staging deployment/version | PASS | Worker version `f1a0be2e-081b-4223-bd6a-87869e0e7ecb` |
| `GET /` staging health | PASS | HTTP 200, JSON |
| `/manage/` shell and manifest | PASS | Shell and all five PWA resources return HTTP 200 with expected MIME types; `/manage` redirects to `/manage/` |
| `/admin` unchanged/staging marker | PASS | HTTP 200, HTML |
| Browser mobile layout | PASS | In-app Chromium viewport 390x844 rendered the login form without console warnings/errors |
| PWA response headers | PASS | Strict CSP/security headers; manifest and service worker use `no-cache`; manifest start URL and scope are `/manage/` |

## Real-device and business-flow acceptance

| # | Acceptance scenario | Status | Evidence |
| --- | --- | --- | --- |
| 1 | OTP login and add-to-home-screen on iPhone Safari and Android Chrome | PENDING | Device/browser versions not recorded |
| 2 | Telegram deep link returns to the original task after login | PENDING | Not exercised |
| 3 | Store switching and task urgency order | PENDING | Not exercised |
| 4 | Income/fine, leave/absence, and advance approval | PENDING | Not exercised |
| 5 | Two-admin claim conflict, expiry, release, and owner takeover | PENDING | Not exercised |
| 6 | Bank plus USDT split equals fixed payroll | PENDING | Not exercised |
| 7 | Camera/library multi-image upload, isolated retry, and draft delete | PENDING | Not exercised |
| 8 | Submit, employee confirmation, traceable receipt, immutable history | PENDING | Not exercised |
| 9 | Employee dispute, payment v2, final confirmation, preserved v1 | PENDING | Not exercised |
| 10 | Telegram failure, committed payment, retry, no delivered-proof resend | PENDING | Not exercised |
| 11 | Offline banner and disabled financial actions | PENDING | Local automation PASS; device evidence pending |
| 12 | Cross-store and unauthenticated proof denial | PENDING | Local API tests exist; staging acceptance pending |

## Evidence still required

- iPhone Safari and Android Chrome versions.
- Redacted task, attempt, proof, and audit IDs for each business scenario.
- Telegram failure/retry delivery evidence without Bot Tokens or private proof
  content.
- Redacted screenshots proving immutable payment versions and proof history.

## Known limitations at this stage

- The PWA shell and mobile login layout have been validated in staging through
  HTTP smoke tests and an in-app Chromium browser; authenticated business flows
  remain pending.
- Install prompts, camera/photo-library integration, offline browser behavior,
  and Telegram round trips still require staging devices.
- No claim is made that staging has been validated or that production is ready.

## Production gate

Production migrations, production deployment, merge to `main`, and production
Telegram webhook changes remain prohibited until the user explicitly says
`发布 live` after staging acceptance is complete.
