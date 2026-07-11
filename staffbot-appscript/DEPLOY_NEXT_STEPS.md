# StaffBot deployment handoff

Generated from:

`/Users/nutcrackermacbookair/Downloads/Club/05_Telegram机器人_最简执行指南_多语言版.md`

## Files

This folder contains the 12 Google Apps Script files required by the guide.

For the reorganized engineering documentation, start with:

- `README.md`
- `docs/README.zh-CN.md`
- `docs/DEPLOYMENT.md`

## Needed from the account owner

1. Telegram bot token from `@BotFather`
2. Telegram numeric admin ID from `@userinfobot`
3. Google account authorization for Apps Script and Sheets

## Script properties

Set these in Apps Script project settings:

| Key | Value |
| --- | --- |
| `BOT_TOKEN` | Telegram bot token |
| `WEBHOOK_SECRET` | Random 32-character secret |
| `SHEET_ID` | Google Sheet ID |
| `WEBAPP_URL` | Web App URL after deployment |

## Deployment order

1. Create Google Sheet.
2. Create Apps Script project.
3. Add all files in this folder.
4. Set script properties except `WEBAPP_URL`.
5. Run `setupSheets()`.
6. Put admin ID in the Sheet `Settings` tab under `ADMIN_IDS`.
7. Deploy as Web App with access set to anyone.
8. Add the Web App URL to `WEBAPP_URL`.
9. Run `setWebhook()`.
10. Test `/start` in Telegram.
