# Telegram Staff Management Bot

Telegram employee management bot built on Google Apps Script and Google Sheets.

The bot lets employees submit income, request salary payout, and record attendance.
Admins approve or reject income and salary requests directly in Telegram.

中文工程说明见：[docs/README.zh-CN.md](docs/README.zh-CN.md)

## What This Project Does

- Registers Telegram users as employees automatically.
- Supports Chinese, English, and Vietnamese UI text.
- Stores employee, income, salary, attendance, audit, and error data in Google Sheets.
- Sends approval requests to configured admin Telegram accounts.
- Calculates salary-cycle income from approved records.
- Records attendance with shared Telegram location.
- Applies configurable fines for late check-in and early checkout.

## System Roles

- **Employee**: uses Telegram menu buttons to submit income, view total income, request salary, and check in/out.
- **Admin**: receives Telegram approval messages and approves or rejects requests.
- **Google Apps Script**: receives Telegram webhook updates and runs business logic.
- **Google Sheet**: acts as the database.

## Architecture

```text
Telegram user
  -> Telegram Bot API
  -> Google Apps Script Web App
  -> Google Sheets database
```

More details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Source Files

| File | Responsibility |
| --- | --- |
| `appsscript.json` | Apps Script runtime and Web App manifest |
| `Config.gs` | Script properties, sheet names, settings helpers |
| `I18n.gs` | Chinese / English / Vietnamese text dictionary |
| `Utils.gs` | Date, money, state, id, duplicate, audit, error helpers |
| `Telegram.gs` | Telegram API wrapper and keyboards |
| `Db.gs` | Google Sheets access and employee registration |
| `Main.gs` | Webhook entrypoint and message/callback router |
| `Income.gs` | Income submission and admin approval flow |
| `Stats.gs` | Total income calculation |
| `Salary.gs` | Salary request and approval flow |
| `Attendance.gs` | Location-based check-in/check-out flow |
| `Setup.gs` | Sheet initialization, webhook setup, backup helpers |

## Documentation

- [Deployment Guide](docs/DEPLOYMENT.md)
- [Configuration Reference](docs/CONFIGURATION.md)
- [Data Model](docs/DATA_MODEL.md)
- [Operations Guide](docs/OPERATIONS.md)
- [Security Notes](docs/SECURITY.md)

## Deployment Summary

1. Create a Telegram bot with `@BotFather`.
2. Create a Google Sheet.
3. Create a Google Apps Script project.
4. Add all `.gs` files and `appsscript.json`.
5. Set script properties.
6. Run `setupSheets()`.
7. Fill `ADMIN_IDS` in the `Settings` sheet.
8. Deploy as a Web App.
9. Save the Web App URL to `WEBAPP_URL`.
10. Run `setWebhook()`.

Full instructions: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)

## Important

Do not commit real bot tokens, webhook secrets, admin IDs, or private Sheet IDs to Git.
Those values belong in Apps Script project properties and the Google Sheet `Settings` tab.
