import { logEvent } from './audit.js';
import { JSON_HEADERS } from './http.js';
import { isTelegramRecipientAllowed } from './security.js';

export async function sendMessage(env, chatId, text, replyMarkup) {
  const payload = { chat_id: chatId, text };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return telegram(env, 'sendMessage', payload);
}

export async function sendPhoto(env, chatId, photo, caption) {
  const payload = { chat_id: chatId, photo };
  if (caption) payload.caption = caption;
  return telegram(env, 'sendPhoto', payload);
}

export async function answerCallback(env, callbackQueryId, text = '', showAlert = false) {
  return telegram(env, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
    show_alert: showAlert
  });
}

export async function editCallbackMessage(env, callback, text, replyMarkup) {
  const payload = {
    chat_id: callback.message.chat.id,
    message_id: callback.message.message_id,
    text
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return telegram(env, 'editMessageText', payload);
}

export function telegramErrorSummary(result, error = null) {
  const errorCode = Number(result && result.error_code);
  const description = String(
    result && result.description
      ? result.description
      : error && error.message
        ? error.message
        : 'telegram_delivery_failed'
  ).slice(0, 300);
  return {
    error_code: Number.isFinite(errorCode) ? errorCode : 0,
    description
  };
}

export async function getTelegramFile(env, fileId) {
  const result = await telegram(env, 'getFile', { file_id: fileId });
  if (!result || !result.ok || !result.result || !result.result.file_path) {
    throw new Error('telegram_file_lookup_failed');
  }
  return result.result;
}

export async function downloadTelegramFile(env, filePath) {
  const path = String(filePath || '');
  if (!path || path.includes('..') || path.startsWith('/')) {
    throw new Error('invalid_telegram_file_path');
  }
  return fetch(
    `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${path}`
  );
}

export async function telegram(env, method, payload) {
  if (!isTelegramRecipientAllowed(env, payload)) {
    await logEvent(env, 'warn', 'staging_telegram_recipient_blocked', {
      telegram_id: String(payload.chat_id),
      method
    });
    return {
      ok: false,
      error_code: 403,
      description: 'staging_recipient_blocked'
    };
  }

  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!result.ok) await logEvent(env, 'error', 'telegram_api_error', { method, payload, result });
  return result;
}
