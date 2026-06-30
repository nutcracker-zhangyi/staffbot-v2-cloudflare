import test from 'node:test';
import assert from 'node:assert/strict';

import {
  attendanceFineAmount,
  approvedIncomeRecordDrafts,
  calculateCommissionIncome,
  calculateIncomeRowsTotal,
  calculateNetIncome,
  calculateSalaryAmount,
  checkoutFineRecordDrafts,
  checkoutFineWaiverAmount,
  compactCallbackData,
  formatMoney,
  incomeAdminNotificationText,
  parseStoreAmount,
  render
} from '../src/index.js';

test('parses VND employee input as millions', () => {
  assert.equal(parseStoreAmount({ currency: '₫' }, '3', false), 3000000);
  assert.equal(parseStoreAmount({ currency: 'VND' }, '0.5', true), 500000);
});

test('normalizes configured attendance fines by store currency', () => {
  assert.equal(attendanceFineAmount({ currency: 'VND' }, 0.5), 500000);
  assert.equal(attendanceFineAmount({ currency: '$' }, 0.5), 0.5);
});

test('keeps non-VND employee input as the entered amount', () => {
  assert.equal(parseStoreAmount({ currency: '$' }, '3', false), 3);
});

test('formats VND amounts without decimals', () => {
  assert.equal(formatMoney({ currency: '₫' }, 3000000), '₫3,000,000');
});

test('calculates salary by commission rate', () => {
  assert.equal(calculateSalaryAmount(1000000, 0.6), 600000);
  assert.equal(calculateSalaryAmount(1000000, 0.5), 500000);
});

test('calculates commission income from gross income and rate', () => {
  assert.equal(calculateCommissionIncome(3000000, 0.6), 1800000);
});

test('calculates net income from commission income minus fine', () => {
  assert.equal(calculateNetIncome(3000000, 500000, 0.6), 1300000);
});

test('creates a negative waiver only when checkout fine is waived', () => {
  assert.equal(checkoutFineWaiverAmount(500000, false), 0);
  assert.equal(checkoutFineWaiverAmount(500000, true), -500000);
  assert.equal(checkoutFineWaiverAmount(0, true), 0);
});

test('keeps original fine when checkout fine is waived', () => {
  assert.deepEqual(checkoutFineRecordDrafts(500000, false), [{ fine: 0, original_fine: 500000 }]);
  assert.deepEqual(checkoutFineRecordDrafts(500000, true), [{ fine: 500000, original_fine: 500000 }]);
  assert.deepEqual(checkoutFineRecordDrafts(0, true), []);
});

test('splits approved income fines into linked fine records', () => {
  const rows = approvedIncomeRecordDrafts({
    request_id: 'INC-1',
    store_id: 'STORE1',
    telegram_id: 'U1',
    income: 3000000,
    commission_rate: 0.6,
    commission_income: 1800000,
    fine: 500000
  }, 'ADMIN1', '2026-06-26T00:00:00.000Z', ['REC-1', 'REC-2']);

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.type), ['income', 'fine']);
  assert.equal(rows[0].fine, 0);
  assert.equal(rows[1].income, 0);
  assert.equal(rows[1].fine, 500000);
  assert.equal(rows[1].original_fine, 500000);
  assert.equal(rows[1].request_id, 'INC-1');
});

test('totals commission income plus separate fine rows', () => {
  assert.equal(calculateIncomeRowsTotal([
    { type: 'income', commission_income: 1800000, fine: 0 },
    { type: 'fine', commission_income: 0, fine: 500000 },
    { type: 'fine', commission_income: 0, fine: -500000 }
  ]), 1800000 - 500000 + 500000);
});

test('totals salary advance rows as payroll deductions', () => {
  assert.equal(calculateIncomeRowsTotal([
    { type: 'income', commission_income: 1800000, fine: 0 },
    { type: 'advance', commission_income: 0, fine: 500000 }
  ]), 1300000);
});

test('income employee messages do not mention fines', () => {
  const params = {
    store: '店铺A',
    income: '₫3,000,000',
    commission: '60%',
    commission_income: '₫1,800,000',
    fine: '₫500,000'
  };

  assert.equal(render('zh', 'income_submitted', params).includes('罚款'), false);
  assert.equal(render('zh', 'income_approved', params).includes('罚款'), false);
});

test('income admin approval notification does not mention fines', () => {
  const text = incomeAdminNotificationText({
    storeName: '店铺A',
    employeeName: '员工A',
    userId: '1001',
    income: '₫3,000,000',
    commission: '60%',
    commissionIncome: '₫1,800,000',
    fine: '₫500,000',
    requestId: 'INC-1'
  });

  assert.equal(text.includes('罚款'), false);
});

test('keeps payroll approval callback data under Telegram limit', () => {
  const salaryId = 'SALREQ-01f21cc1-dcff-4f1a-9bf8-2008d650d46e';
  const advanceId = 'ADV-01f21cc1-dcff-4f1a-9bf8-2008d650d46e';

  assert.ok(compactCallbackData('sal', 'a', 'DEFAULT', salaryId).length <= 64);
  assert.ok(compactCallbackData('sal', 'r', 'DEFAULT', salaryId).length <= 64);
  assert.ok(compactCallbackData('adv', 'a', 'DEFAULT', advanceId).length <= 64);
  assert.ok(compactCallbackData('adv', 'r', 'DEFAULT', advanceId).length <= 64);
});
