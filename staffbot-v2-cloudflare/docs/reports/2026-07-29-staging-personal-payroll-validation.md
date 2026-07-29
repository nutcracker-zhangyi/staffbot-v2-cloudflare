# Staging 个人发薪流程验收记录

日期：2026-07-29
结果：**部分通过——代码、迁移、自动化测试和管理后台已验证；真实消息、邮件与 Cron 闭环待授权**

## 范围和安全边界

- 验证分支：`codex/staging-environment`
- staging Worker：
  `https://staffbot-v2-staging.staffbot-v2.workers.dev`
- staging Worker 版本：
  `cf0beccf-fdd4-43cb-8c23-df13ab7b9e9e`
- 所有部署和 D1 操作均明确使用 `--env staging`。
- production 未迁移、未部署、未改配置。
- `SCHEDULED_TASKS_ENABLED=false`，未启用 staging Cron。
- 未配置 Email Sending binding、发件地址或财务收件地址。
- 未创建测试店铺或测试员工，也未修改现有员工的工资起始日。

## 已部署范围

- 员工按店铺时区选择工资起始日，登记当天至未来 5 天均可选，
  且不受请假凌晨 5 点限制。
- 按每名员工的起始日持续计算周期第 16 天和第 30 天。
- 发薪日店铺当地时间 12:00 生成固定工资快照，区间为
  `[period_start, cutoff_at)`。
- 新周期在快照生成后立即独立累计，不等待管理员付款或员工确认。
- 支持银行卡、USDT 和现金拆分，多张私有 R2 付款凭证，
  员工确认或提出争议。
- 确认后生成一次性工资记录和独立邮件 outbox；邮件失败不回滚确认。
- 管理后台可查看自动工资、详情、付款拆分及凭证；旧工资申请和记录
  保留并明确标记为历史数据。
- 员工菜单已移除旧“申请工资”入口。

## 自动化发布门禁

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 通过 |
| `npm test` | 285 通过，0 失败 |
| `npm run test:ledger` | 22 通过，0 失败 |
| `npm run test:staging` | 7 通过，0 失败 |
| `git diff --check` | 通过 |

## Staging 数据库验证

远程 staging D1 仅应用了待执行迁移
`021_personal_payroll_cycle.sql`。再次检查时没有待执行迁移。

以下新表均存在：

- `payroll_disbursements`
- `payroll_email_outbox`
- `payroll_payment_profiles`
- `payroll_payment_proofs`

现有 staging 数据检查结果：

| 项目 | 数量 |
| --- | ---: |
| 现有员工关系 | 14 |
| 尚未设置工资起始日 | 14 |
| 尚未启用自动工资日期 | 14 |

因此迁移没有自动开启任何现有员工的发薪计划，也没有产生自动工资记录。

## 已登录管理后台验收

使用现有已登录管理员会话刷新 staging 管理后台后，工资页面显示：

- “自动工资”表格正常加载；
- 自动工资共 0 条，与所有现有员工尚未设置工资起始日一致；
- “旧工资申请（历史）”正常显示现有待处理历史记录；
- “工资记录（历史）”正常显示现有已批准历史记录；
- 新旧工资数据没有混为同一类记录。

公开健康检查返回 staging 服务正常，管理后台 HTML 包含 staging 环境标识。

## 尚未执行的真实闭环

以下项目不是失败，而是仍缺少明确授权或必要配置：

1. 选择一名现有 staging 员工，设置工资起始日并加入受控流水，
   验证 Telegram 提醒、付款拆分、多图凭证、确认及争议闭环。
2. 提供经过 Cloudflare Email Service 验证的发件地址，以及固定财务收件地址，
   再验证真实邮件发送和失败重试。
3. 单独批准后临时启用 staging Cron，验证定时触发；验收后必须立即恢复关闭。

在以上三项完成、结果写回本记录并获得 production 上线批准前，
Phase 10 保持 `🧪`。
