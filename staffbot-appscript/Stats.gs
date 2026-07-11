function calcTotal(uid) {
  const emp = findRowById(SH.EMP, uid);
  if (!emp) return 0;
  const cycleStart = new Date(emp.values[4]);
  const data = sheet(SH.INC).getDataRange().getValues();
  let total = 0;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][1]) !== uid) continue;
    if (new Date(data[i][6]) < cycleStart) continue;
    total += Number(data[i][2]) - Number(data[i][3]);
  }
  return Math.round(total * 100) / 100;
}

function showTotal(uid, chatId) {
  const total = calcTotal(uid);
  const emp = findRowById(SH.EMP, uid);
  send(chatId, t(uid, 'total_income_msg', {
    total: fmtMoney(total), date: String(emp.values[4]).substring(0, 10)
  }), mainMenuKb(uid));
}
