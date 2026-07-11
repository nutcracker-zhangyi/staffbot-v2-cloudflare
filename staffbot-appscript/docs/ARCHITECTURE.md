# Architecture

## Overview

This bot uses Google Apps Script as a serverless backend and Google Sheets as the database.
Telegram sends user messages and button clicks to the Apps Script Web App through a webhook.

```text
Employee/Admin Telegram app
        |
        v
Telegram Bot API
        |
        v
Apps Script Web App: doPost(e)
        |
        v
Message / callback router
        |
        v
Feature modules
        |
        v
Google Sheets
```

## Request Flow

1. A user sends a message or taps an inline button in Telegram.
2. Telegram calls the deployed Apps Script Web App URL.
3. `Main.gs/doPost(e)` validates the `WEBHOOK_SECRET` query parameter.
4. Duplicate Telegram updates are ignored through `isDuplicateUpdate()`.
5. Messages are routed to `handleMessage(msg)`.
6. Button callbacks are routed to `handleCallback(cb)`.
7. Feature modules read/write Google Sheets and send Telegram responses.

## Module Boundaries

| Module | Responsibility |
| --- | --- |
| `Main.gs` | Entrypoint, routing, command dispatch |
| `Telegram.gs` | Telegram HTTP calls and keyboard builders |
| `Db.gs` | Sheet access and employee records |
| `Config.gs` | Script properties and runtime settings |
| `I18n.gs` | Translation dictionary and language selection |
| `Income.gs` | Income request lifecycle |
| `Salary.gs` | Salary request lifecycle |
| `Attendance.gs` | Location, check-in, checkout, attendance fines |
| `Stats.gs` | Income total calculation |
| `Setup.gs` | Initial setup and webhook utilities |
| `Utils.gs` | Shared helper functions |

## State Management

Short-lived conversational state is stored in `CacheService`.

Examples:

- Waiting for an income amount.
- Waiting for a fine amount.
- Waiting for admin rejection reason.
- Temporary attendance location.

Persistent business data is stored in Google Sheets.

## Locking

Approval and attendance operations use `LockService.getScriptLock()` to reduce duplicate processing when multiple callbacks arrive close together.

## Language Handling

Employees select a language on first use.
The selected language is stored in the `Employees.Language` column.
Text is resolved through `t(uid, key, params)` in `I18n.gs`.
