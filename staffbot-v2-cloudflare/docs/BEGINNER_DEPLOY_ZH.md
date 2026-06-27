# 小白部署和测试手册

本文档从零开始部署 `staffbot-v2-cloudflare`。

## 你需要准备

- Telegram 账号
- Cloudflare 账号
- 电脑终端
- Telegram Bot Token
- 你的 Telegram 数字 ID

## 第 1 步：创建 Telegram Bot

1. 打开 Telegram。
2. 搜索 `@BotFather`。
3. 发送 `/newbot`。
4. 输入机器人显示名称，例如 `Staff Bot`。
5. 输入机器人 username，必须以 `bot` 结尾，例如 `my_staff_v2_bot`。
6. 保存 BotFather 返回的 Bot Token。

Bot Token 长这样：

```text
123456789:AAxxxxxxxxxxxxxxxxxxxxxxxx
```

## 第 2 步：获取你的管理员 ID

1. Telegram 搜索 `@userinfobot`。
2. 点 Start。
3. 保存它返回的数字 ID。

例如：

```text
123456789
```

## 第 3 步：注册 Cloudflare

1. 打开 `https://dash.cloudflare.com/sign-up`。
2. 注册账号。
3. 登录 Cloudflare Dashboard。

## 第 4 步：打开项目目录

打开终端，进入项目：

```text
cd /Users/nutcrackermacbookair/Documents/telegram/staffbot-v2-cloudflare
```

## 第 5 步：安装 Wrangler

Wrangler 是 Cloudflare 官方命令行工具。

```text
npm install -g wrangler
```

检查安装：

```text
wrangler --version
```

## 第 6 步：登录 Cloudflare

```text
wrangler login
```

它会打开浏览器。

1. 登录 Cloudflare。
2. 点允许授权。
3. 回到终端。

## 第 7 步：创建 D1 数据库

```text
wrangler d1 create staffbot_v2
```

它会输出类似：

```text
database_name = "staffbot_v2"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

复制 `database_id`。

## 第 8 步：创建 wrangler.toml

复制模板：

```text
cp wrangler.toml.example wrangler.toml
```

用编辑器打开：

```text
open -e wrangler.toml
```

把：

```text
database_id = "replace-with-your-d1-database-id"
```

改成你刚刚复制的 `database_id`。

保存文件。

## 第 9 步：创建数据库表

```text
wrangler d1 execute staffbot_v2 --remote --file db/schema.sql
```

看到成功提示即可。

## 第 10 步：设置密钥

设置 Bot Token：

```text
wrangler secret put BOT_TOKEN
```

终端会让你输入值。粘贴 BotFather 给你的 Token。

设置 Webhook Secret：

```text
wrangler secret put WEBHOOK_SECRET
```

输入一串你自己编的随机字符，例如：

```text
staffbot_2026_19810613
```

设置管理员 ID：

```text
wrangler secret put ADMIN_IDS
```

输入你的 Telegram 数字 ID，例如：

```text
123456789
```

多个管理员用英文逗号：

```text
123456789,987654321
```

## 第 11 步：部署 Worker

```text
wrangler deploy
```

成功后会出现一个 URL，类似：

```text
https://staffbot-v2.xxx.workers.dev
```

保存这个 URL。

## 第 12 步：测试 Worker 是否在线

浏览器打开：

```text
https://staffbot-v2.xxx.workers.dev
```

如果看到：

```json
{"ok":true,"service":"staffbot-v2"}
```

说明 Worker 在线。

## 第 13 步：设置 Telegram Webhook

Webhook URL 格式：

```text
https://staffbot-v2.xxx.workers.dev/webhook/你的WEBHOOK_SECRET
```

运行：

```text
curl "https://api.telegram.org/bot你的BOT_TOKEN/setWebhook?url=https://staffbot-v2.xxx.workers.dev/webhook/你的WEBHOOK_SECRET&drop_pending_updates=true"
```

成功结果应该包含：

```json
{"ok":true}
```

## 第 14 步：检查 Webhook

```text
curl "https://api.telegram.org/bot你的BOT_TOKEN/getWebhookInfo"
```

确认：

```text
pending_update_count
```

不是一直增加，并且没有 `last_error_message`。

## 第 15 步：Telegram 测试

打开你的机器人。

发送：

```text
/ping
```

应该回复：

```text
pong ...
```

发送：

```text
/start
```

应该显示命令说明。

测试收入：

```text
/income
```

机器人：

```text
请输入收入金额，例如：2000
```

你输入：

```text
2000
```

机器人：

```text
请输入罚款金额，没有罚款请输入 0
```

你输入：

```text
0
```

机器人：

```text
已提交审核
```

管理员应该收到批准/驳回按钮。

## 第 16 步：查看日志

```text
wrangler d1 execute staffbot_v2 --remote --command "SELECT id, level, event, telegram_id, message_text, created_at FROM bot_logs ORDER BY id DESC LIMIT 20"
```

## 第 17 步：查看待审批收入

```text
wrangler d1 execute staffbot_v2 --remote --command "SELECT * FROM pending_income ORDER BY submitted_at DESC LIMIT 20"
```

## 第 18 步：查看已批准收入

```text
wrangler d1 execute staffbot_v2 --remote --command "SELECT * FROM income_records ORDER BY approved_at DESC LIMIT 20"
```

## 常见问题

### `/ping` 没反应

检查：

1. `wrangler deploy` 是否成功。
2. Webhook URL 是否包含正确的 `WEBHOOK_SECRET`。
3. `getWebhookInfo` 是否有 `last_error_message`。

### 收不到管理员审批

检查：

1. `ADMIN_IDS` 是否是 Telegram 数字 ID。
2. 管理员是否已经打开机器人并发送 `/start`。
3. `pending_income` 是否有记录。

### 想重新设置 webhook

```text
curl "https://api.telegram.org/bot你的BOT_TOKEN/deleteWebhook?drop_pending_updates=true"
curl "https://api.telegram.org/bot你的BOT_TOKEN/setWebhook?url=https://staffbot-v2.xxx.workers.dev/webhook/你的WEBHOOK_SECRET&drop_pending_updates=true"
```
