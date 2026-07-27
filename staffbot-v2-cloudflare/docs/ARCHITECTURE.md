# StaffBot V2 架构

## 当前阶段

本文件记录模块化重构完成后的实际结构。当前阶段只拆分代码所有权，
不改变业务规则、数据库结构、API 响应、Telegram 文案或回调数据。

> The source of truth is still income_records during this phase.
> payroll_entries and amount_micros begin only in the next approved phase.

统一账本、金额整数化、个人第 16/30 天发薪流程、付款凭证和 Dashboard
仍属于下一阶段，必须在本阶段 staging 验收通过并获得批准后才能开始。

## 运行结构

```text
Telegram / Admin Browser / Cron
               |
               v
           router.js
        /       |       \
telegram.js  admin-api.js  absence.js
     |            |           |
     +------------+-----------+
                  |
       approvals.js / payroll.js
                  |
             Cloudflare D1
```

`src/index.js` 仅作为 Wrangler 和既有测试的兼容入口，默认导出
`router.js`，并重新导出既有公共函数。业务代码不得重新写回入口文件。

## 模块所有权

| Module | Owns | Must not own |
| --- | --- | --- |
| router.js | Worker entrypoints and dispatch | business calculations |
| telegram.js | bot state and interaction flow | raw admin HTML |
| telegram-client.js | Telegram HTTP delivery and staging fence | business decisions |
| admin-api.js | authenticated admin routes | browser rendering logic |
| admin-page.js | admin HTML/CSS/JS | payroll SQL |
| approvals.js | existing approval state transitions | Telegram copy |
| payroll.js | current payroll queries | payment UI |
| absence.js | absence scan and delivery lifecycle | general admin routing |
| money.js | pure legacy money calculations | D1 access |
| dates.js | pure timezone/date calculations | D1 access |

辅助模块：

| Module | Responsibility |
| --- | --- |
| `admin-query.js` | 后台分页、排序白名单、筛选和 CSV 纯辅助逻辑 |
| `audit.js` | 审计、运行日志、ID 和时间戳 |
| `http.js` | JSON、HTML、CSV 响应与会话 Cookie |
| `security.js` | 环境识别、管理员和 staging 安全策略 |
| `stores.js` | 店铺、成员和管理员权限查询 |
| `i18n.js` | Telegram 与后台共用的多语言文本 |
| `validation.js` | 无数据库访问的输入规范化 |
| `constants.js` | 跨模块常量 |

## 允许的依赖方向

```text
index.js
  -> router.js and compatibility exports

router.js
  -> telegram.js / admin-api.js / admin-page.js / absence.js

interaction modules
  -> approvals.js / payroll.js / stores.js / telegram-client.js

business and query modules
  -> money.js / dates.js / validation.js / audit.js / constants.js
```

约束：

- 所有模块不得导入 `index.js`。
- `router.js` 只负责路由、鉴权前置检查和调度，不计算工资。
- `admin-page.js` 不直接访问 D1，也不包含后台 API SQL。
- `telegram-client.js` 只负责发送和 staging 收件人隔离，不决定业务结果。
- `money.js`、`dates.js` 和 `validation.js` 保持纯函数，不访问 D1。
- 数据写入和审批状态转换集中在所有者模块，页面与路由不得复制实现。

## 当前数据边界

- 工资统计的当前事实来源仍是 `income_records`。
- 收入、罚款和预支仍遵循现有字段与计算语义。
- `salary_records` 保存现有工资审批快照。
- 本阶段没有 `payroll_entries`，也没有 `amount_micros`。
- 本阶段不执行历史财务迁移或对账。

## 验证命令

本地完整门禁：

```bash
for file in src/*.js; do node --check "$file"; done
npm run check
npm test
git diff --check
```

只允许部署 staging：

```bash
npx wrangler deploy --env staging
```

禁止在本阶段执行不带 `--env staging` 的部署命令。production Worker、D1、
Telegram bot 和 Cron 必须保持不变。详细步骤见
[`STAGING_RUNBOOK.md`](./STAGING_RUNBOOK.md)。

## 下一阶段交接门槛

只有以下条件全部满足后，才能申请开始统一账本阶段：

1. 所有既有测试与模块边界测试通过。
2. `src/index.js` 保持为少于 120 行的兼容入口。
3. staging Worker 成功运行当前提交。
4. staging Telegram 只向允许名单发送消息。
5. staging Cron 保持禁用。
6. production 健康检查与部署前一致。
7. 用户明确批准开始 `payroll_entries` 和 `amount_micros` 阶段。
