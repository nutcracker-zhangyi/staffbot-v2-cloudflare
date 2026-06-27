# 旧版功能补齐清单

本文档记录从 Google Apps Script 旧版迁移到 Cloudflare V2 后，第一轮缺失功能和当前实现状态。

## 已有基础功能

- `/start`
- `/ping`
- `/cancel`
- `/income`
- `/total`
- 员工提交收入
- 管理员批准收入
- 数据库状态管理
- 日志记录

## 旧版缺失功能和当前状态

| 旧版功能 | V2 当前状态 |
| --- | --- |
| 三语言中文/英文/越南语 | 已实现 |
| `/lang` 切换语言 | 已实现 |
| Telegram 主菜单按钮 | 已实现 |
| 收入提交 | 已实现 |
| 管理员批准收入 | 已实现 |
| 管理员驳回收入并输入原因 | 已实现 |
| 总收入统计 | 已实现 |
| 工资申请 | 已实现 |
| 管理员批准工资 | 已实现 |
| 管理员驳回工资并输入原因 | 已实现 |
| 工资批准后重置工资周期 | 已实现 |
| 工资历史记录 | 已实现 |
| 位置打卡 | 已实现 |
| 签到 | 已实现 |
| 签退 | 已实现 |
| 迟到罚款 | 已实现 |
| 早退罚款 | 已实现 |
| 管理员操作审计 | 已实现 |
| 错误和调试日志 | 已实现 |

## 新增数据库表

这次补齐功能新增了这些表：

```text
user_preferences
salary_requests
salary_records
attendance_records
```

## 新增配置项

在 `wrangler.toml` 的 `[vars]` 里可以配置：

```toml
CURRENCY = "$"
TIMEZONE = "Asia/Tokyo"
CHECKIN_TIME = "18:30"
CHECKOUT_TIME = "01:30"
LATE_FINE = "0.5"
EARLY_LEAVE_FINE = "1.5"
```

## 升级部署步骤

进入项目目录：

```text
cd /Users/nutcrackermacbookair/Documents/telegram/staffbot-v2-cloudflare
```

更新远程数据库表：

```text
wrangler d1 execute staffbot_v2 --remote --file db/schema.sql
```

部署新版 Worker：

```text
wrangler deploy
```

重新设置 webhook：

```text
curl "https://api.telegram.org/bot你的BOT_TOKEN/setWebhook?url=https://staffbot-v2.staffbot-v2.workers.dev/webhook/你的WEBHOOK_SECRET&drop_pending_updates=true"
```

## 测试顺序

### 1. 基础测试

```text
/ping
/start
/lang
```

### 2. 收入测试

```text
/income
2000
0
```

管理员点击批准后：

```text
/total
```

### 3. 工资测试

```text
/salary
```

管理员点击批准后，再发：

```text
/total
```

总收入应该进入新周期。

### 4. 考勤测试

```text
/attendance
```

然后分享当前位置，再点击签到或签退。

## 当前暂未实现

网页管理员后台还没有实现。

原因：Telegram 内审批已经可用，网页后台适合下一阶段单独做。
