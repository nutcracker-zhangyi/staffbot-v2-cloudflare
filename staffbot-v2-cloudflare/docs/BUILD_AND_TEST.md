# Build And Test

## Local Syntax Check

```text
npm run check
```

## Cloudflare Setup

Install Wrangler if you do not have it:

```text
npm install -g wrangler
```

Login:

```text
wrangler login
```

Create D1 database:

```text
wrangler d1 create staffbot_v2
```

Copy `wrangler.toml.example`:

```text
cp wrangler.toml.example wrangler.toml
```

Fill `database_id` in `wrangler.toml`.

Apply schema:

```text
wrangler d1 execute staffbot_v2 --file db/schema.sql
```

Set secrets:

```text
wrangler secret put BOT_TOKEN
wrangler secret put WEBHOOK_SECRET
wrangler secret put ADMIN_IDS
```

Deploy:

```text
wrangler deploy
```

## Set Telegram Webhook

After deployment, your webhook URL is:

```text
https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev/webhook/YOUR_WEBHOOK_SECRET
```

Set webhook:

```text
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev/webhook/YOUR_WEBHOOK_SECRET&drop_pending_updates=true"
```

## Test In Telegram

Send:

```text
/ping
```

Expected:

```text
pong ...
```

Then test income:

```text
/income
2000
0
```

Expected:

- User receives submitted message.
- Admin receives approve/reject buttons.
- `pending_income` has one row.

## Inspect Logs

```text
wrangler d1 execute staffbot_v2 --command "SELECT * FROM bot_logs ORDER BY id DESC LIMIT 20"
```

## Inspect Pending Income

```text
wrangler d1 execute staffbot_v2 --command "SELECT * FROM pending_income ORDER BY submitted_at DESC LIMIT 20"
```
