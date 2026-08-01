# StaffBot Staging Runbook

## Resources

- Worker: `staffbot-v2-staging`
- D1: `staffbot_v2_staging`
- R2: `staffbot-v2-payroll-proofs-staging`
- Telegram: `@staffbot_v2_staging_bot`
- URL: `https://staffbot-v2-staging.staffbot-v2.workers.dev`

All resources above are separate from production. The R2 bucket uses the
Standard storage class and is private by default.

## Deploy

Run from the `staffbot-v2-cloudflare` project directory:

```bash
npm run check
npm test
npx wrangler deploy --env staging
curl -fsS https://staffbot-v2-staging.staffbot-v2.workers.dev/
```

This is the required phase-2 verification order. Run `npm run test:staging`
as an additional focused check before deployment when staging configuration
or sanitization changes.

No remote mutation or deployment command without `--env staging` is permitted
in this phase. In particular, never run a bare `npx wrangler deploy`.
Production deploys and production migrations are outside this phase.

## Verify

```bash
curl -fsS https://staffbot-v2-staging.staffbot-v2.workers.dev/
curl -fsS https://staffbot-v2-staging.staffbot-v2.workers.dev/admin
npx wrangler secret list --env staging
npx wrangler d1 migrations list DB --env staging --remote
```

Expected:

- `GET /` returns `"environment":"staging"`.
- `/admin` contains `STAGING 测试环境`.
- Secret names include `BOT_TOKEN`, `WEBHOOK_SECRET`, `ADMIN_IDS`, and
  `STAGING_ALLOWED_TELEGRAM_IDS`; values are never displayed.
- The staging environment has `crons = []`.
- `SCHEDULED_TASKS_ENABLED` is `false`.
- A new `/start` sent to `@staffbot_v2_staging_bot` reaches staging D1.

## Admin mobile PWA acceptance

Keep local verification, staging changes, and device acceptance as separate
gates. Passing local tests does not authorize a remote migration or deploy.

### Local gate

```bash
npm run check
node --test test/manage-page.test.js test/manage-security.test.js test/manage-routing.test.js
npm test
git diff --check
```

The focused tests execute the manifest response as JSON and execute the real
service-worker response in a fake Worker global. They verify the fixed app
shell, network-only business requests, cache cleanup, install failure, offline
mutation guards, and authoritative reconnect behavior.

### Staging database and deploy gate

Run only after the local change has passed independent review:

```bash
npx wrangler d1 migrations list staffbot_v2_staging --env staging --remote
npx wrangler d1 migrations apply staffbot_v2_staging --env staging --remote
npx wrangler d1 execute staffbot_v2_staging --env staging --remote --command \
  "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('admin_task_claims','payroll_payment_attempts') ORDER BY name"
npx wrangler deploy --env staging
curl -fsS https://staffbot-v2-staging.staffbot-v2.workers.dev/
curl -fsS https://staffbot-v2-staging.staffbot-v2.workers.dev/manage/
curl -fsS https://staffbot-v2-staging.staffbot-v2.workers.dev/manage/manifest.webmanifest
curl -fsS https://staffbot-v2-staging.staffbot-v2.workers.dev/admin
```

Record the migration output, deployed Worker version, smoke responses, and
browser/device acceptance in
`docs/reports/2026-07-29-staging-admin-mobile-pwa-validation.md`. Leave every
unperformed item as `PENDING`; never infer a pass from local automation.

## Refresh staging data

1. Confirm the target D1 is `staffbot_v2_staging` and contains no data that
   must be preserved.
2. Create a private temporary directory:

   ```bash
   mktemp -d /private/tmp/staffbot-staging.XXXXXX
   ```

3. Set the directory mode to `700`.
4. Export production D1 into that exact directory:

   ```bash
   npx wrangler d1 export staffbot_v2 \
     --remote \
     --output=/private/tmp/staffbot-staging.EXACT/staffbot-live.sql
   ```

5. Set the SQL file mode to `600`.
6. Import the export only into staging:

   ```bash
   npx wrangler d1 execute staffbot_v2_staging \
     --remote \
     --file=/private/tmp/staffbot-staging.EXACT/staffbot-live.sql
   ```

7. Remove transient production state:

   ```bash
   npx wrangler d1 execute staffbot_v2_staging \
     --remote \
     --file=./scripts/staging-sanitize.sql
   ```

8. Verify all business-table counts against a local SQLite copy of the exact
   export. Use scalar subqueries rather than a long `UNION ALL`; this D1
   instance rejects large compound selects.
9. Verify `admin_sessions`, `admin_login_codes`, `user_states`,
   `absence_fine_notifications`, and `bot_logs` are empty.
10. Validate the exact temporary path, then delete only that directory.

Never keep the production SQL export in the repository or home directory.

## Telegram safety

- Only Telegram IDs in `STAGING_ALLOWED_TELEGRAM_IDS` may receive staging
  messages.
- Calls without `chat_id`, such as callback acknowledgements, remain
  available inside staging.
- Blocked delivery attempts are logged as
  `staging_telegram_recipient_blocked`.
- Never copy the production Bot Token into staging.
- Set or rotate secrets only with `npx wrangler secret put ... --env staging`.
- Do not place Bot Tokens, webhook secrets, login codes, or numeric personal
  IDs in Git, command history, documentation, or chat.

## Cron safety

- Keep `[env.staging.triggers] crons = []` in `wrangler.toml`.
- Keep `SCHEDULED_TASKS_ENABLED = "false"`.
- After deployment, confirm `stores.absence_last_checked_date` did not advance.
- Do not enable staging Cron during ordinary testing.

## Production safety

After staging work, verify production read-only:

```bash
curl -fsS https://staffbot-v2.staffbot-v2.workers.dev/
npx wrangler d1 migrations list DB --remote
```

The production health response must remain normal, and no production migration
or root Worker deployment may be performed as part of staging work.

## Teardown boundary

Do not delete the staging Worker, D1 database, R2 bucket, Telegram bot, or
secrets unless the user explicitly approves those exact destructive actions.
