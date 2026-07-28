import { addIsoDays, dateRange, localDate } from './dates.js';
import { serviceEnvironment } from './security.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class DashboardInputError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'DashboardInputError';
    this.code = code;
    this.status = status;
  }
}

export function dashboardAvailable(env) {
  return serviceEnvironment(env) === 'staging';
}

function validIsoDate(value) {
  const text = String(value || '').trim();
  if (!ISO_DATE.test(text)) return '';
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text
    ? ''
    : text;
}

function lastDayOfMonth(isoDate) {
  const [year, month] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

export function dashboardSelection(
  dateFromRaw,
  dateToRaw,
  fallbackTimezone = 'UTC',
  now = new Date()
) {
  const rawFrom = String(dateFromRaw || '').trim();
  const rawTo = String(dateToRaw || '').trim();
  if (!rawFrom && !rawTo) {
    const currentLocalDate = localDate(now, fallbackTimezone || 'UTC');
    const dateFrom = `${currentLocalDate.slice(0, 7)}-01`;
    return {
      date_from: dateFrom,
      date_to: lastDayOfMonth(dateFrom)
    };
  }
  const dateFrom = validIsoDate(rawFrom);
  const dateTo = validIsoDate(rawTo);
  if (!dateFrom || !dateTo || dateFrom > dateTo) {
    throw new DashboardInputError('invalid_date_range');
  }
  return { date_from: dateFrom, date_to: dateTo };
}

function monthSegments(dateFrom, dateTo) {
  const segments = [];
  let cursor = dateFrom;
  while (cursor <= dateTo) {
    const segmentEnd = [lastDayOfMonth(cursor), dateTo].sort()[0];
    segments.push({
      month_key: cursor.slice(0, 7),
      date_from: cursor,
      date_to: segmentEnd
    });
    cursor = addIsoDays(segmentEnd, 1);
  }
  return segments;
}

export function dashboardPeriods(stores, selection) {
  return monthSegments(selection.date_from, selection.date_to).flatMap((segment) =>
    stores.map((store) => {
      const range = dateRange(
        segment.date_from,
        segment.date_to,
        store.timezone || 'UTC'
      );
      return {
        store_id: store.store_id,
        store_currency: store.currency,
        timezone: store.timezone || 'UTC',
        month_key: segment.month_key,
        start_iso: range.startIso,
        end_iso: range.endIso
      };
    })
  );
}

export function dashboardPeriodsJson(periods) {
  return JSON.stringify(periods);
}
