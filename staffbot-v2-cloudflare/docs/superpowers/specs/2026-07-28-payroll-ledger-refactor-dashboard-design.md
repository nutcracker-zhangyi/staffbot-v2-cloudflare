# StaffBot 模块化重构、统一工资账本与数据看板设计

## 目标

在不改变已经确认的员工、收入、罚款、预支、考勤、请假和个人发薪业务规则的前提下，完成三项改进：

1. 把当前集中在 `src/index.js` 的 Worker、Telegram、工资、后台和页面代码拆成职责清楚的模块。
2. 把所有已经生效、会参与工资计算的资金流水统一保存到一张账本表，并使用同一个带正负号的金额字段。
3. 在管理后台增加数据看板，通过后端全量聚合展示每月、每名员工的收入、罚款、预支和工资净额。

本设计是后续个人 30 天工资周期功能的基础。实施顺序必须是：

```text
隔离测试环境
→ 当前行为回归测试
→ 行为不变的模块化重构
→ 统一工资账本与历史迁移
→ 数据看板
→ 个人 30 天自动发薪
```

## 当前系统基线

截至 2026-07-28：

- GitHub `main` 最新业务代码为 `45685d3`。
- 本地 `main` 比 GitHub 多一份已确认的个人发薪设计文档，没有未提交的业务代码。
- `src/index.js` 约 5,255 行。
- Worker 路由、Telegram 状态机、业务规则、SQL、后台 API、后台 HTML/CSS/JavaScript 和多语言文本都在同一文件。
- 项目使用原生 JavaScript ES modules，不使用前端框架或构建工具。
- `npm run check` 和 108 个现有测试通过。
- `income_records` 已通过 `type` 区分 `income`、`fine` 和 `advance`，但工资影响金额分别保存在 `commission_income` 和 `fine`。
- 当前工资来源为：

```sql
SUM(commission_income - fine)
```

- 后台允许直接修改罚款记录和删除已生效资金记录。
- 收入、工资和预支审批没有统一达到缺勤审批已经具备的条件更新和并发胜出保护。
- 金额使用 SQLite `REAL`。
- 收入、工资和预支页面的顶部合计由浏览器对当前分页结果求和，超过一页时不能代表完整筛选范围。

## 范围

### 本次包含

- 建立 staging 后的模块化代码重构。
- 统一工资账本的数据模型、API 和读写服务。
- 历史 `income_records` 安全迁移和逐员工对账。
- 收入、罚款、预支、奖金、调整、冲销和负数结转的统一表示。
- 财务流水不可变和冲销机制。
- 收入、工资、预支审批的并发及幂等加固。
- Dashboard 后端聚合 API 和后台页面。
- 现有文档同步更新。
- 与个人 30 天工资周期设计的数据源衔接。

### 本次不包含

- 不在重构提交中改变业务规则。
- 不删除旧生产数据。
- 不把待审核申请、工资付款、凭证或邮件记录塞进统一资金账本。
- 不全面改写为 TypeScript。
- 不引入新的前端框架。
- 不把不同货币换算或合并。
- 不在本阶段改变已经确认的第 16 天、第 30 天和中午 12:00 截止规则。

## 方案选择

### 采用：不可变的工资影响账本

新增 `payroll_entries`，只保存已经生效、会进入工资计算的资金流水。所有类别都使用同一个带正负号的 `amount_micros` 字段。

待审核申请继续保存在各自申请表。申请通过后，审批与账本写入在同一个数据库批处理中完成。

优点：

- 工资计算只需要按员工和时间范围执行 `SUM(amount_micros)`。
- 新增类型不需要修改工资公式。
- 原始记录、冲销记录和操作者都可追溯。
- Dashboard 和自动工资共用一个资金事实来源。
- 可以通过唯一约束防止重复入账。

### 不采用：只给 `income_records` 增加一个 `amount`

这种方案改动较小，但会继续保留名称不准确、字段冗余、记录可修改删除、审批与入账耦合不清等问题。它只能缓解求和复杂度，不能建立可靠财务账本。

### 不采用：所有申请、流水、工资和付款放进一张大表

待审核申请和已生效资金的生命周期不同。工资付款、凭证和员工确认也不是工资收入流水。强行合并会产生大量可空字段、复杂状态组合和容易误算的查询。

### 暂不采用：完整事件溯源系统

所有状态都使用事件重建虽然审计能力强，但对当前规模过度复杂。不可变账本加状态表已经可以满足金额、工资、撤销和审计要求。

## 统一工资账本

