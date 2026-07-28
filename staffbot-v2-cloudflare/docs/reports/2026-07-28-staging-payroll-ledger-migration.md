# Staging payroll ledger migration evidence

Date: 2026-07-28
Environment: staging only
Worker: `staffbot-v2-staging`
D1 database: `staffbot_v2_staging` (`b4330cfc-55af-4466-ba12-1ab9d0eaa352`)
Cloudflare account: `52f18c76e21bef933732b4bc4e0ace53`

## Safety boundary

- Production configuration remained `PAYROLL_LEDGER_WRITE_MODE = "off"` and
  `PAYROLL_LEDGER_READ_MODE = "legacy"`.
- Every remote D1 command used `--env staging --remote`.
- Staging scheduled tasks remained disabled.
- Staging Telegram delivery remained restricted to the allowlist.
- No production migration or deployment command was run.

Required release statements:

```text
production migrations: not run
production deployment: not run
staging preflight blockers: 0
staging reconciliation differences: 0
staging backfill rerun changes: 0
```

## Identity and migration gate

Commands:

```bash
npx wrangler whoami
npx wrangler d1 migrations list DB --env staging --remote
```

Results:

- Wrangler version: `4.100.0`.
- Authenticated account ID:
  `52f18c76e21bef933732b4bc4e0ace53`.
- Initial pending migrations:
  - `019_payroll_entries.sql`
  - `020_backfill_payroll_entries.sql`
- Final migration status: `No migrations to apply`.

## Preflight

Command:

```bash
npx wrangler d1 execute DB --env staging --remote --json \
  --file db/audits/019_payroll_ledger_preflight.sql
```

The same read-only `SELECT` was also executed with `--command` because the
Wrangler file-upload response returned execution metadata rather than the
result row.

| Check | Count |
| --- | ---: |
| Unknown type rows | 0 |
| Missing required rows | 0 |
| Sub-micro precision rows | 0 |
| Unsafe integer rows | 0 |
| Missing store rows | 0 |
| Missing member rows | 0 |
| Duplicate identity rows | 0 |
| Zero-effect rows | 16 |

All seven blocking counts were zero. The 16 zero-effect rows were recorded
separately and intentionally excluded from the ledger.

## Migration application and D1 compatibility correction

Command:

```bash
npx wrangler d1 migrations apply DB --env staging --remote
```

Migration 019 applied successfully. Migration 020 initially failed with:

```text
not authorized: SQLITE_AUTH
```

Evidence isolated the failure to `CREATE TEMP TABLE`: an isolated staging
probe returned the same error, migration 020 remained unapplied, and
`payroll_entries` still contained zero rows.

The migration guard was changed from a temporary table to a short-lived
regular table that is dropped within the migration. This preserves the
fail-closed preflight constraint while remaining compatible with remote D1.
A regression test runs the real migration under a SQLite authorizer that
rejects temporary table operations.

After the correction:

- `019_payroll_entries.sql`: applied.
- `020_backfill_payroll_entries.sql`: applied.
- `payroll_backfill_guard` tables remaining: 0.
- Initial expected non-zero legacy rows: 142.
- Initial actual ledger rows: 142.

## Backfill idempotency

The `INSERT INTO payroll_entries ... ON CONFLICT(entry_id) DO NOTHING`
portion of migration 020 was executed again against staging.

Result:

```text
success: true
changes: 0
rows_written: 0
```

## Exact reconciliation

Command:

```bash
npx wrangler d1 execute DB --env staging --remote --json \
  --file db/audits/020_payroll_ledger_reconcile.sql
```

For explicit empty-result evidence, the same SQL was also passed through
`--command`.

Reconciliation result after backfill, dual-write approval, shadow reads, and
ledger reads:

```json
{"results":[],"success":true,"changes":0}
```

Final snapshot:

| Check | Result |
| --- | ---: |
| Expected non-zero legacy entries | 145 |
| Actual ledger entries | 145 |
| Applied ledger migrations | 2 |
| Guard tables remaining | 0 |
| Reconciliation differences | 0 |
| `payroll_shadow_mismatch` logs | 0 |

## Dual-write proof

Staging configuration:

```text
PAYROLL_LEDGER_WRITE_MODE=dual
PAYROLL_LEDGER_READ_MODE=legacy
```

Worker version:

```text
53657b10-0e84-4b14-8bae-ac479fbf575d
```

Two staging-only requests were created with explicit `TEST-LEDGER-*` IDs:

| Request | Amount |
| --- | ---: |
| `TEST-LEDGER-INCOME-20260728` | income 1,000,000₫; commission 600,000₫; fine 100,000₫ |
| `TEST-LEDGER-ADVANCE-20260728` | advance 100,000₫ |

Both were approved through the real authenticated staging admin API.

| Flow | First request | Repeated request |
| --- | ---: | ---: |
| Income with fine | HTTP 200 | HTTP 409 `already_decided` |
| Salary advance | HTTP 200 | HTTP 409 `already_decided` |

The approvals produced three legacy records and three ledger entries:

| Type | Legacy micros | Ledger micros |
| --- | ---: | ---: |
| Income | 600,000,000,000 | 600,000,000,000 |
| Fine | -100,000,000,000 | -100,000,000,000 |
| Advance | -100,000,000,000 | -100,000,000,000 |
| Total | 400,000,000,000 | 400,000,000,000 |

## Shadow-read proof

Staging configuration:

```text
PAYROLL_LEDGER_WRITE_MODE=dual
PAYROLL_LEDGER_READ_MODE=shadow
```

Worker version:

```text
e5f91c60-bc89-4120-9731-8738df99257a
```

Checks:

- Income admin path: HTTP 200.
- Salary admin path: HTTP 200.
- Salary advance admin path: HTTP 200.
- Telegram `/total` update ID: `81602129`.
- `payroll_shadow_mismatch` count: 0.
- Exact reconciliation differences: 0.

## Ledger-read proof

Final staging configuration:

```text
PAYROLL_LEDGER_WRITE_MODE=dual
PAYROLL_LEDGER_READ_MODE=ledger
```

Worker version:

```text
38382b01-6fbc-435c-bde1-b553db7c48cd
```

URL:

```text
https://staffbot-v2-staging.staffbot-v2.workers.dev
```

Checks:

- Health endpoint: HTTP 200.
- Admin page: HTTP 200.
- Income admin path: HTTP 200.
- Salary admin path: HTTP 200.
- Salary advance admin path: HTTP 200.
- Telegram `/total` update ID: `81602130`.
- Telegram test account legacy total:
  `1,203,700,000,000,000 micros`.
- Telegram test account ledger total:
  `1,203,700,000,000,000 micros`.
- Exact reconciliation differences: 0.

## Local verification

Commands:

```bash
npm run check
npm test
```

Result:

```text
tests: 187
passed: 187
failed: 0
```

## Rollback

Read rollback:

```text
PAYROLL_LEDGER_READ_MODE=legacy
```

Write rollback:

```text
PAYROLL_LEDGER_WRITE_MODE=off
```

Rollback is configuration-only followed by a staging deployment. Existing
ledger rows must not be deleted.
