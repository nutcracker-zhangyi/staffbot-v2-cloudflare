# StaffBot V2 - Cloudflare 方案

这是重新设计后的 Telegram 员工管理机器人方案。

旧版 Google Apps Script + Google Sheet 先不再继续维护。V2 目标是：

- 免费工具优先
- 长期稳定运行
- 容易维护和排错
- 后续可以扩展管理员后台、多语言、考勤、工资等功能

## 推荐技术栈

```text
Telegram Bot
  -> Cloudflare Worker
  -> Cloudflare D1 SQLite Database
```

后续如果需要网页后台：

```text
Cloudflare Pages
  -> Cloudflare Worker API
  -> Cloudflare D1
```

## 为什么不用 Google Apps Script

旧方案的问题：

- 部署版本容易混乱
- Webhook 可能遇到跳转、授权、版本不一致
- 业务状态藏在 CacheService，不方便排查
- Google Sheet 适合看数据，但不适合做严肃业务数据库
- 多文件脚本复制粘贴容易漏文件

## 为什么选择 Cloudflare Workers + D1

- Worker 是真正的 HTTP 服务，适合 Telegram webhook
- D1 是 SQL 数据库，表结构清楚
- 免费额度对小团队 Telegram Bot 足够
- 没有传统服务器维护压力
- 日志、部署、回滚比 Apps Script 清楚
- 以后可以继续扩展 Web 管理后台

## 第一版只做核心功能

第一版不要贪多，只做稳定闭环：

- `/start` 显示帮助
- `/ping` 测试机器人在线
- `/income` 员工提交收入
- 管理员批准/驳回收入
- `/total` 查看当前周期总收入
- `/cancel` 取消当前流程
- 所有消息和错误写入日志表

暂不做：

- 多语言
- 考勤定位
- 工资申请
- 复杂菜单
- 网页后台

这些放到第二、第三阶段。

## 文档

- [架构设计](docs/ARCHITECTURE.md)
- [数据模型](docs/DATA_MODEL.md)
- [功能路线图](docs/ROADMAP.md)
- [部署规划](docs/DEPLOYMENT_PLAN.md)
- [运维和排错](docs/OPERATIONS.md)
- [构建和测试](docs/BUILD_AND_TEST.md)
- [小白部署和测试手册](docs/BEGINNER_DEPLOY_ZH.md)
- [旧版功能补齐清单](docs/FEATURE_COMPLETION_ZH.md)

## 当前代码状态

已经实现 Phase 1 的最小可用版本：

- Cloudflare Worker webhook 入口
- Telegram `sendMessage` / `answerCallbackQuery` / `editMessageText`
- `/start`
- `/ping`
- `/cancel`
- `/income`
- `/total`
- `/salary`
- `/attendance`
- `/lang`
- 收入提交状态机
- 管理员批准/驳回收入
- 工资申请和审批
- 位置签到/签退
- 迟到/早退罚款
- 中文/英文/越南语
- D1 数据库 schema
- Bot 日志和管理员审计日志

入口文件：

```text
src/index.js
```

数据库表：

```text
db/schema.sql
```
