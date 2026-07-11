# Operations Guide

## Useful Functions

Run these functions from the Apps Script editor.

| Function | Use |
| --- | --- |
| `setupSheets()` | Create required Google Sheet tabs and default settings |
| `setWebhook()` | Register the Apps Script Web App URL with Telegram |
| `getWebhookInfo()` | Check current Telegram webhook status |
| `deleteWebhook()` | Remove Telegram webhook |
| `backupSpreadsheet()` | Create a Google Drive copy of the Sheet and trash old backups |

## Common Tasks

### Add an Admin

1. Open the `Settings` sheet.
2. Edit `ADMIN_IDS`.
3. Add the Telegram numeric ID.
4. Use commas for multiple admins.

### Change Language

Users can send:

```text
/lang
```

Then choose Chinese, English, or Vietnamese.

### Disable an Employee

1. Open the `Employees` sheet.
2. Find the employee row.
3. Change `Status` from `active` to another value.

The bot will stop serving that employee.

### Change Attendance Rules

Edit these keys in the `Settings` sheet:

- `CHECKIN_TIME`
- `CHECKOUT_TIME`
- `LATE_FINE`
- `EARLY_LEAVE_FINE`

### Check Errors

Open the `Error_Log` sheet.
Telegram API failures and caught script exceptions are written there.

## Backup

Run `backupSpreadsheet()` manually or attach it to a time-based Apps Script trigger.

The function:

- Creates a copy named `Staff_Bot_DB_Backup_yyyyMMdd_HHmm`.
- Moves backups older than 30 days to trash.

## Troubleshooting

### Bot Does Not Respond

Check:

- `BOT_TOKEN` exists and is correct.
- `WEBHOOK_SECRET` exists.
- `WEBAPP_URL` exists.
- `setWebhook()` was run successfully.
- Web App access is set to anyone.
- `getWebhookInfo()` has no Telegram error.

### Admin Does Not Receive Approval Messages

Check:

- `ADMIN_IDS` contains the correct numeric ID.
- Admin has opened the bot and sent `/start`.
- Admin selected a language.

### Sheet Not Found Error

Run `setupSheets()` and confirm `SHEET_ID` points to the correct Google Sheet.

### User Stuck in a Flow

Ask the user to send:

```text
/cancel
```
