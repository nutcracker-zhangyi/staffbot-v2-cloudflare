# 数据模型

本项目使用 Cloudflare D1（SQLite）。`db/schema.sql` 和 `db/migrations/` 是数据库结构的最终依据；本文说明工资相关数据的职责边界和计算契约。

当前状态：

- staging 已完成统一工资账本迁移、回填、对账和 `ledger` 读取验证。
- production 仍使用旧读取路径；切换 production 必须单独审批和执行。

## 三层工资数据模型

工资相关记录分为三个层次，不能互相替代：

| 层次 | 主要表 | 作用 | 是否直接参与工资求和 |
| --- | --- | --- | --- |
| 申请与审批 | `pending_income`、`salary_advance_requests`、`salary_requests`、`absence_fine_requests` 等 | 保存待处理请求、审批状态和审批上下文 | 否 |
| 工资事实账本 | `payroll_entries` | 保存已经生效的收入、罚款、预支和更正 | 是 |
| 发薪结果 | `salary_records`、`store_members.cycle_start` | 保存实际付款历史和下一工资周期起点 | 否 |

`income_records` 是旧系统的兼容与审计数据。启用
`PAYROLL_LEDGER_READ_MODE=ledger` 后，工资计算只读取
`payroll_entries.amount_micros`；旧表不再是工资金额的权威来源。

## 店铺与员工关系

- `stores` 保存店铺、时区、币种及店铺级设置。
- `users` 保存 Telegram 用户的全局身份。
- `store_members` 保存员工在某个店铺的成员关系。
- `store_members.cycle_start` 是该员工在该店铺当前工资周期的开始时间。

工资必须按 `store_id + telegram_id` 隔离。不同店铺或不同币种的金额不能直接合并。

## payroll_entries

`payroll_entries` 是不可变的工资事实账本。每一行只表达一个已经生效的金额变化。

| 字段 | 约束 | 含义 |
| --- | --- | --- |
| `entry_id` | 主键、非空字符串 | 账本记录唯一 ID |
| `store_id` | 非空字符串 | 所属店铺 |
| `telegram_id` | 非空字符串 | 所属员工 |
| `type` | 枚举 | 金额类别 |
| `amount_micros` | 非零整数 | 已带正负号的最终金额，单位为百万分之一 |
| `currency` | 非空字符串 | 记账时的币种快照 |
| `effective_at` | 非空 ISO 时间 | 该金额进入工资计算的业务时间 |
| `source` | 非空字符串 | 来源流程，例如手工收入或工资预支 |
| `source_id` | 可空；非空时不能是空字符串 | 来源请求或旧记录 ID，用于幂等 |
| `created_by` | 非空字符串 | 创建该事实的操作者或系统身份 |
| `created_at` | 非空 ISO 时间 | 账本行实际写入时间 |
| `reverses_entry_id` | 仅 `reversal` 必填 | 被冲正的原账本记录 |
| `metadata_json` | 有效 JSON，默认 `{}` | 非金额型补充上下文 |

### 类型与正负号

`amount_micros` 已经包含业务方向。工资计算只需在指定区间内求和，不再根据不同金额字段做减法。

| `type` | 符号 | 作用 |
| --- | ---: | --- |
| `income` | 正数 | 收入 |
| `bonus` | 正数 | 奖金 |
| `fine` | 负数 | 罚款 |
| `advance` | 负数 | 工资预支 |
| `negative_carry` | 负数 | 负数结余结转 |
| `adjustment` | 正数或负数 | 经授权的人工调整 |
| `reversal` | 正数或负数 | 原记录的精确反向金额 |

数据库约束禁止：

- 金额为 `0`；
- 收入或奖金为负数；
- 罚款、预支或负数结转为正数；
- 非冲正记录填写 `reverses_entry_id`；
- 冲正记录不填写 `reverses_entry_id`。

### 金额精度

账本不使用 SQLite `REAL` 保存权威金额。业务金额先转换为整数：

```text
amount_micros = round(amount × 1,000,000)
```

示例：

```text
12.50  ->  12,500,000
-3.25  ->  -3,250,000
```

