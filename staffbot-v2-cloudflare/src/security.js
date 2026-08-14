const MAX_LOGIN_FAILURES = 5;
const LOGIN_LOCK_MS = 10 * 60 * 1000;

export function adminIds(env) {
  return Array.from(new Set(String(env.ADMIN_IDS || '').split(',').map((id) => id.trim()).filter(Boolean)));
}

export function isGlobalAdmin(env, telegramId) {
  return adminIds(env).includes(String(telegramId));
}

export function nextLoginFailureState(currentFailures, now = new Date()) {
  const failedAttempts = Number(currentFailures || 0) + 1;
  return {
    failedAttempts,
    lockedUntil: failedAttempts >= MAX_LOGIN_FAILURES ? new Date(now.getTime() + LOGIN_LOCK_MS).toISOString() : null
  };
}

export function serviceEnvironment(env) {
  const value = String(env && env.ENVIRONMENT || '').trim().toLowerCase();
  if (value === 'production' || value === 'staging') return value;
  return 'unknown';
}

export function parseTelegramAllowlist(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
  );
}

export function isTelegramRecipientAllowed(env, payload) {
  const environment = serviceEnvironment(env);
  if (environment === 'production') return true;
  if (environment !== 'staging') return false;
  if (!payload || payload.chat_id === undefined || payload.chat_id === null) return true;
  if (String(env.TELEGRAM_RECIPIENT_MODE || '').toLowerCase() !== 'allowlist') return false;
  return parseTelegramAllowlist(env.STAGING_ALLOWED_TELEGRAM_IDS).has(String(payload.chat_id));
}

export function scheduledTasksEnabled(env) {
  return !!(env && (env.SCHEDULED_TASKS_ENABLED === true
    || String(env.SCHEDULED_TASKS_ENABLED || '').toLowerCase() === 'true'));
}

export function manageBaseUrl(env) {
  const configured = String(env && env.MANAGE_BASE_URL || '').trim();
  let url;
  try {
    url = new URL(configured);
  } catch {
    throw new Error('MANAGE_BASE_URL must be a valid HTTPS origin');
  }
  if (url.protocol !== 'https:'
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== '/') {
    throw new Error('MANAGE_BASE_URL must be a valid HTTPS origin');
  }
  return url.origin;
}

export function payrollEmailConfig(env) {
  const recipient = String(
    env && env.PAYROLL_FINANCE_EMAIL || ''
  ).trim();
  const sender = String(
    env && env.PAYROLL_FROM_EMAIL || ''
  ).trim();
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return {
    recipient,
    sender,
    ready: !!(
      env
      && env.PAYROLL_EMAIL
      && typeof env.PAYROLL_EMAIL.send === 'function'
      && emailPattern.test(recipient)
      && emailPattern.test(sender)
    )
  };
}

export function isWebhookConfigReady(env) {
  return !!(env && env.BOT_TOKEN && env.WEBHOOK_SECRET);
}

export function webhookSecretMatches(headerSecret, expectedSecret) {
  return !headerSecret || headerSecret === expectedSecret;
}

export function securityHeaders() {
  return {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'geolocation=(), microphone=(), camera=()',
    'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  };
}

export function manageSecurityHeaders() {
  return {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'geolocation=(), microphone=(), camera=(self)',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  };
}
