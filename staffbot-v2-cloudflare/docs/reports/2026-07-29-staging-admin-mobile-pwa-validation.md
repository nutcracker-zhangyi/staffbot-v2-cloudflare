# Admin Mobile PWA Staging Validation

- Validation date: 2026-08-01
- Local code base: `e51cc90d6e21c4b7aab70c73f0a9a9ff71c9a8dd`
- Local implementation commit: recorded in the Task 14 SDD report after commit
- Target environment: staging only
- Production deployed: **NO**

This report intentionally separates completed local evidence from remote and
real-device work. No remote D1 command, staging deploy, staging HTTP smoke test,
or real-device operation was performed during the local implementation stage.

## Local automated evidence

| Check | Result | Evidence |
| --- | --- | --- |
| Syntax | PASS | `npm run check` |
| Focused PWA behavior | PASS | 98/98 in the manage page, security, and routing test files |
| Full regression | PASS | 567/567 via `npm test` |
| Whitespace | PASS | `git diff --check` |
| Manifest | PASS | Response fetched and parsed as JSON; install metadata and security/cache headers asserted |
| Service worker | PASS | Real `/manage/sw.js` response executed in a fake Worker global |
| Fixed shell install | PASS | Exactly five approved shell URLs cached; install failure propagates |
| Cache boundary | PASS | Cache-first only for exact same-origin shell GET; API, proof, query variant, cross-origin, and non-GET use network only |
| Offline safety | PASS | Persistent banner and mutation guards exercised for login, approvals, splits, uploads, and submit |
| Reconnect safety | PASS | Approval and payroll remain locked until session, stores, and current authority are reloaded; refresh failure remains read-only |

The local Wrangler executable was not present. `npx wrangler` was not invoked
because it could download a package or access the network; Wrangler and remote
evidence remain pending.

## Staging infrastructure evidence

| Check | Status | Evidence |
| --- | --- | --- |
| Remote migration list | PENDING | Not run |
| Migration 023 applied | PENDING | Not run |
| Migration 024 applied | PENDING | Not run |
| `admin_task_claims` table | PENDING | Not queried remotely |
| `payroll_payment_attempts` table | PENDING | Not queried remotely |
| Backfill reconciliation counts | PENDING | Not queried remotely |
| Staging deployment/version | PENDING | Not deployed |
| `GET /` staging health | PENDING | Not requested |
| `/manage/` shell and manifest | PENDING | Not requested |
| `/admin` unchanged/staging marker | PENDING | Not requested |

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

- Deployed staging Worker version and exact implementation commit.
- Remote migration output and reconciliation counts.
- iPhone Safari and Android Chrome versions.
- Redacted task, attempt, proof, and audit IDs for each business scenario.
- Telegram failure/retry delivery evidence without Bot Tokens or private proof
  content.
- Redacted screenshots proving immutable payment versions and proof history.

## Known limitations at this stage

- The PWA has only been validated through local automation.
- Install prompts, camera/photo-library integration, offline browser behavior,
  and Telegram round trips still require staging devices.
- No claim is made that staging has been validated or that production is ready.

## Production gate

Production migrations, production deployment, merge to `main`, and production
Telegram webhook changes remain prohibited until the user explicitly says
`发布 live` after staging acceptance is complete.