转换结果必须是 JavaScript 安全整数。展示时再除以 `1,000,000`，数据库计算始终对整数求和。

### 来源唯一性与幂等

非冲正记录使用 `(source, source_id)` 唯一索引：

- 同一个审批来源重复执行时，不能产生第二份相同账本事实。
- 历史回填使用旧 `income_records.record_id` 作为 `source_id`。
- 实时双写优先使用请求 ID；没有请求 ID 时使用旧记录 ID。
- `source_id` 为空时不参与该唯一约束。

冲正记录不复用来源唯一索引，而是通过 `reverses_entry_id` 的唯一索引保证一条原记录最多被冲正一次。

### 冲正与更正

账本记录生效后不直接编辑或删除。发现错误时：

1. 新建一条 `type=reversal` 的记录；
2. `amount_micros` 必须等于原记录金额的相反数；
3. 店铺、员工和币种必须与原记录一致；
4. `reverses_entry_id` 指向原记录；
5. 如需写入正确金额，可在同一原子事务中再创建一条替代记录；
6. 管理员审计日志记录 `reverse_payroll_entry`。

这样可以保留原始事实、纠错事实和操作者的完整轨迹。

### 时间区间语义

所有工资区间统一使用左闭右开：

```text
effective_at >= period_start
AND effective_at < period_end
```

这等价于 `[period_start, period_end)`，可以避免相邻工资周期在边界时刻重复计算。

- 当前未结算工资从 `store_members.cycle_start` 开始计算。
- 工资批准时，把本次 `period_start`、`period_end` 和实际支付金额写入 `salary_records`。
- 同一事务随后把 `store_members.cycle_start` 推进到本次 `period_end`。

`effective_at` 是参与工资区间计算的时间；`created_at` 只是记录何时写入账本。历史回填时，两者通常不同。

## 旧 income_records 的兼容规则

旧表分别保存浮点金额字段。迁移到统一账本时按下列规则映射：

| 旧记录含义 | 旧字段 | 新账本 |
| --- | --- | --- |
| 收入 | `commission_income` | `type=income`，正数 `amount_micros` |
| 罚款 | `fine` | `type=fine`，负数 `amount_micros` |
| 工资预支 | `fine` | `type=advance`，负数 `amount_micros` |

同一份旧批准记录可能拆成一条收入账本和一条罚款账本。旧记录仍保留，供兼容、回滚和审计使用。

如果旧记录的收入或罚款换算后为 `0`，该部分不创建账本行，因为
`payroll_entries` 禁止零金额。零影响旧记录不会被删除，也不会改变对账总额。

## 申请、账本与付款的区别

### 收入和罚款申请

`pending_income` 等申请表保存“有人提出了什么请求”。只有审批成功后，业务金额才进入：

- 旧兼容表 `income_records`（双写阶段）；
- 新事实表 `payroll_entries`。

待审批或被拒绝的申请不能参与工资计算。

### 工资预支

`salary_advance_requests` 保存预支审批流程。审批成功后创建负数
`type=advance` 账本记录，但不会推进 `cycle_start`，因为预支不是一次完整发薪。

### 工资申请与实际付款

- `salary_requests` 保存员工提出的工资请求、当时的金额快照及处理状态。
- `salary_records` 保存管理员实际批准的付款金额和对应周期。
- `payroll_entries` 保存付款前用于计算应付工资的收入和扣款。

工资付款本身当前不会再写成一条负数工资账本记录；已经付款的区间由
`salary_records` 和推进后的 `cycle_start` 共同界定。

## 其他相关表

| 表 | 作用 |
| --- | --- |
| `attendance_records` | 上下班记录 |
| `pending_checkout_requests` | 待审批下班请求 |
| `leave_requests` | 请假申请 |
| `absence_fine_requests` | 缺勤罚款申请 |
| `absence_fine_notifications` | 缺勤罚款通知状态 |
| `admin_audit_logs` | 管理员操作审计 |
| `bot_logs` | 机器人事件、警告和错误日志 |
| `user_states` / `user_preferences` | Telegram 会话状态和偏好 |

这些表可以触发工资事件或提供审计上下文，但不能代替
`payroll_entries.amount_micros` 作为账本金额。
