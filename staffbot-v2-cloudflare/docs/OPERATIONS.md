# 运维和排错

## 排错原则

先查日志，再改代码。

第一版所有 Telegram update 都写入：

```text
bot_logs
```

## 常见问题

### 机器人没回复

检查顺序：

1. Telegram webhook 是否设置正确。
2. Worker 日志是否收到请求。
3. `bot_logs` 是否有对应 update。
4. Telegram API 返回是否失败。

### 用户卡在流程里

查看：

```sql
SELECT * FROM user_states WHERE telegram_id = '用户ID';
```

手动清理：

```sql
DELETE FROM user_states WHERE telegram_id = '用户ID';
```

或者用户发送：

```text
/cancel
```

### 收入没有进入总收入

检查：

1. 是否还在 `pending_income`。
2. 管理员是否批准。
3. 批准后是否写入 `income_records`。

## 备份

D1 支持导出 SQL。

建议每周导出一次数据库备份。

## 维护原则

- 每次只加一个功能。
- 每个功能先写日志。
- 核心命令 `/ping` 和 `/cancel` 永远最高优先级。
- 不要在第一版加入多语言、考勤、工资等复杂功能。

