# 系统架构

## 当前状态

系统已完成两项基础改造：

1. 模块化重构已经完成，主要业务不再集中在单一 Worker 文件中。
2. 统一工资账本已在 staging 完成迁移、历史回填、双写、影子对账和账本读取验证。

production 目前尚未切换到统一账本读取。production 切换、dashboard 和员工个人发薪流程都是后续独立评审的阶段。

## 整体结构

```text
Telegram / Admin Web
        |
        v
Cloudflare Worker 路由与鉴权
        |
        +--> 申请与审批模块
        |      |
        |      +--> 旧兼容写入 income_records
        |      +--> 新账本写入 payroll_entries
        |
        +--> payroll.js
        |      |
        |      +--> legacy 旧表计算
        |      +--> shadow 双路径对账
        |      +--> ledger 账本计算
        |
        +--> salary_records / store_members.cycle_start
        |
        +--> admin_audit_logs / bot_logs
```

## 模块职责

| 模块 | 主要职责 |
| --- | --- |
| `src/index.js` | Wrangler 和既有测试的兼容入口 |
| `src/router.js` | Worker 请求入口、鉴权前置检查和路由调度 |
| `src/telegram.js` | Telegram 会话状态和员工交互流程 |
| `src/telegram-client.js` | Telegram HTTP 发送和 staging 收件人隔离 |
| `src/admin-api.js` | 管理员 API、查询和操作路由 |
| `src/admin-page.js` | 管理员页面 HTML、CSS 和浏览器端交互 |
| `src/approvals.js` | 收入、罚款、预支和工资审批状态转换 |
| `src/payroll-ledger.js` | 账本转换、写入、查询、冲正和幂等契约 |
| `src/payroll.js` | 工资周期聚合及读模式切换 |
| `src/absence.js` | 缺勤扫描和通知生命周期 |
| `src/stores.js` | 店铺、成员和管理员权限查询 |
| `src/audit.js` | 管理审计和运行日志 |

申请表负责工作流状态，`payroll_entries` 负责已生效金额，
`salary_records` 负责实际付款结果。模块之间不得用申请金额代替账本事实，也不得用账本余额代替付款历史。

## 统一工资账本

工资计算的目标公式是：

```text
payable = SUM(payroll_entries.amount_micros)
```

查询必须按店铺、员工和左闭右开时间区间过滤。金额以整数 micros 保存，不再把多个 `REAL` 字段在查询时临时组合为权威结果。

账本是追加式结构：

- 正常业务只新增事实；
- 已生效记录不直接更新或删除；
- 错误通过反向 `reversal` 记录纠正；
- 同一来源通过唯一键保证幂等；
- 业务写入、兼容写入和审批状态更新在同一原子批次内完成。

详细字段和约束见 [DATA_MODEL.md](./DATA_MODEL.md)。

## 写入模式

环境变量 `PAYROLL_LEDGER_WRITE_MODE` 只有两个有效值：

| 值 | 行为 |
| --- | --- |
| `off` | 只执行旧兼容写入，不创建新账本记录 |
| `dual` | 在同一原子操作中同时写入旧兼容表和 `payroll_entries` |

双写不能退化成“旧表成功、账本失败但仍批准”。任一必要写入失败时，整个业务操作必须失败，避免两个来源产生无法解释的差异。

无效写入模式不能在更正等破坏性路径中静默回退，因为这可能造成只改旧表而没有对应账本轨迹。

## 读取模式

环境变量 `PAYROLL_LEDGER_READ_MODE` 有三个有效值：

| 值 | 返回结果 | 额外行为 |
| --- | --- | --- |
| `legacy` | 旧 `income_records` 计算结果 | 无 |
| `shadow` | 旧计算结果 | 同时计算账本结果；不一致时记录 `payroll_shadow_mismatch` |
| `ledger` | `payroll_entries.amount_micros` 求和结果 | 旧表不参与返回金额 |

`shadow` 模式故意返回旧结果，使 staging 可以先观察差异而不改变用户看到的工资。无效读取模式记录配置错误并回退到 `legacy`，确保只读故障不会直接阻断现有工资查询。

## 来源权威性

来源权威性取决于当前读取模式：

| 阶段 | 权威工资金额 | 旧表角色 |
| --- | --- | --- |
| `legacy` / `shadow` | `income_records` | 当前读取来源 |
| `ledger` | `payroll_entries.amount_micros` | 兼容、回滚和审计 |

申请表从来不是已生效工资金额的权威来源。`salary_records` 也不是工资收入账本；它记录实际支付了多少以及支付覆盖的周期。

## 发布顺序

推荐环境切换顺序：

```text
off + legacy
    -> dual + legacy
    -> dual + shadow
    -> dual + ledger
```

每一步都必须先确认：

- 数据库迁移已经应用；
- 历史回填可重复执行且第二次写入为零；
- 旧路径与账本路径对账无差异；
- 双写审批具备幂等性；
- 类型检查和全量测试通过。

staging 已完成以上验证，目前运行于 `dual + ledger`。这只是 staging 证据，不代表 production 已经切换。

## 回滚语义

### 读取回滚

从 `ledger` 回滚读取只需把 `PAYROLL_LEDGER_READ_MODE` 改为
`legacy`。不需要删除或修改任何账本记录。

### 写入回滚

把 `PAYROLL_LEDGER_WRITE_MODE` 从 `dual` 改为 `off` 后，新业务停止写入账本，但已有 `payroll_entries` 必须完整保留。

写入回滚不会“撤销”历史账本，也不会删除迁移或回填结果。以后重新启用双写时，来源唯一键负责阻止重复记录；重新切回账本读取前必须再次对账。

## 工资周期和付款边界

- `store_members.cycle_start` 决定员工在某店铺的当前工资周期起点。
- 工资计算区间统一为 `[period_start, period_end)`。
- 管理员批准工资时，付款金额及区间写入 `salary_records`。
- 同一事务把 `cycle_start` 推进到 `period_end`。
- 工资预支只新增负数 `advance` 账本事实，不推进工资周期。

因此“账本里产生了多少钱”和“管理员实际支付了多少钱”始终可以分别审计。

## 可观察性与审计

- 影子读取不一致时记录 `payroll_shadow_mismatch`。
- 管理员冲正记录 `reverse_payroll_entry` 审计事件。
- 双写、迁移、回填和对账失败必须保留结构化日志。
- 不在日志中保存敏感凭据或完整支付证明文件内容。

## staging 验证证据

本次统一账本 staging 验证记录见：

[2026-07-28 staging payroll ledger migration report](./reports/2026-07-28-staging-payroll-ledger-migration.md)

该报告包括迁移预检、历史回填、重复执行、对账、影子读取、双写审批、账本读取和回滚演练结果。

## 后续架构边界

下面两项不包含在本次账本改造中：

- dashboard：只读取经过评审的数据接口，不改变账本写入契约；
- 员工个人发薪流程：需要单独确认提醒、截止点、付款确认和凭证存储流程。

它们必须分别形成计划、测试和发布方案后再实施。
