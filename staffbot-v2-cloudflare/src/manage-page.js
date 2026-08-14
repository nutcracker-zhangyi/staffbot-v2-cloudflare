import { serviceEnvironment } from './security.js';

export function manageHtml(env) {
  const environment = serviceEnvironment(env);
  const assetVersion = encodeURIComponent(
    String(env && env.CF_VERSION_METADATA && env.CF_VERSION_METADATA.id || 'local')
      .slice(0, 128)
  );
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#111827">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <title>StaffBot 管理端</title>
  <link rel="manifest" href="/manage/manifest.webmanifest">
  <link rel="stylesheet" href="/manage/styles.css?v=${assetVersion}">
</head>
<body data-environment="${environment}">
  <main id="app" aria-live="polite"></main>
  <script src="/manage/app.js?v=${assetVersion}" defer></script>
</body>
</html>`;
}