### 表：`payroll_entries`

```sql
CREATE TABLE payroll_entries (
  entry_id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL,
  telegram_id TEXT NOT NULL,
  type TEXT NOT NULL,
  amount_micros INTEGER NOT NULL,
  currency TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  source TEXT NOT NULL,
  source_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reverses_entry_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
```

`amount_micros` 是唯一参与工资求和的金额字段，固定使用一百万分之一店铺货币单位：

```text
1₫       = 1,000,000 micros
$1.00    = 1,000,000 micros
$12.34   = 12,340,000 micros
```

这样不依赖各货币的小数位规则，也不使用浮点金额。写入前必须检查换算结果处于 JavaScript 安全整数和 SQLite 64 位整数范围内。

### 类型和符号

| `type` | 金额符号 | 说明 |
| --- | ---: | --- |
| `income` | 正数 | 员工最终提成收入 |
| `fine` | 负数 | 已生效罚款 |
| `advance` | 负数 | 已批准预支工资 |
| `bonus` | 正数 | 奖金 |
| `adjustment` | 正或负 | 管理员人工调整 |
| `reversal` | 与原记录相反 | 撤销或纠正已生效记录 |
| `negative_carry` | 负数 | 已关闭负工资段结转到下一段 |

`source` 进一步区分来源，例如：

- `manual_income`
- `attendance_late`
- `attendance_early`
- `attendance_absence`
- `salary_advance`
- `admin_adjustment`
- `payroll_negative_carry`

`type` 表示工资影响类别，`source` 表示业务来源。工资计算不得根据 `source` 分支。

### 约束和索引

至少建立：

```sql
CREATE INDEX idx_payroll_entries_employee_time
  ON payroll_entries (store_id, telegram_id, effective_at);

CREATE INDEX idx_payroll_entries_store_time_type
  ON payroll_entries (store_id, effective_at, type);

CREATE UNIQUE INDEX idx_payroll_entries_source
  ON payroll_entries (source, source_id)
  WHERE source_id IS NOT NULL AND type != 'reversal';

CREATE UNIQUE INDEX idx_payroll_entries_one_reversal
  ON payroll_entries (reverses_entry_id)
  WHERE reverses_entry_id IS NOT NULL;
```

应用层同时验证：

- `income`、`bonus` 必须大于 0。
- `fine`、`advance`、`negative_carry` 必须小于 0。
- `adjustment` 不得为 0。
- `reversal` 必须等于被冲销记录金额的相反数。
- `currency` 必须与写入时的店铺币种一致。
- `effective_at` 使用 ISO UTC 时间，业务日期按店铺时区解释。

### 工资查询

员工某个工资段的金额：

```sql
SELECT COALESCE(SUM(amount_micros), 0) AS total_micros
FROM payroll_entries
WHERE store_id = ?
  AND telegram_id = ?
  AND effective_at >= ?
  AND effective_at < ?;
```

时间范围统一使用左闭右开 `[period_start, cutoff_at)`：

- 截止点以前生效的记录进入本次工资。
- 等于截止点或以后生效的记录进入下一段。
- 不使用 `BETWEEN`，避免边界重复。

### 原始营业额和提成

`payroll_entries.amount_micros` 对 `income` 保存员工最终获得的提成金额，不保存顾客原始营业额。

原始营业额和提成率快照继续保存在收入申请记录中，用于：

- 管理员审核。
- Dashboard 展示营业额与员工提成的关系。
- 历史审计和解释。

工资公式只依赖最终账本金额。

### 不可变和冲销

已经写入 `payroll_entries` 的记录不得：

- 直接修改金额。
- 直接删除。
- 修改员工、店铺、类型或生效时间。

需要纠正时：

1. 写入一条 `reversal`，金额与原记录相反。
2. `reverses_entry_id` 指向原记录。
3. 如需正确的新金额，再写入一条新的正式流水。
4. 两个动作都记录管理员审计。

例如误罚 `-1,500,000`：

```text
fine      -1,500,000
reversal  +1,500,000
```

最终求和为 0，历史仍然完整。

## 请求、审批与账本边界

### 继续独立保存的申请

- 收入申请。
- 预支工资申请。
- 缺勤罚款申请。
- 待审批签退。
- 请假申请。

这些记录表达工作流状态，不是已经生效的工资金额。只有审批成功后才在账本生成流水。

新流程不再物理删除收入或预支申请。员工或管理员需要撤回时，把申请状态改为 `cancelled` 并记录原因和操作者；历史拒绝和取消记录继续保留。

