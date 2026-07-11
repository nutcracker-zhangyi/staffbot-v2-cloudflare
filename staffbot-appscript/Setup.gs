function setupSheets() {
  const defs = {
    'Employees':        ['Telegram_ID', 'Name', 'Username', 'Status', 'Cycle_Start', 'Registered_At', 'Language'],
    'Pending_Income':   ['Request_ID', 'Telegram_ID', 'Income', 'Fine', 'Submitted_At', 'Status', 'Admin_ID', 'Decided_At'],
    'Income_Records':   ['Record_ID', 'Telegram_ID', 'Income', 'Fine', 'Source', 'Submitted_At', 'Approved_At', 'Admin_ID'],
    'Rejected_Income':  ['Request_ID', 'Telegram_ID', 'Income', 'Fine', 'Submitted_At', 'Rejected_At', 'Admin_ID', 'Reason'],
    'Salary_Requests':  ['Request_ID', 'Telegram_ID', 'Amount_Snapshot', 'Requested_At', 'Status', 'Admin_ID', 'Decided_At', 'Reason'],
    'Salary_History':   ['Record_ID', 'Telegram_ID', 'Salary_Amount', 'Period_Start', 'Period_End', 'Approved_At', 'Admin_ID'],
    'Attendance':       ['Record_ID', 'Telegram_ID', 'Business_Date', 'Type', 'Timestamp', 'Latitude', 'Longitude', 'Late', 'Early_Leave', 'Fine'],
    'Admin_Audit_Log':  ['Log_ID', 'Timestamp', 'Admin_ID', 'Action', 'Target_Request_ID', 'Target_Employee_ID', 'Details'],
    'Settings':         ['Key', 'Value'],
    'Error_Log':        ['Timestamp', 'Error']
  };
  const book = SpreadsheetApp.openById(SHEET_ID);
  Object.keys(defs).forEach(function (name) {
    let s = book.getSheetByName(name);
    if (!s) s = book.insertSheet(name);
    if (s.getLastRow() === 0) {
      s.appendRow(defs[name]);
      s.getRange(1, 1, 1, defs[name].length).setFontWeight('bold');
      s.setFrozenRows(1);
    }
  });
  const st = book.getSheetByName('Settings');
  if (st.getLastRow() <= 1) {
    [['ADMIN_IDS', '在这里填管理员ID,逗号分隔'],
     ['TIMEZONE', 'Asia/Ho_Chi_Minh'],
     ['CHECKIN_TIME', '18:30'],
     ['CHECKOUT_TIME', '01:30'],
     ['LATE_FINE', '0.5'],
     ['EARLY_LEAVE_FINE', '1.5'],
     ['CURRENCY', '$']].forEach(function (row) { st.appendRow(row); });
  }
  Logger.log('All sheets ready.');
}

function setWebhook() {
  const url = SP.getProperty('WEBAPP_URL') + '?token=' + WEBHOOK_SECRET;
  const res = UrlFetchApp.fetch(API_URL + 'setWebhook', {
    method: 'post',
    payload: { url: url, allowed_updates: JSON.stringify(['message', 'callback_query']), drop_pending_updates: 'true' }
  });
  Logger.log(res.getContentText());
}
function getWebhookInfo() {
  Logger.log(UrlFetchApp.fetch(API_URL + 'getWebhookInfo').getContentText());
}
function deleteWebhook() {
  Logger.log(UrlFetchApp.fetch(API_URL + 'deleteWebhook').getContentText());
}
function backupSpreadsheet() {
  const file = DriveApp.getFileById(SHEET_ID);
  file.makeCopy('Staff_Bot_DB_Backup_' + Utilities.formatDate(new Date(), tzName(), 'yyyyMMdd_HHmm'));
  const files = DriveApp.searchFiles('title contains "Staff_Bot_DB_Backup_"');
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  while (files.hasNext()) {
    const f = files.next();
    if (f.getDateCreated().getTime() < cutoff) f.setTrashed(true);
  }
}
