/** ============ I18n.gs — 中文 / English / Tiếng Việt ============ */

const LANGS = { ZH: 'zh', EN: 'en', VI: 'vi' };

const DICT = {
  choose_lang: {
    zh: '请选择语言 / Please choose language / Vui lòng chọn ngôn ngữ:',
    en: 'Please choose language:',
    vi: 'Vui lòng chọn ngôn ngữ:'
  },
  lang_set: {
    zh: '✅ 语言已设置为中文。',
    en: '✅ Language set to English.',
    vi: '✅ Đã chọn Tiếng Việt.'
  },
  welcome: {
    zh: '欢迎使用员工管理机器人！请选择操作：',
    en: 'Welcome to the Staff Management Bot! Please choose an option:',
    vi: 'Chào mừng bạn đến với Bot Quản lý Nhân viên! Vui lòng chọn:'
  },
  inactive: {
    zh: '您的账号已停用，请联系管理员。',
    en: 'Your account is inactive. Please contact the administrator.',
    vi: 'Tài khoản của bạn đã bị khóa. Vui lòng liên hệ quản trị viên.'
  },
  use_menu: {
    zh: '请使用下方菜单按钮。',
    en: 'Please use the menu buttons below.',
    vi: 'Vui lòng sử dụng các nút menu bên dưới.'
  },
  cancelled: {
    zh: '操作已取消。',
    en: 'Operation cancelled.',
    vi: 'Đã hủy thao tác.'
  },
  // 主菜单按钮
  btn_submit_income: { zh: '提交收入', en: 'Submit Income', vi: 'Nộp thu nhập' },
  btn_total_income:  { zh: '总收入',   en: 'Total Income', vi: 'Tổng thu nhập' },
  btn_request_salary:{ zh: '申请工资', en: 'Request Salary', vi: 'Yêu cầu lương' },
  btn_attendance:    { zh: '打卡',     en: 'Attendance', vi: 'Chấm công' },
  btn_cancel:        { zh: '取消',     en: 'Cancel', vi: 'Hủy' },
  btn_confirm:       { zh: '确认',     en: 'Confirm', vi: 'Xác nhận' },
  btn_approve:       { zh: '✅ 批准',  en: '✅ Approve', vi: '✅ Đồng ý' },
  btn_reject:        { zh: '❌ 驳回',  en: '❌ Reject', vi: '❌ Từ chối' },
  btn_checkin:       { zh: '🟢 上班签到', en: '🟢 Check In', vi: '🟢 Vào ca' },
  btn_checkout:      { zh: '🔴 下班签退', en: '🔴 Check Out', vi: '🔴 Ra ca' },
  btn_share_location:{ zh: '📍 分享当前位置', en: '📍 Share Current Location', vi: '📍 Chia sẻ vị trí hiện tại' },

  // 收入提交
  enter_income: {
    zh: '请输入收入金额：', en: 'Enter Income Amount:', vi: 'Nhập số tiền thu nhập:'
  },
  enter_fine: {
    zh: '请输入罚款金额（如无填0）：', en: 'Enter Fine Amount (enter 0 if none):',
    vi: 'Nhập số tiền phạt (nhập 0 nếu không có):'
  },
  invalid_amount: {
    zh: '金额无效，请输入正数，例如 120.50',
    en: 'Invalid amount. Please enter a positive number, e.g. 120.50',
    vi: 'Số tiền không hợp lệ. Vui lòng nhập số dương, ví dụ 120.50'
  },
  invalid_amount_zero: {
    zh: '金额无效，请输入0或正数。',
    en: 'Invalid amount. Please enter 0 or a positive number.',
    vi: 'Số tiền không hợp lệ. Vui lòng nhập 0 hoặc số dương.'
  },
  duplicate_submission: {
    zh: '检测到重复提交，您之前的请求仍在审核中。',
    en: 'Duplicate submission detected. Your previous request is still pending.',
    vi: 'Phát hiện gửi trùng lặp. Yêu cầu trước của bạn vẫn đang chờ duyệt.'
  },
  income_submitted: {
    zh: '✅ 已提交审核。\n收入：{income}\n罚款：{fine}\n审核后会通知您。',
    en: '✅ Submitted for approval.\nIncome: {income}\nFine: {fine}\nYou will be notified once reviewed.',
    vi: '✅ Đã gửi để xét duyệt.\nThu nhập: {income}\nTiền phạt: {fine}\nBạn sẽ được thông báo sau khi xét duyệt.'
  },
  income_approved: {
    zh: '✅ 您的收入提交已被批准。\n收入：{income}  罚款：{fine}',
    en: '✅ Your income submission has been approved.\nIncome: {income}  Fine: {fine}',
    vi: '✅ Đơn thu nhập của bạn đã được duyệt.\nThu nhập: {income}  Phạt: {fine}'
  },
  income_rejected: {
    zh: '❌ 您的收入提交已被驳回。\n原因：{reason}',
    en: '❌ Your income submission has been rejected.\nReason: {reason}',
    vi: '❌ Đơn thu nhập của bạn đã bị từ chối.\nLý do: {reason}'
  },

  // 管理员审批
  admin_new_income: {
    zh: '📥 新的收入提交\n员工：{name}\nTelegram ID：{id}\n收入：{income}\n罚款：{fine}\n日期：{date}\n时间：{time}',
    en: '📥 New Income Submission\nEmployee: {name}\nTelegram ID: {id}\nIncome: {income}\nFine: {fine}\nDate: {date}\nTime: {time}',
    vi: '📥 Đơn thu nhập mới\nNhân viên: {name}\nTelegram ID: {id}\nThu nhập: {income}\nPhạt: {fine}\nNgày: {date}\nGiờ: {time}'
  },
  already_processed: {
    zh: '该请求已被处理。', en: 'This request was already processed.',
    vi: 'Yêu cầu này đã được xử lý.'
  },
  ask_reject_reason: {
    zh: '请输入驳回原因（发送 /cancel 取消）：',
    en: 'Enter rejection reason:\n(send /cancel to abort)',
    vi: 'Nhập lý do từ chối:\n(gửi /cancel để hủy)'
  },
  reason_empty: {
    zh: '原因不能为空，请重新输入：',
    en: 'Reason cannot be empty. Please enter a reason:',
    vi: 'Lý do không được để trống. Vui lòng nhập lại:'
  },
  rejection_recorded: {
    zh: '驳回已记录，员工已收到通知。',
    en: 'Rejection recorded and the employee has been notified.',
    vi: 'Đã ghi nhận từ chối và đã thông báo cho nhân viên.'
  },
  no_longer_awaiting: {
    zh: '该请求已不再需要您输入原因。',
    en: 'This request is no longer awaiting your rejection reason.',
    vi: 'Yêu cầu này không còn cần lý do từ chối của bạn.'
  },
  not_authorized: {
    zh: '您没有权限。', en: 'You are not authorized.', vi: 'Bạn không có quyền.'
  },

  // 总收入
  total_income_msg: {
    zh: '💰 当前总收入：{total}\n周期开始：{date}\n（已批准收入减罚款，含考勤罚款）',
    en: '💰 Current Total Income: {total}\nCycle started: {date}\n(Approved income minus approved fines, including attendance fines)',
    vi: '💰 Tổng thu nhập hiện tại: {total}\nBắt đầu kỳ: {date}\n(Thu nhập đã duyệt trừ tiền phạt, gồm phạt chấm công)'
  },
  nothing_to_request: {
    zh: '当前总收入：{total}\n暂无可申请金额。',
    en: 'Current Total Income: {total}\nNothing to request yet.',
    vi: 'Tổng thu nhập hiện tại: {total}\nChưa có gì để yêu cầu.'
  },

  // 工资申请
  confirm_salary: {
    zh: '当前总收入：{total}\n确认申请发薪吗？',
    en: 'Current Total Income: {total}\nConfirm Salary Request?',
    vi: 'Tổng thu nhập hiện tại: {total}\nXác nhận yêu cầu lương?'
  },
  salary_pending_exists: {
    zh: '您已有一个待审核的工资申请，请等待审核。',
    en: 'You already have a pending salary request. Please wait for review.',
    vi: 'Bạn đã có yêu cầu lương đang chờ duyệt. Vui lòng chờ.'
  },
  salary_submitted: {
    zh: '✅ 工资申请已提交，审核后会通知您。',
    en: '✅ Salary request submitted. You will be notified once reviewed.',
    vi: '✅ Đã gửi yêu cầu lương. Bạn sẽ được thông báo sau khi duyệt.'
  },
  salary_cancelled: {
    zh: '❌ 已取消。', en: '❌ Cancelled.', vi: '❌ Đã hủy.'
  },
  admin_new_salary: {
    zh: '💵 新的工资申请\n员工：{name}\nTelegram ID：{id}\n当前总收入：{total}\n申请时间：{date}',
    en: '💵 New Salary Request\nEmployee: {name}\nTelegram ID: {id}\nCurrent Total Income: {total}\nRequest Date: {date}',
    vi: '💵 Yêu cầu lương mới\nNhân viên: {name}\nTelegram ID: {id}\nTổng thu nhập hiện tại: {total}\nNgày yêu cầu: {date}'
  },
  salary_approved: {
    zh: '✅ 您的工资申请已批准。\n金额：{amount}\n周期：{start} ~ {end}\n新周期已开始。',
    en: '✅ Your salary request has been approved.\nSalary Amount: {amount}\nPeriod: {start} ~ {end}\nA new income cycle has started.',
    vi: '✅ Yêu cầu lương đã được duyệt.\nSố tiền: {amount}\nKỳ: {start} ~ {end}\nĐã bắt đầu kỳ mới.'
  },
  salary_rejected: {
    zh: '❌ 您的工资申请已被驳回。\n原因：{reason}',
    en: '❌ Your salary request has been rejected.\nReason: {reason}',
    vi: '❌ Yêu cầu lương của bạn đã bị từ chối.\nLý do: {reason}'
  },

  // 考勤
  share_location_prompt: {
    zh: '请分享您当前的位置以继续：',
    en: 'Please share your current location to continue:',
    vi: 'Vui lòng chia sẻ vị trí hiện tại để tiếp tục:'
  },
  location_received: {
    zh: '📍 已收到位置。', en: '📍 Location received.', vi: '📍 Đã nhận vị trí.'
  },
  choose_action: {
    zh: '请选择操作：', en: 'Choose an action:', vi: 'Chọn hành động:'
  },
  location_expired: {
    zh: '位置已过期，请重新点击"打卡"。',
    en: 'Location expired. Please tap Attendance again.',
    vi: 'Vị trí đã hết hạn. Vui lòng nhấn Chấm công lại.'
  },
  already_checked_in: {
    zh: '您今天（{date}）已签到。',
    en: 'You have already checked in for {date}.',
    vi: 'Bạn đã vào ca hôm nay ({date}).'
  },
  already_checked_out: {
    zh: '您今天（{date}）已签退。',
    en: 'You have already checked out for {date}.',
    vi: 'Bạn đã ra ca hôm nay ({date}).'
  },
  no_checkin_found: {
    zh: '未找到{date}的签到记录，请先签到。',
    en: 'No check-in found for {date}. Please check in first.',
    vi: 'Không tìm thấy giờ vào ca {date}. Vui lòng vào ca trước.'
  },
  checkin_recorded: {
    zh: '🟢 签到成功。\n日期：{date}\n时间：{time}',
    en: '🟢 Check-In recorded.\nDate: {date}\nTime: {time}',
    vi: '🟢 Đã ghi nhận vào ca.\nNgày: {date}\nGiờ: {time}'
  },
  checkin_late: {
    zh: '\n⚠️ 迟到 — 已扣罚款 {fine}。',
    en: '\n⚠️ LATE — fine {fine} applied.',
    vi: '\n⚠️ ĐI MUỘN — đã áp phạt {fine}.'
  },
  checkin_ontime: {
    zh: '\n按时签到。✅', en: '\nOn time. ✅', vi: '\nĐúng giờ. ✅'
  },
  checkout_recorded: {
    zh: '🔴 签退成功。\n日期：{date}\n时间：{time}',
    en: '🔴 Check-Out recorded.\nDate: {date}\nTime: {time}',
    vi: '🔴 Đã ghi nhận ra ca.\nNgày: {date}\nGiờ: {time}'
  },
  checkout_early: {
    zh: '\n⚠️ 早退 — 已扣罚款 {fine}。',
    en: '\n⚠️ EARLY LEAVE — fine {fine} applied.',
    vi: '\n⚠️ RA SỚM — đã áp phạt {fine}.'
  },
  checkout_ontime: {
    zh: '\n按时签退。✅', en: '\nOn time. ✅', vi: '\nĐúng giờ. ✅'
  },
  checked_in_label: { zh: '签到', en: 'Checked in', vi: 'Đã vào ca' },
  checked_out_label: { zh: '签退', en: 'Checked out', vi: 'Đã ra ca' }
};

