function tg(method, payload) {
  const res = UrlFetchApp.fetch(API_URL + method, {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  const json = JSON.parse(res.getContentText());
  if (!json.ok) logError('TG ' + method + ' failed: ' + res.getContentText());
  return json;
}
function send(chatId, text, replyMarkup) {
  const p = { chat_id: chatId, text: text, parse_mode: 'HTML' };
  if (replyMarkup) p.reply_markup = replyMarkup;
  const res = tg('sendMessage', p);
  if (!res || !res.ok) {
    logError('sendMessage failed chatId=' + chatId + ' text=' + text + ' response=' + JSON.stringify(res));
  }
  return res;
}
function ack(cb, text, alert) {
  tg('answerCallbackQuery', { callback_query_id: cb.id, text: text || '', show_alert: !!alert });
}
function finalizeAdminMsg(cb, suffix) {
  tg('editMessageText', {
    chat_id: cb.message.chat.id, message_id: cb.message.message_id,
    text: cb.message.text + '\n\n' + suffix, parse_mode: 'HTML'
  });
}
/** 主菜单(按员工语言显示) */
function mainMenuKb(uid) {
  return {
    keyboard: [
      [{ text: t(uid, 'btn_submit_income') }, { text: t(uid, 'btn_total_income') }],
      [{ text: t(uid, 'btn_request_salary') }, { text: t(uid, 'btn_attendance') }]
    ],
    resize_keyboard: true, is_persistent: true
  };
}
function notifyAdmins(text, inlineKb) {
  getAdminIds().forEach(function (adminId) { send(adminId, text, inlineKb); });
}
