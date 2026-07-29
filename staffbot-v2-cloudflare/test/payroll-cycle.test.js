import test from 'node:test';
import assert from 'node:assert/strict';

import {
  nextPayrollCutoff,
  payrollCutoff,
  payrollCutoffsBetween,
  payrollStartDateOptions,
  validatePayrollStartDate
} from '../src/payroll-cycle.js';

const hoChiMinhStore = { timezone: 'Asia/Ho_Chi_Minh' };

test('offers local today through five days later without a 5am cutoff', () => {
  const expected = [
    '2026-07-09',
    '2026-07-10',
    '2026-07-11',
    '2026-07-12',
    '2026-07-13',
    '2026-07-14'
  ];

  assert.deepEqual(
    payrollStartDateOptions(
      hoChiMinhStore,
      new Date('2026-07-08T21:59:00.000Z')
    ),
    expected
  );
  assert.deepEqual(
    payrollStartDateOptions(
      hoChiMinhStore,
      new Date('2026-07-08T22:01:00.000Z')
    ),
    expected
  );
});

test('accepts only a first work date from the six displayed dates', () => {
  const now = new Date('2026-07-08T22:30:00.000Z');

  assert.deepEqual(
    validatePayrollStartDate(hoChiMinhStore, '2026-07-09', now),
    { ok: true, date: '2026-07-09' }
  );
  assert.deepEqual(
    validatePayrollStartDate(hoChiMinhStore, '2026-07-14', now),
    { ok: true, date: '2026-07-14' }
  );
  assert.deepEqual(
    validatePayrollStartDate(hoChiMinhStore, '2026-07-08', now),
    { ok: false, error: 'payroll_start_date_outside_window' }
  );
  assert.deepEqual(
    validatePayrollStartDate(hoChiMinhStore, '2026-07-15', now),
    { ok: false, error: 'payroll_start_date_outside_window' }
  );
  assert.deepEqual(
    validatePayrollStartDate(hoChiMinhStore, 'not-a-date', now),
    { ok: false, error: 'payroll_start_date_outside_window' }
  );
});

test('uses the first work date as day one of every 30-day cycle', () => {
  const cutoffs = [0, 1].flatMap((cycleIndex) =>
    [16, 30].map((cycleDay) =>
      payrollCutoff('2026-07-01', cycleDay, cycleIndex, 'Asia/Tokyo')
    )
  );

  assert.deepEqual(
    cutoffs.map((cutoff) => cutoff.scheduled_date),
    ['2026-07-16', '2026-07-30', '2026-08-15', '2026-08-29']
  );
  assert.deepEqual(cutoffs[0], {
    scheduled_date: '2026-07-16',
    cutoff_at: '2026-07-16T03:00:00.000Z',
    cycle_day: 16,
    cycle_index: 0
  });
});

test('keeps the cutoff at local noon across daylight-saving changes', () => {
  assert.equal(
    payrollCutoff(
      '2026-02-20',
      16,
      0,
      'America/New_York'
    ).cutoff_at,
    '2026-03-07T17:00:00.000Z'
  );
  assert.equal(
    payrollCutoff(
      '2026-02-20',
      30,
      0,
      'America/New_York'
    ).cutoff_at,
    '2026-03-21T16:00:00.000Z'
  );
  assert.equal(
    payrollCutoff(
      '2026-10-19',
      16,
      0,
      'America/New_York'
    ).cutoff_at,
    '2026-11-03T17:00:00.000Z'
  );
});

test('returns due cutoffs strictly after the saved boundary', () => {
  assert.deepEqual(
    payrollCutoffsBetween(
      '2026-07-01',
      'Asia/Tokyo',
      '2026-07-16T03:00:00.000Z',
      '2026-08-15T03:00:00.000Z'
    ).map((cutoff) => cutoff.scheduled_date),
    ['2026-07-30', '2026-08-15']
  );
  assert.deepEqual(
    payrollCutoffsBetween(
      '2026-07-01',
      'Asia/Tokyo',
      '2026-08-15T03:00:00.000Z',
      '2026-08-15T03:00:00.000Z'
    ),
    []
  );
});

test('returns the next cutoff strictly after a timestamp', () => {
  assert.deepEqual(
    nextPayrollCutoff(
      '2026-07-01',
      'Asia/Tokyo',
      '2026-07-30T03:00:00.000Z'
    ),
    {
      scheduled_date: '2026-08-15',
      cutoff_at: '2026-08-15T03:00:00.000Z',
      cycle_day: 16,
      cycle_index: 1
    }
  );
});

test('rejects unsupported cycle days and indexes', () => {
  assert.throws(
    () => payrollCutoff('2026-07-01', 15, 0, 'Asia/Tokyo'),
    /invalid payroll cycle day/
  );
  assert.throws(
    () => payrollCutoff('2026-07-01', 16, -1, 'Asia/Tokyo'),
    /invalid payroll cycle index/
  );
  assert.throws(
    () => payrollCutoff('2026-07-01', 16, 0.5, 'Asia/Tokyo'),
    /invalid payroll cycle index/
  );
});
