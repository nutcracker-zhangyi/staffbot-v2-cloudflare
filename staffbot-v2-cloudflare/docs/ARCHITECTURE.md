# 架构设计

## 总体结构

```text
Telegram User
    |
    v
Telegram Bot API
    |
    v
Cloudflare Worker
    |
    v
Cloudflare D1 Database
```

## 核心组件

| 组件 | 作用 |
| --- | --- |
| Telegram Bot | 员工和管理员使用的聊天界面 |
| Cloudflare Worker | 接收 Telegram webhook，处理业务逻辑 |
| Cloudflare D1 | 保存用户、收入、审批、状态、日志 |
| Cloudflare Secrets | 保存 Bot Token、管理员 ID 等敏感配置 |

## 请求流程

1. 用户在 Telegram 发送消息。
2. Telegram 调用 Worker 的 webhook URL。
3. Worker 验证 webhook secret。
4. Worker 把原始 update 写入 `bot_logs`。
5. Worker 根据消息类型分发到命令处理器。
6. 命令处理器读写 D1 数据库。
7. Worker 调用 Telegram Bot API 回复用户。

## 推荐代码结构

```text
staffbot-v2-cloudflare/
  src/
    index.ts              # Worker 入口
    config.ts             # 环境变量读取
    telegram.ts           # Telegram API 封装
    router.ts             # 消息和 callback 分发
    commands/
      start.ts
      ping.ts
      income.ts
      total.ts
      cancel.ts
    services/
      users.ts
      state.ts
      income.ts
      audit.ts
      logs.ts
    db/
      schema.sql
      queries.ts
  docs/
```

## 设计原则

### 1. 不使用内存状态

用户当前流程必须写进数据库 `user_states`。

这样如果用户卡住，可以直接在数据库里看到：

```text
telegram_id = 123456789
state = WAIT_INCOME_AMOUNT
```

### 2. 所有输入先记录日志

每一条 Telegram update 都写入 `bot_logs`。

排错时先看日志，不靠猜。

### 3. 命令优先于状态

这些命令永远最高优先级：

```text
/ping
/cancel
/start
```

即使用户卡在收入流程里，也能取消或测试。

### 4. 第一版不做多语言

先把业务跑通，再做多语言。

### 5. 管理员操作必须审计

管理员批准、驳回、非法点击，都写入 `admin_audit_logs`。
