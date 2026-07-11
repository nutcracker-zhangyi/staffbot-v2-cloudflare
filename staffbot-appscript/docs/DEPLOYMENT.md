# Deployment Guide

## Prerequisites

- A Telegram account.
- A Google account.
- Access to Google Sheets and Google Apps Script.

## 1. Create Telegram Bot

1. Open Telegram.
2. Search for `@BotFather`.
3. Send `/newbot`.
4. Follow the prompts.
5. Save the bot token.

The token looks like:

```text
123456789:AA...
```

## 2. Get Admin Telegram ID

1. Search for `@userinfobot` in Telegram.
2. Press Start.
3. Save your numeric Telegram ID.

## 3. Create Google Sheet

1. Open `https://sheets.new`.
2. Rename it to `Staff_Bot_DB`.
3. Copy the Sheet ID from the URL.

Example URL:

```text
https://docs.google.com/spreadsheets/d/SHEET_ID_HERE/edit
```

## 4. Create Apps Script Project

1. Open `https://script.new`.
2. Name the project `StaffBot`.
3. Open project settings.
4. Enable showing the `appsscript.json` manifest file.

## 5. Add Source Files

Create each `.gs` file from this folder in Apps Script.
Replace the generated `appsscript.json` with this project's `appsscript.json`.

Required files:

- `appsscript.json`
- `Config.gs`
- `I18n.gs`
- `Utils.gs`
- `Telegram.gs`
- `Db.gs`
- `Main.gs`
- `Income.gs`
- `Stats.gs`
- `Salary.gs`
- `Attendance.gs`
- `Setup.gs`

## 6. Set Script Properties

In Apps Script:

Project Settings -> Script properties -> Add script property

| Key | Value |
| --- | --- |
| `BOT_TOKEN` | Token from `@BotFather` |
| `WEBHOOK_SECRET` | Random secret string, about 32 characters |
| `SHEET_ID` | Google Sheet ID |
| `WEBAPP_URL` | Leave empty until Web App deployment |

## 7. Initialize Sheets

1. Select function `setupSheets`.
2. Click Run.
3. Approve Google permissions.
4. Open the Google Sheet and confirm the tabs were created.

Expected tabs:

- `Employees`
- `Pending_Income`
- `Income_Records`
- `Rejected_Income`
- `Salary_Requests`
- `Salary_History`
- `Attendance`
- `Admin_Audit_Log`
- `Settings`
- `Error_Log`

## 8. Configure Admins

Open the `Settings` sheet.

Change `ADMIN_IDS` from placeholder text to your Telegram numeric ID.
For multiple admins, use comma-separated values.

Example:

```text
123456789,987654321
```

## 9. Deploy Web App

1. In Apps Script, click Deploy -> New deployment.
2. Select Web App.
3. Execute as: Me.
4. Who has access: Anyone.
5. Click Deploy.
6. Copy the Web App URL.

## 10. Save Web App URL

Return to Script properties and set:

```text
WEBAPP_URL=<the deployed Web App URL>
```

## 11. Register Telegram Webhook

1. Select function `setWebhook`.
2. Click Run.
3. Check logs.

Success response should include:

```json
{"ok":true}
```

## 12. Test

Open your Telegram bot and send:

```text
/start
```

Expected behavior:

1. Bot asks for language.
2. User chooses Chinese, English, or Vietnamese.
3. Main menu appears.
4. Test income submission, admin approval, total income, salary request, and attendance.
