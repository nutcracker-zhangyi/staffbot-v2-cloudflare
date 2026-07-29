import { handleAdminApi } from './admin-api.js';
import { adminHtml } from './admin-page.js';
import { processAbsenceFines } from './absence.js';
import { logEvent } from './audit.js';
import { html, json } from './http.js';
import { deliverPayrollNotifications } from './payroll-notifications.js';
import { processPayrollSettlements } from './payroll-settlement.js';
import {
  isWebhookConfigReady,
  scheduledTasksEnabled,
  serviceEnvironment,
  webhookSecretMatches
} from './security.js';
import { handleUpdate } from './telegram.js';

export async function processScheduledWork(env, now = new Date()) {
  const absenceResult = await processAbsenceFines(env, now);
  const absence = absenceResult || { ok: true };
  const payroll = await processPayrollSettlements(env, now);
  const notifications = await deliverPayrollNotifications(env, now);
  const email = {
    scanned: 0,
    sent: 0,
    failed: 0
  };
  return { absence, payroll, notifications, email };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return json({
        ok: true,
        service: 'staffbot-v2',
        environment: serviceEnvironment(env),
        admin: '/admin'
      });
    }

    if (request.method === 'GET' && url.pathname === '/admin') {
      return html(adminHtml(env));
    }

    if (url.pathname.startsWith('/api/admin/')) {
      if (!isWebhookConfigReady(env)) return json({ ok: false, error: 'server_not_configured' }, 500);
      return handleAdminApi(request, env, url, ctx);
    }

    if (request.method === 'POST' && url.pathname.startsWith('/webhook/')) {
      if (!isWebhookConfigReady(env)) return json({ ok: false, error: 'server_not_configured' }, 500);
      if (url.pathname !== `/webhook/${env.WEBHOOK_SECRET}`) return json({ ok: false, error: 'not_found' }, 404);
      if (!webhookSecretMatches(request.headers.get('x-telegram-bot-api-secret-token') || '', env.WEBHOOK_SECRET)) {
        return json({ ok: false, error: 'forbidden' }, 403);
      }
      const update = await request.json();
      ctx.waitUntil(logEvent(env, 'debug', 'telegram_update', update.message ? {
        telegram_id: update.message.from && update.message.from.id,
        chat_id: update.message.chat && update.message.chat.id,
        update_id: update.update_id
      } : { update_id: update.update_id }));
      await handleUpdate(update, env);
      return json({ ok: true });
    }

    return json({ ok: false, error: 'not_found' }, 404);
  },

  async scheduled(controller, env, ctx) {
    if (!scheduledTasksEnabled(env)) return;
    ctx.waitUntil(processScheduledWork(
      env,
      new Date(controller.scheduledTime)
    ));
  }
};
