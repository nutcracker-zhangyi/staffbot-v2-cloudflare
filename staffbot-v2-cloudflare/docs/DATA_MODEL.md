# 数据模型

第一版使用 Cloudflare D1，也就是 SQLite。

## 表列表

```text
users
user_states
pending_income
income_records
admin_audit_logs
bot_logs
settings
```

## users

保存 Telegram 用户。

```sql
CREATE TABLE users (
  telegram_id TEXT PRIMARY KEY,
  name TEXT,
  username TEXT,
  role TEXT NOT NULL DEFAULT 'employee',
  status TEXT NOT NULL DEFAULT 'active',
  cycle_start TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

说明：

- `role`: `employee` 或 `admin`
- `status`: `active` 或 `disabled`
- `cycle_start`: 当前工资周期开始时间

## user_states

保存用户当前流程状态。

```sql
CREATE TABLE user_states (
  telegram_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
```

常见状态：

```text
WAIT_INCOME_AMOUNT
WAIT_INCOME_FINE
WAIT_REJECT_REASON
```

## pending_income

保存待审批收入。

```sql
CREATE TABLE pending_income (
  request_id TEXT PRIMARY KEY,
  telegram_id TEXT NOT NULL,
  income REAL NOT NULL,
  fine REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  submitted_at TEXT NOT NULL,
  decided_at TEXT,
  admin_id TEXT,
  reject_reason TEXT
);
```

状态：

```text
pending
approved
rejected
```

## income_records

保存已批准收入。

```sql
CREATE TABLE income_records (
  record_id TEXT PRIMARY KEY,
  telegram_id TEXT NOT NULL,
  income REAL NOT NULL,
  fine REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',
  request_id TEXT,
  approved_at TEXT NOT NULL,
  admin_id TEXT NOT NULL
);
```

## admin_audit_logs

保存管理员操作。

```sql
CREATE TABLE admin_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
```

## bot_logs

保存机器人收发和错误日志。

```sql
CREATE TABLE bot_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL,
  event TEXT NOT NULL,
  telegram_id TEXT,
  message_text TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL
);
```

`level` 可用：

```text
debug
info
warn
error
```

## settings

保存少量系统配置。

```sql
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

示例：

```text
currency = $
timezone = Asia/Tokyo
```

