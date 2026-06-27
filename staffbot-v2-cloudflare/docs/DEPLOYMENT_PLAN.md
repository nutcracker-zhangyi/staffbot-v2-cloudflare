# 部署规划

## 使用的平台

| 平台 | 用途 |
| --- | --- |
| Telegram BotFather | 创建 Bot，获取 Bot Token |
| Cloudflare Workers | 部署 webhook 后端 |
| Cloudflare D1 | SQL 数据库 |
| Cloudflare Secrets | 保存敏感配置 |
| GitHub | 保存代码，可选 |

## 免费工具选择

首选：

```text
Cloudflare Workers + Cloudflare D1
```

原因：

- 一个账号完成后端和数据库
- 不需要自己买服务器
- 不需要 Google Apps Script
- 更适合 webhook 程序
- 以后可以加 Cloudflare Pages 管理后台

## 环境变量

Worker 需要这些配置：

```text
BOT_TOKEN
WEBHOOK_SECRET
ADMIN_IDS
```

说明：

- `BOT_TOKEN`: Telegram BotFather 给的 Token
- `WEBHOOK_SECRET`: 自己生成的随机字符串
- `ADMIN_IDS`: 管理员 Telegram ID，多个用逗号分隔

## Webhook URL

格式：

```text
https://your-worker.your-subdomain.workers.dev/webhook/WEBHOOK_SECRET
```

Worker 只接受路径里 secret 正确的请求。

## 部署步骤概览

1. 创建 Telegram Bot。
2. 创建 Cloudflare 账号。
3. 创建 Worker 项目。
4. 创建 D1 数据库。
5. 执行 `schema.sql` 建表。
6. 配置 Worker Secrets。
7. 部署 Worker。
8. 调用 Telegram `setWebhook`。
9. 测试 `/ping`。
10. 测试 `/income`。

## 本地开发方式

使用 Wrangler：

```text
npm install
npx wrangler dev
```

本地测试通过后再部署：

```text
npx wrangler deploy
```

