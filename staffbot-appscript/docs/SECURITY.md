# Security Notes

## Secrets

Keep these values private:

- `BOT_TOKEN`
- `WEBHOOK_SECRET`
- `SHEET_ID`
- Admin Telegram IDs

Do not commit real values to Git.

## Webhook Protection

`doPost(e)` checks that the request URL contains the expected `WEBHOOK_SECRET`.

Telegram webhook URL format:

```text
WEBAPP_URL?token=WEBHOOK_SECRET
```

Requests without the correct token return `forbidden`.

## Apps Script Web App Access

The Web App must be accessible by anyone so Telegram can call it.
Because of that, the webhook secret is important.

## Admin Authorization

Admin callbacks are checked through `isAdmin(uid)`.
Unauthorized admin action attempts are written to `Admin_Audit_Log`.

## Data Privacy

The `Attendance` sheet stores latitude and longitude.
Treat the Google Sheet as sensitive employee data.

Recommended access:

- Owner account only for Apps Script.
- Admin-only access to the Google Sheet.
- No public sharing links.

## Operational Risk

Google Sheets is convenient but not a high-security database.
For larger teams, payment-critical workflows, or strict audit requirements, consider migrating persistent data to a real database and adding stronger authentication.
