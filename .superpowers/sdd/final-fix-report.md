# Admin absence final-fix report

## Finding mapping

1. Notification aggregation
   - The row and summary queries now classify `sent` only when `sent_total = notification_total`.
   - Rows expose `notification_sent_total` and `notification_total`; `not_queued` remains distinct.
   - Delivery text renders a localized `{sent}/{total}` value, with retry attempts appended for retrying rows.
   - Safe notification sorting uses the same all-sent definition.
   - Added a mixed sent+pending fixture and assertions for row state, counts, and summary totals.
2. Action errors
   - `bindAbsenceActions` catches API failures.
   - `already_decided` displays `absence_already_processed`; other failures display `absence_action_failed`.
   - Rendering occurs only after a successful API response.
   - Executable button-handler tests prove both failure branches alert and do not render/reload.
3. Four-language completeness
   - Added `decided_at` in zh/en/vi/ru.
   - Added `prev_page`, `next_page`, and `page_status` in vi/ru.
   - Added localized notification progress and action-error strings in all four languages.
   - The language test derives visible absence columns and controls and verifies four non-key labels for each.
4. Multi-store timezone
   - Absence rows return `s.timezone`.
   - Table time formatting uses the row timezone, falling back to the current store timezone.
   - The API fixture verifies different timezones for HCM and New York rows; source behavior is asserted.
5. Stable pagination
   - Pending defaults to `business_date DESC, created_at DESC, request_id DESC`.
   - History defaults to `COALESCE(decided_at, created_at) DESC, request_id DESC`.
   - Allowed custom sorts append the safe `request_id DESC` tiebreaker.

## TDD evidence

- RED: `node --test test/admin-pagination-leave.test.js` produced 76 passes and 8 expected failures covering missing translations, uncaught action errors, absent sort tiebreakers, mixed notification misclassification, and missing row timezone.
- GREEN: after the minimum implementation, the same focused command produced 84 passes and 0 failures.
- The focused suite was rerun after the final localized sent/total assertion and remained 84/84.

## Commands and results

- Generated admin script compile: fetched `/admin`, extracted inline scripts, and compiled each with `new Function`; passed.
- `node --test test/admin-pagination-leave.test.js`: 84 passed, 0 failed.
- `npm run check`: passed (`node --check src/index.js`).
- `npm test`: 108 passed, 0 failed.
- `git diff --check`: passed with no output.

## Commits

- `2cc1c3c` - `fix admin absence final review issues`
- This report is committed separately after the implementation commit.

## Concerns

- No known functional concerns. The localized 409 branch intentionally follows the existing `api()` contract, which exposes the server error code as `Error.message`.
