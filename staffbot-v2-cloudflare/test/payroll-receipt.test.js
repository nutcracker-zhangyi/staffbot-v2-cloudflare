import test from 'node:test';
import assert from 'node:assert/strict';

import * as payrollNotifications
  from '../src/payroll-notifications.js';

const confirmedPayroll = {
  employee_name: 'Alice',
  telegram_id: '1001',
  store_name: 'Tokyo Club',
  timezone: 'Asia/Tokyo',
  period_start: '2026-07-30T03:00:00.000Z',
  cutoff_at: '2026-08-13T03:00:00.000Z',
  amount_snapshot_micros: 8_000_000_000_000,
  bank_micros: 5_000_000_000_000,
  usdt_micros: 3_000_000_000_000,
  cash_micros: 0,
  currency: '₫',
  confirmed_at: '2026-08-13T11:15:00.000Z',
  payment_version: 2,
  payroll_id: 'PAYROLL:DEFAULT:1001:2026-08-13'
};

test('renders a traceable Chinese payroll receipt in store time', () => {
  assert.equal(
    payrollNotifications.payrollReceiptMessage({
      ...confirmedPayroll,
      language: 'zh'
    }),
    [
      '✅ 工资收款已确认',
      '',
      '员工：Alice',
      'Telegram ID：1001',
      '店铺：Tokyo Club',
      '',
      '工资周期：',
      '2026/07/30 12:00 至 2026/08/13 12:00',
      '',
      '工资总额：₫8,000,000',
      '银行卡：₫5,000,000',
      'USDT：₫3,000,000',
      '',
      '确认时间：2026/08/13 20:15',
      '付款版本：2',
      '工资 ID：PAYROLL:DEFAULT:1001:2026-08-13'
    ].join('\n')
  );
});

test('renders every supported language without unresolved fields', () => {
  for (const language of ['zh', 'en', 'vi', 'ru']) {
    const message = payrollNotifications.payrollReceiptMessage({
      ...confirmedPayroll,
      language
    });
    assert.match(message, /Alice/);
    assert.match(message, /1001/);
    assert.match(message, /Tokyo Club/);
    assert.match(message, /2026\/07\/30 12:00/);
    assert.match(message, /2026\/08\/13 20:15/);
    assert.match(message, /₫8,000,000/);
    assert.match(message, /₫5,000,000/);
    assert.match(message, /₫3,000,000/);
    assert.match(message, /2/);
    assert.doesNotMatch(
      message,
      /Cash|现金|Tiền mặt|Наличные/
    );
    assert.doesNotMatch(message, /\{[a-z_]+\}/);
  }
});