### 审批原子性

所有资金审批必须使用相同模式：

1. 查询并验证申请属于目标店铺且状态为 `pending`。
2. 在同一数据库批处理中：
   - 使用 `WHERE status = 'pending'` 条件更新申请。
   - 插入具有唯一 `source + source_id` 的账本流水。
   - 插入管理员审计。
3. 检查条件更新影响行数必须为 1。
4. 只有唯一胜出者返回成功。
5. 重复点击或并发审批返回 `409 already_decided`，不得重复入账。

收入、预支和工资审批要达到现有缺勤审批的并发保护标准。

### 工资结算不是账本收入

工资付款是对一个工资段的结算，不应再次作为负数写入 `payroll_entries`，否则会把历史收入抵消并破坏月度收入统计。

工资结算继续保存在 `payroll_disbursements` 和 `salary_records`。新增关联表：

```text
payroll_disbursement_entries
```

保存每笔工资快照包含的 `entry_id`，用于审计和证明快照组成，但工资金额仍由固定时间范围求和得到。

### 负数工资结转

当工资段总额为负数：

1. 当前段保存为 `carried_negative`。
2. 当前段包含的流水关联到该结算记录。
3. 在固定截止点写入唯一的 `negative_carry` 流水，金额等于当前负数总额。
4. 新流水的 `effective_at` 等于固定截止点，因此进入下一工资段。
5. `source_id` 使用当前工资结算 ID，防止 Cron 重试重复结转。

这会替代个人发薪设计中把负数结转继续写入 `income_records.fine` 的旧描述。

## 历史数据迁移

### 映射规则

旧 `income_records` 按以下规则迁移：

| 旧记录 | 新 `type` | 新金额 |
| --- | --- | ---: |
| `type='income'` | `income` | `+commission_income` |
| `type='fine'` | `fine` | `-fine` |
| `type='advance'` | `advance` | `-fine` |
| 后续其他正调整 | `adjustment` | 正数 |
| 后续其他负调整 | `adjustment` | 负数 |

迁移遇到不在映射表内的未知 `type` 时必须停止并报告记录，不得猜测正负号或自动归入 `adjustment`。

迁移保留：

- 原 `record_id` 到 `source_id` 或迁移元数据。
- 店铺和员工。
- `approved_at` 到 `effective_at`。
- 原管理员。
- 原 `source`。
- 原始金额、提成率和罚款字段到 `metadata_json`，只用于审计，不参与求和。

### 迁移顺序

1. 只在 staging 创建新表和索引。
2. 导入生产数据库快照。
3. 执行一次性历史回填。
4. 先把旧表每一行的工资影响金额按六位小数转换为 micros，再对每个店铺、员工和工资周期比较：

```text
旧 SUM(ROUND((commission_income - fine) × 1,000,000))
新 SUM(amount_micros)
```

5. 使用整数进行精确比较并生成差异报告，不用浮点容差掩盖差异。
6. 差异不为 0 时停止，不切换任何读写。
7. 新增影子读取，在测试中同时计算新旧结果但仍返回旧结果。
8. 全部一致后切换工资读取到新账本。
9. 再切换收入、罚款和预支审批写入。
10. 旧 `income_records` 进入只读兼容期，不立即删除。

### 对账标准

- 每个员工当前未结算工资必须完全一致。
- 每个已完成历史工资周期必须完全一致。
- 每个店铺和币种的总收入、罚款、预支和净额必须一致。
- 不允许用“总金额相同”掩盖员工之间的错配。
- 迁移脚本重复运行不得生成重复账本记录。

## 模块化重构

### 原则

- 重构提交不改变行为。
- 先补保护性测试，再移动代码。
- 不顺便更名所有字段或统一所有页面样式。
- 每个模块只拥有一种主要职责。
- SQL 和业务规则不继续散落在 Telegram、后台 API 和页面处理器里。
- 保持原生 JavaScript ES modules，暂不增加框架和构建工具。

### 推荐模块

```text
src/
  index.js                 # Worker fetch/scheduled 入口
  router.js                # HTTP 和 webhook 路由
  telegram.js              # Telegram API、按钮和消息发送
  i18n.js                  # 多语言文本和 render
  approvals.js             # 收入、罚款、预支审批编排
  payroll.js               # 周期、截止点和工资快照
  payroll-ledger.js        # 统一资金流水读写和求和
  absence.js               # 缺勤扫描、审批和通知
  admin-api.js             # 管理后台 API
  admin-page.js            # 管理后台 HTML/CSS/JavaScript
```