/** 获取员工语言(默认英文),带缓存 */
function getUserLang(uid) {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('lang_' + uid);
  if (hit) return hit;
  const r = findRowById(SH.EMP, uid);
  const lang = (r && r.values[6]) ? r.values[6] : LANGS.EN;
  cache.put('lang_' + uid, lang, 3600);
  return lang;
}
function setUserLang(uid, lang) {
  const r = findRowById(SH.EMP, uid);
  if (r) sheet(SH.EMP).getRange(r.row, 7).setValue(lang);
  CacheService.getScriptCache().put('lang_' + uid, lang, 3600);
}

/** 翻译函数: t(uid, 'key', {placeholder: value}) */
function t(uid, key, params) {
  const lang = getUserLang(uid);
  let text = (DICT[key] && DICT[key][lang]) || (DICT[key] && DICT[key].en) || key;
  if (params) {
    Object.keys(params).forEach(function (k) {
      text = text.replace('{' + k + '}', params[k]);
    });
  }
  return text;
}

/** 语言选择键盘 */
function langSelectKb() {
  return { inline_keyboard: [[
    { text: '中文', callback_data: 'lang:zh' },
    { text: 'English', callback_data: 'lang:en' },
    { text: 'Tiếng Việt', callback_data: 'lang:vi' }
  ]] };
}
