import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DashboardInputError,
  dashboardAvailable,
  dashboardPeriods,
  dashboardPeriodsJson,
  dashboardSelection
} from '../src/dashboard.js';

const stores = [
  {
    store_id: 'TOKYO',
    timezone: 'Asia/Tokyo',
    currency: '¥'
  },
  {
    store_id: 'NEW_YORK',
    timezone: 'America/New_York',
    currency: '$'
  }
];

test('enables Dashboard only in staging', () => {
  assert.equal(dashboardAvailable({ ENVIRONMENT: 'staging' }), true);
  assert.equal(dashboardAvailable({ ENVIRONMENT: 'production' }), false);
  assert.equal(dashboardAvailable({}), false);
});

test('defaults Dashboard to the fallback store local current month', () => {
  assert.deepEqual(
    dashboardSelection('', '', 'Asia/Tokyo', new Date('2026-07-31T16:00:00.000Z')),
    { date_from: '2026-08-01', date_to: '2026-08-31' }
  );
});

test('requires two valid ordered Dashboard dates', () => {
  for (const pair of [
    ['2026-07-01', ''],
    ['', '2026-07-31'],
    ['2026-07-32', '2026-08-01'],
    ['2026-08-01', '2026-07-31']
  ]) {
    assert.throws(
      () => dashboardSelection(pair[0], pair[1], 'Asia/Tokyo'),
      (error) => error instanceof DashboardInputError
        && error.code === 'invalid_date_range'
    );
  }
});

test('builds one UTC range per store local month', () => {
  const periods = dashboardPeriods(stores, {
    date_from: '2026-07-01',
    date_to: '2026-07-31'
  });

  assert.deepEqual(periods, [
    {
      store_id: 'TOKYO',
      store_currency: '¥',
      timezone: 'Asia/Tokyo',
      month_key: '2026-07',
      start_iso: '2026-06-30T15:00:00.000Z',
      end_iso: '2026-07-31T15:00:00.000Z'
    },
    {
      store_id: 'NEW_YORK',
      store_currency: '$',
      timezone: 'America/New_York',
      month_key: '2026-07',
      start_iso: '2026-07-01T04:00:00.000Z',
      end_iso: '2026-08-01T04:00:00.000Z'
    }
  ]);
  assert.deepEqual(JSON.parse(dashboardPeriodsJson(periods)), periods);
});

test('clips a two-month selection into non-overlapping monthly store ranges', () => {
  const periods = dashboardPeriods(stores, {
    date_from: '2026-07-15',
    date_to: '2026-08-10'
  });

  assert.deepEqual(periods, [
    {
      store_id: 'TOKYO',
      store_currency: '¥',
      timezone: 'Asia/Tokyo',
      month_key: '2026-07',
      start_iso: '2026-07-14T15:00:00.000Z',
      end_iso: '2026-07-31T15:00:00.000Z'
    },
    {
      store_id: 'NEW_YORK',
      store_currency: '$',
      timezone: 'America/New_York',
      month_key: '2026-07',
      start_iso: '2026-07-15T04:00:00.000Z',
      end_iso: '2026-08-01T04:00:00.000Z'
    },
    {
      store_id: 'TOKYO',
      store_currency: '¥',
      timezone: 'Asia/Tokyo',
      month_key: '2026-08',
      start_iso: '2026-07-31T15:00:00.000Z',
      end_iso: '2026-08-10T15:00:00.000Z'
    },
    {
      store_id: 'NEW_YORK',
      store_currency: '$',
      timezone: 'America/New_York',
      month_key: '2026-08',
      start_iso: '2026-08-01T04:00:00.000Z',
      end_iso: '2026-08-11T04:00:00.000Z'
    }
  ]);
  assert.equal(periods[0].end_iso, periods[2].start_iso);
  assert.equal(periods[1].end_iso, periods[3].start_iso);
});
