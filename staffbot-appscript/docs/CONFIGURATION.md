# Configuration Reference

Configuration is split between Apps Script project properties and the Google Sheet `Settings` tab.

## Apps Script Properties

These values are private runtime secrets and deployment identifiers.

| Key | Required | Description |
| --- | --- | --- |
| `BOT_TOKEN` | Yes | Telegram bot token from `@BotFather` |
| `WEBHOOK_SECRET` | Yes | Secret query parameter used to reject unknown webhook requests |
| `SHEET_ID` | Yes | Google Sheet database ID |
| `WEBAPP_URL` | Yes, after deployment | Deployed Apps Script Web App URL |

## Sheet Settings

The `Settings` sheet is created by `setupSheets()`.

| Key | Default | Description |
| --- | --- | --- |
| `ADMIN_IDS` | Placeholder text | Comma-separated Telegram admin IDs |
| `TIMEZONE` | `Asia/Ho_Chi_Minh` | Timezone used for dates and business logic |
| `CHECKIN_TIME` | `18:30` | Latest allowed check-in time before late fine |
| `CHECKOUT_TIME` | `01:30` | Earliest allowed checkout time before early-leave fine |
| `LATE_FINE` | `0.5` | Fine amount for late check-in |
| `EARLY_LEAVE_FINE` | `1.5` | Fine amount for early checkout |
| `CURRENCY` | `$` | Currency prefix shown in bot messages |

## Recommended Production Values

Use values that match your business location and pay rules.

Example:

```text
TIMEZONE=Asia/Ho_Chi_Minh
CHECKIN_TIME=18:30
CHECKOUT_TIME=01:30
LATE_FINE=0.5
EARLY_LEAVE_FINE=1.5
CURRENCY=$
```

## Secret Handling

Never paste `BOT_TOKEN`, `WEBHOOK_SECRET`, private admin IDs, or Sheet IDs into public documents or Git repositories.
Store them only in Apps Script project properties or private operational notes.
