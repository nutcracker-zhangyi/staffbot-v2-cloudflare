# Final Review Fix Report

## Status

Complete. All five final-review findings are fixed on `codex/employee-absence-check` from starting HEAD `9808be6`.

## Finding mapping

1. **Cron candidate race**
   - Replaced the stale-candidate `VALUES` insert with `INSERT OR IGNORE ... SELECT` from the current `store_members` row.
   - The insert now atomically rechecks store membership, active employee status, `absence_check_enabled = 1`, non-null/current enable boundary, join-date boundary, no check-in, and no approved leave.
   - Added deterministic interleaving coverage that disables the employee after candidate discovery and immediately before the request insert; no request is created.

2. **Outbox race**
   - Replaced the unconditional notification insert with a conditional insert that requires the request to remain pending and its employee membership to remain active and absence-enabled.
   - Added deterministic interleaving coverage that disables the employee after the pending-request snapshot and immediately before outbox insertion; no notification row is created.

3. **Delivery race**
   - Added a final database read immediately before Telegram delivery.
   - The read requires the exact notification row to remain `sending` with the same `claimed_at`, its request to remain pending in the same store, and its employee membership to remain active and absence-enabled.
   - A failed final read does not send. The code cancels only an exact lease still owned by this delivery, preserving a row already changed by the disable transaction.
   - Added deterministic coverage that disables the employee after claim and before the final fetch; Telegram is not called and the notification is cancelled.

4. **Explicit value validation**
   - `absence_check_enabled` now accepts only JSON booleans when explicitly present.
   - Invalid explicit values return HTTP 400 with `invalid_absence_check_enabled` before member/request/outbox/audit mutation.
   - Added an HTTP test using the string `"false"` and verified that the member remains enabled, the pending request remains pending, and no audit is written.

5. **Audit atomicity**
   - Added `auditStatement(...)` to reuse the existing audit schema and binding behavior without changing unrelated audit callers.
   - The employee `update_member` audit insert is appended to the same D1 batch as the user/member upsert and pending-work cancellations.
   - Added injected audit-statement failure coverage proving the switch, request cancellation, notification cancellation, and audit all roll back together.

## TDD evidence

### RED

After adding only the five regression tests, ran:

```bash
node --test test/admin-pagination-leave.test.js
```

Result: exit code 1; 63 passed, 5 failed. The expected failures were:

- invalid explicit value returned 200 instead of 400;
- audit failure occurred after the switch/cancellation batch had committed;
- disable-after-claim still sent Telegram;
- disable-after-candidate-discovery still inserted one absence request;
- disable-after-request-snapshot still inserted one outbox row.

### GREEN

After the minimal implementation and fixture updates, ran the same command.

Result: exit code 0; 68 passed, 0 failed.

## Verification commands and results

```bash
npm run check
```

- Exit code 0.
- `node --check src/index.js` succeeded.

```bash
npm test
```

- Exit code 0.
- 92 tests passed, 0 failed.

```bash
git diff --check
```

- Exit code 0 with no whitespace errors.

## Commits

- `a9e2dc7 fix: close employee absence race windows`

## Self-review

- Correctness: each stale-read window is closed at the write/send boundary; request insertion includes every eligibility predicate named in the review.
- Transactionality: employee mutation, pending-request cancellation, notification cancellation, and employee audit share one D1 batch.
- Input boundary: validation occurs before reading or mutating the target member's absence state.
- Lease safety: the final cancellation update includes the exact `sending` status and `claimed_at`, so it cannot overwrite a newer claimant or a disable transaction's cancellation.
- Security: all added SQL remains parameterized; no authorization path or dependency changed.
- Scope: only `src/index.js`, its existing test file, and this required report were changed; unrelated audit paths were not refactored.
- Performance: the new conditional writes and final delivery read are bounded by primary/unique keys; no unbounded query or new dependency was added.

## Concerns

- The database preflight closes local races, but state can still change after the final read while the Telegram HTTP request is in flight. That external boundary cannot be made exactly-once with the current API, so notification delivery remains at-least-once. The code documents this directly before the external send.
- No other blocking or required self-review findings remain.
