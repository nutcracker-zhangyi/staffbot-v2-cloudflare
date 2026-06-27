# 功能路线图

## Phase 1 - 稳定收入审批闭环

目标：先让机器人稳定可用。

功能：

- `/start`
- `/ping`
- `/cancel`
- `/income`
- `/total`
- 员工提交收入
- 管理员批准收入
- 管理员驳回收入
- 日志记录
- 数据库状态管理

验收标准：

1. `/ping` 每次都能回复。
2. `/income -> 2000 -> 0` 能生成待审批记录。
3. 管理员能收到审批按钮。
4. 管理员批准后，收入进入 `income_records`。
5. `/total` 能显示批准后的总收入。
6. 所有关键步骤在 `bot_logs` 可查。

## Phase 2 - 工资申请

功能：

- `/salary`
- 员工申请发工资
- 管理员批准/驳回
- 批准后重置用户 `cycle_start`
- 保存工资历史

新增表：

```text
salary_requests
salary_records
```

## Phase 3 - 考勤

功能：

- `/attendance`
- 签到
- 签退
- 记录 Telegram 位置
- 迟到/早退罚款

新增表：

```text
attendance_records
```

## Phase 4 - 多语言

功能：

- 中文
- 英文
- 越南语
- 用户语言设置

原则：

多语言必须在核心业务稳定后再加。

## Phase 5 - 管理员网页后台

使用 Cloudflare Pages。

功能：

- 查看员工
- 查看待审批收入
- 查看工资记录
- 查看日志
- 导出 CSV