以上是目标边界，不要求一次提交全部拆完。每次只提取一组相互关联的代码并保持系统可运行。

### 依赖方向

```text
Worker 入口和路由
        ↓
Telegram / Admin API / Cron 编排
        ↓
Payroll / Approval / Absence 业务服务
        ↓
Payroll Ledger 和 D1 查询
```

业务服务不得反向依赖后台 HTML。Telegram 文案不得决定工资计算。Dashboard 不得复制工资公式。

### 重构批次

1. 提取纯金额、日期、分页和格式化函数。
2. 提取 Telegram API 和多语言。
3. 提取缺勤模块，保持现有并发和通知测试。
4. 提取资金审批与工资查询。
5. 提取后台 API。
6. 最后移动后台页面。

每个批次单独提交并运行全套测试。

## Dashboard 设计

### 定义

Dashboard 的“员工月收入”默认表示：

```text
该员工在所选月份内所有已生效工资账本流水的净和
```

月份按 `effective_at` 和店铺时区归属。原始营业额作为独立指标展示，不参与工资净额求和。

### 页面位置

- 后台新增“数据看板”标签。
- 登录成功后的默认页面改为数据看板。
- 原店铺、员工、收入、工资、预支、考勤、缺勤、请假和日志页面继续保留。

### 筛选

- 店铺，多选。
- 日期范围或月份范围。
- 员工，多选或全部。
- 资金类型。

不同货币不得合并成一个数。选择多个不同币种店铺时，所有金额卡片和图表按币种分组。

### 第一版指标

- 原始营业额。
- 员工提成收入。
- 罚款。
- 预支工资。
- 奖金和调整。
- 工资净额。
- 已结算工资。
- 待付款工资。

### 第一版图表

1. 月度净收入趋势折线图。
2. 员工月度净收入对比柱状图。
3. 收入、罚款、预支和调整组成堆叠图。
4. 员工排名表，可进入该员工资金流水明细。

第一版使用项目内的原生 SVG 和 CSS 图表辅助函数，不增加第三方图表库，不从公网 CDN 动态加载。每张图同时提供对应的可访问数据表，保证键盘操作、无障碍读取和数值核对。后续只有在图表交互复杂度明显增加时，才单独评估成熟图表库。

### Dashboard API

建议增加：

```text
GET /api/admin/dashboard/summary
GET /api/admin/dashboard/monthly
GET /api/admin/dashboard/employees
GET /api/admin/dashboard/entries
```

所有接口复用现有管理员会话和店铺权限验证。

共同查询参数：

- `stores`：逗号分隔的店铺 ID。
- `date_from`、`date_to`：店铺当地日期，使用左闭右开范围转换为 UTC。
- `employees`：可选的员工 ID 列表。
- `types`：可选的账本类型列表。

汇总接口统一返回：

```json
{
  "ok": true,
  "groups": [
    {
      "currency": "₫",
      "income_micros": 0,
      "fine_micros": 0,
      "advance_micros": 0,
      "adjustment_micros": 0,
      "net_micros": 0
    }
  ]
}
```

月度和员工接口同样以 `currency` 分组并返回整数 micros。明细接口使用现有分页格式。所有错误继续使用 `{ "ok": false, "error": "machine_code" }`，权限失败为 `403`，输入错误为 `400`，并发冲突为 `409`。

后端负责：

- 权限范围。
- 店铺时区边界。
- 全量 SQL 聚合。
- 币种分组。
- 类型分组。
- 员工和月份分组。
- 明细分页。

前端只负责展示，不得从分页列表重新推导总额。

### 查询和性能

- 汇总查询直接读取 `payroll_entries`，使用店铺、员工、时间和类型索引。
- 原始营业额单独读取已批准收入申请。
- 明细接口分页。
- 汇总接口不返回原始流水。
- 不为每名员工单独执行一条查询，避免 N+1。
- 第一期不增加预计算月表；真实数据量证明聚合过慢后再考虑。

## 与个人发薪设计的关系

本设计对 `2026-07-27-personal-payroll-cycle-design.md` 作以下补充和覆盖：

- 自动工资的唯一工资影响来源从 `income_records` 改为 `payroll_entries`。
- 工资金额使用 `SUM(amount_micros)`。
- 负数结转写入 `payroll_entries.type='negative_carry'`，不再写入 `income_records.fine`。
- 工资快照通过 `payroll_disbursement_entries` 保存包含的流水明细。
- 已确认工资仍写入 `salary_records` 作为正式付款历史。
- 第 16 天、第 30 天、中午 12:00、付款方式、凭证、员工确认、争议和邮件规则不变。

