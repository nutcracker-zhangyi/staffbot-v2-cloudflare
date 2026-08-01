import { serviceEnvironment } from './security.js';

export function manageHtml(env) {
  const environment = serviceEnvironment(env);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#111827">
  <title>StaffBot 管理端</title>
  <link rel="manifest" href="/manage/manifest.webmanifest">
  <link rel="stylesheet" href="/manage/styles.css">
</head>
<body data-environment="${environment}">
  <main id="app" aria-live="polite"></main>
  <script src="/manage/app.js" defer></script>
</body>
</html>`;
}
