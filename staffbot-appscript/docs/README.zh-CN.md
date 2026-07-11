# Telegram 员工管理 Bot 工程说明

这个项目是一个基于 Google Apps Script 和 Google Sheet 的 Telegram 员工管理机器人。

## 一句话说明

- Telegram 是员工和管理员使用的界面。
- Google Apps Script 是后端程序，负责处理消息、审批、计算和写数据。
- Google Sheet 是数据库，保存员工、收入、工资、考勤、配置和错误日志。

## 核心功能

1. 员工首次使用时选择语言：中文、英文、越南语。
2. 员工提交收入和罚款。
3. 管理员在 Telegram 里批准或驳回收入。
4. 员工查看当前工资周期的总收入。
5. 员工申请发工资。
6. 管理员批准工资后，系统重置该员工的新工资周期。
7. 员工分享当前位置后签到或签退。
8. 迟到、早退会按配置自动产生罚款。
9. 管理员操作会写入审计日志。
10. 程序错误会写入错误日志。

## 目录结构

```text
staffbot-appscript/
  README.md
  appsscript.json
  Config.gs
  I18n.gs
  Utils.gs
  Telegram.gs
  Db.gs
  Main.gs
  Income.gs
  Stats.gs
  Salary.gs
  Attendance.gs
  Setup.gs
  docs/
    README.zh-CN.md
    ARCHITECTURE.md
    DEPLOYMENT.md
    CONFIGURATION.md
    DATA_MODEL.md
    OPERATIONS.md
    SECURITY.md
```

## 代码模块说明

| 文件 | 作用 |
| --- | --- |
| `Main.gs` | Telegram webhook 入口，负责分发消息和按钮事件 |
| `Config.gs` | 读取脚本属性、系统设置、管理员列表 |
| `Db.gs` | 读写 Google Sheet，自动注册员工 |
| `Telegram.gs` | 调用 Telegram API，发送消息和按钮 |
| `I18n.gs` | 三语言文案字典 |
| `Income.gs` | 收入提交、批准、驳回 |
| `Stats.gs` | 计算当前周期总收入 |
| `Salary.gs` | 工资申请、批准、驳回、周期重置 |
| `Attendance.gs` | 位置打卡、迟到早退罚款 |
| `Setup.gs` | 初始化表格、设置 webhook、备份表格 |
| `Utils.gs` | 时间、金额、状态、日志等通用工具 |

## 部署时必须准备的东西

| 名称 | 从哪里拿 |
| --- | --- |
| `BOT_TOKEN` | Telegram 的 `@BotFather` |
| 管理员 Telegram ID | Telegram 的 `@userinfobot` |
| `SHEET_ID` | Google Sheet URL 中间那串 ID |
| `WEBHOOK_SECRET` | 自己生成一串随机字符 |
| `WEBAPP_URL` | Apps Script 部署 Web App 后生成 |

## 部署顺序

1. 创建 Telegram Bot，拿 `BOT_TOKEN`。
2. 创建 Google Sheet，拿 `SHEET_ID`。
3. 创建 Google Apps Script 项目。
4. 把本目录下所有 `.gs` 文件和 `appsscript.json` 放进 Apps Script。
5. 在 Apps Script 项目设置里填写脚本属性：
   - `BOT_TOKEN`
   - `WEBHOOK_SECRET`
   - `SHEET_ID`
   - `WEBAPP_URL` 先留空
6. 运行 `setupSheets()`，让程序自动创建数据表。
7. 在 Google Sheet 的 `Settings` 表里填写 `ADMIN_IDS`。
8. 把 Apps Script 部署成 Web App，访问权限选择任何人。
9. 把生成的 Web App URL 填回脚本属性 `WEBAPP_URL`。
10. 运行 `setWebhook()`。
11. 在 Telegram 里给机器人发送 `/start` 测试。

详细部署文档见：[DEPLOYMENT.md](DEPLOYMENT.md)

## Google Sheet 数据表

| 表名 | 用途 |
| --- | --- |
| `Employees` | 员工资料、状态、语言、工资周期开始时间 |
| `Pending_Income` | 待审批收入 |
| `Income_Records` | 已批准收入和系统罚款 |
| `Rejected_Income` | 被驳回的收入 |
| `Salary_Requests` | 工资申请 |
| `Salary_History` | 已批准发薪记录 |
| `Attendance` | 签到、签退、位置和罚款 |
| `Admin_Audit_Log` | 管理员操作审计 |
| `Settings` | 系统配置 |
| `Error_Log` | 错误日志 |

详细表结构见：[DATA_MODEL.md](DATA_MODEL.md)

## 日常维护

常用函数：

| 函数 | 作用 |
| --- | --- |
| `setupSheets()` | 初始化 Google Sheet |
| `setWebhook()` | 绑定 Telegram webhook |
| `getWebhookInfo()` | 查看 webhook 状态 |
| `deleteWebhook()` | 删除 webhook |
| `backupSpreadsheet()` | 备份 Google Sheet |

运维说明见：[OPERATIONS.md](OPERATIONS.md)

## 安全注意事项

- 不要把真实 `BOT_TOKEN` 发给无关人员。
- 不要把真实密钥写进代码文件。
- Google Sheet 里有员工位置和工资数据，不要公开共享。
- Web App 必须允许 Telegram 访问，所以 `WEBHOOK_SECRET` 很重要。
- 管理员权限由 `Settings.ADMIN_IDS` 控制。

更多说明见：[SECURITY.md](SECURITY.md)