实现个人自动发薪前，统一账本必须先完成迁移和对账。

## 安全、审计与错误处理

- 所有账本写入使用服务器生成 ID。
- 所有 SQL 参数绑定。
- 所有资金写入验证店铺权限和员工归属。
- 已生效账本不提供 DELETE 或金额 PATCH 接口。
- 冲销必须填写原因并记录管理员审计。
- 外部输入在 API、Telegram 和迁移入口验证。
- 并发冲突返回明确的 `409`。
- 数据库写入失败不得先发送成功 Telegram 消息。
- Dashboard 不返回完整银行卡、USDT 地址或付款凭证。
- 日志不得记录完整资金申请正文中的敏感账号。

## 测试策略

### 重构保护

- 现有 108 个测试持续通过。
- 为收入、工资、预支审批补并发测试。
- 为所有现有资金写入入口建立行为测试。
- 重构前后 API 和 Telegram 关键消息保持一致。

### 账本

- 每种类型只写入一个带符号金额字段。
- 收入为正、罚款和预支为负。
- 时间范围使用左闭右开边界。
- 重复审批不重复入账。
- 冲销金额与原记录精确相反。
- 已生效流水不能修改或删除。
- 历史迁移可重复执行。
- 新旧工资逐员工、逐周期完全一致。
- 负数结转只生成一次。

### Dashboard

- 汇总覆盖完整筛选范围，不受分页影响。
- 多员工查询不使用 N+1。
- 不同币种分组显示。
- 店铺时区决定月度边界。
- 图表总额与明细账本求和一致。
- 无数据、负数、冲销和跨月边界正确显示。

### staging 验收

- 测试 Worker、D1、R2、Telegram Bot 和 Secrets 与生产隔离。
- Cron 默认关闭或手动控制。
- 测试通知只允许白名单。
- 生产数据快照导入后清除会话、验证码和临时通知状态。
- 当前版本先在 staging 原样运行。
- 重构、迁移和 Dashboard 分阶段部署验证。

## 实施阶段和质量门槛

### 阶段 1：测试环境

- 建立独立 staging。
- 部署当前未重构版本。
- 证明不会连接生产资源或通知真实员工。

### 阶段 2：测试和模块化重构

- 补资金审批、工资计算和后台汇总保护测试。
- 按模块逐批提取 `src/index.js`。
- 每批保持现有行为和测试通过。

### 阶段 3：统一账本

- 新增表、索引和不可变接口。
- 回填 staging 历史数据。
- 生成逐员工、逐周期差异报告。
- 新旧结果完全一致后切换读取和写入。

### 阶段 4：Dashboard

- 增加后端聚合 API。
- 增加 Dashboard 页面和图表。
- 对照 SQL 验证所有指标。

### 阶段 5：个人自动发薪

- 在统一账本上实现已确认的第 16 天、第 30 天自动工资。
- 实现付款、凭证、确认、争议和邮件。

### 阶段 6：生产发布

- 使用通过 staging 的同一提交。
- 发布前备份生产 D1。
- 核对并执行迁移。
- 验证 Worker、后台、Telegram、Cron、D1 和日志。
- 现有员工逐人设置第一工作日期后再启用自动工资。

## 完成标准

只有同时满足以下条件才算完成：

1. 所有工资影响记录使用 `payroll_entries.amount_micros`。
2. 工资公式不再读取 `commission_income - fine`。
3. 历史新旧金额逐员工、逐周期完全一致。
4. 已生效资金记录只能冲销，不能修改或删除。
5. 并发审批不会重复入账。
6. Dashboard 汇总不受分页影响。
7. Dashboard 按店铺时区和币种正确聚合。
8. 现有功能、API、Telegram 和后台回归测试通过。
9. staging 与生产完全隔离。
10. 生产发布前经过人工验收和数据库备份。

## 后续实施计划的拆分要求

后续实施计划必须把以下内容拆成独立、可验证的提交：

- staging 配置。
- 保护性测试。
- 行为不变的模块提取。
- 账本 schema。
- 历史迁移和对账工具。
- 账本读取切换。
- 各资金写入入口切换。
- 不可变和冲销后台操作。
- Dashboard 聚合 API。
- Dashboard 页面。
- 个人自动发薪。

不得在同一个提交中同时进行大规模代码移动、数据库迁移和业务行为变更。
