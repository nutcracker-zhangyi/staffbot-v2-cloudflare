import test from 'node:test';
import assert from 'node:assert/strict';

import { requireManageMutation } from '../src/admin-auth.js';
import { adminOrderSql } from '../src/admin-query.js';
import { dateRange } from '../src/dates.js';
import { json } from '../src/http.js';
import { calculateIncomeRowsTotal } from '../src/money.js';
import { serviceEnvironment } from '../src/security.js';

test('exposes money calculations from their owner module', () => {
  assert.equal(calculateIncomeRowsTotal([
    { commission_income: 60, fine: 0 },
    { commission_income: 0, fine: 5 }
  ]), 55);
});

test('exposes timezone date ranges from their owner module', () => {
  assert.deepEqual(dateRange(
    '2026-07-01',
    '2026-07-01',
    'Asia/Tokyo'
  ), {
    startIso: '2026-06-30T15:00:00.000Z',
    endIso: '2026-07-01T15:00:00.000Z',
    startDate: '2026-07-01',
    endDate: '2026-07-02'
  });
});

test('exposes service environment policy from its owner module', () => {
  assert.equal(serviceEnvironment({ ENVIRONMENT: 'staging' }), 'staging');
  assert.equal(serviceEnvironment({ ENVIRONMENT: 'typo' }), 'unknown');
});

test('exposes allowlisted admin ordering from its owner module', () => {
  const url = new URL(
    'https://staffbot.test/admin?records_sort=approved_at&records_dir=asc'
  );
  assert.equal(
    adminOrderSql(
      url,
      'records_page',
      { approved_at: 'r.approved_at' },
      'ORDER BY r.approved_at DESC',
      'r.record_id'
    ),
    'ORDER BY r.approved_at ASC, r.record_id'
  );
});

test('exposes hardened JSON responses from their owner module', async () => {
  const response = json({ ok: true }, 201);

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
});

test('manage mutations require the exact session CSRF token', () => {
  const session = { csrf_token: 'CSRF-expected' };

  assert.equal(requireManageMutation(new Request(
    'https://staffbot.test/api/manage/task',
    { headers: { 'x-csrf-token': 'CSRF-expected' } }
  ), session), true);
  assert.equal(requireManageMutation(new Request(
    'https://staffbot.test/api/manage/task',
    { headers: { 'x-csrf-token': 'csrf-expected' } }
  ), session), false);
  assert.equal(requireManageMutation(new Request(
    'https://staffbot.test/api/manage/task'
  ), session), false);
  assert.equal(requireManageMutation(new Request(
    'https://staffbot.test/api/manage/task',
    { headers: { 'x-csrf-token': 'CSRF-expected' } }
  ), null), false);
});
