export const MANAGE_CLIENT = String.raw`const app = document.getElementById('app');

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {})
    }
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'request_failed');
  return result;
}

function loginView() {
  app.innerHTML = '<section class="auth-card">'
    + '<p class="eyebrow">StaffBot</p>'
    + '<h1>管理端登录</h1>'
    + '<p>验证码将发送到管理员的 Telegram。</p>'
    + '<label>Telegram ID<input id="telegram-id" autocomplete="username" inputmode="numeric"></label>'
    + '<button id="send-code" type="button">发送验证码</button>'
    + '<label>验证码<input id="login-code" autocomplete="one-time-code" inputmode="numeric"></label>'
    + '<button id="verify-code" type="button">登录</button>'
    + '<p id="login-status" role="status"></p>'
    + '</section>';

  document.getElementById('send-code').onclick = async () => {
    const telegramId = document.getElementById('telegram-id').value;
    try {
      await api('/api/admin/login/start', {
        method: 'POST',
        body: JSON.stringify({ telegram_id: telegramId })
      });
      document.getElementById('login-status').textContent = '验证码已发送';
    } catch (error) {
      document.getElementById('login-status').textContent = error.message;
    }
  };

  document.getElementById('verify-code').onclick = async () => {
    const telegramId = document.getElementById('telegram-id').value;
    const code = document.getElementById('login-code').value;
    try {
      await api('/api/admin/login/verify', {
        method: 'POST',
        body: JSON.stringify({ telegram_id: telegramId, code })
      });
      await boot();
    } catch (error) {
      document.getElementById('login-status').textContent = error.message;
    }
  };
}

function authenticatedView(session) {
  app.innerHTML = '<header class="app-header">'
    + '<div><p class="eyebrow">StaffBot</p><h1>移动管理端</h1></div>'
    + '<button id="logout" class="secondary" type="button">退出</button>'
    + '</header>'
    + '<section class="placeholder"><h2>工作台</h2><p id="session-admin"></p></section>'
    + '<nav class="bottom-nav" aria-label="Bottom navigation">'
    + '<button type="button" aria-current="page">工作台</button>'
    + '<button type="button" disabled>待办</button>'
    + '<button type="button" disabled>员工</button>'
    + '<button type="button" disabled>更多</button>'
    + '</nav>';

  document.getElementById('session-admin').textContent = '已登录：' + session.telegram_id;

  document.getElementById('logout').onclick = async () => {
    await api('/api/admin/logout', { method: 'POST' });
    loginView();
  };
}

async function boot() {
  try {
    authenticatedView(await api('/api/admin/me'));
  } catch {
    loginView();
  }
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/manage/sw.js');
}

boot();
`;
