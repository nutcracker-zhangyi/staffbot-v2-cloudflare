import { normalizePositiveInt } from './validation.js';

function parseIsoDate(value) {
  const dateText = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) return null;
  const [year, month, day] = dateText.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.toISOString().slice(0, 10) !== dateText) return null;
  return dateText;
}

export function dateRange(dateFrom, dateTo, timezone = 'UTC') {
  const from = parseIsoDate(dateFrom);
  const to = parseIsoDate(dateTo);
  if (!from && !to) return { startIso: '', endIso: '', startDate: '', endDate: '' };
  let startDate = from || '';
  let endDate = to || '';
  if (startDate && endDate && startDate > endDate) {
    const temp = startDate;
    startDate = endDate;
    endDate = temp;
  }
  const endExclusive = endDate ? addIsoDays(endDate, 1) : '';
  return {
    startIso: startDate ? zonedMidnightIso(startDate, timezone) : '',
    endIso: endExclusive ? zonedMidnightIso(endExclusive, timezone) : '',
    startDate,
    endDate: endExclusive
  };
}

export function zonedMidnightIso(isoDate, timezone) {
  const [year, month, day] = isoDate.split('-').map(Number);
  let utc = Date.UTC(year, month - 1, day);
  const target = Date.UTC(year, month - 1, day);
  for (let i = 0; i < 3; i += 1) {
    const parts = zonedParts(new Date(utc), timezone || 'UTC');
    const seen = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    utc += target - seen;
  }
  return new Date(utc).toISOString();
}

function zonedParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

export function formatAdminDateTime(value, timezone = 'Asia/Tokyo') {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text.replaceAll('-', '/') + ' 00:00:00';
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date);
  const map = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${map.year}/${map.month}/${map.day} ${map.hour}:${map.minute}:${map.second}`;
}

export function formatLocalDateTime(
  value,
  timezone = 'Asia/Tokyo'
) {
  const text = String(value || '').trim();
  if (!text) return '';
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  const parts = localParts(
    date,
    timezone || 'Asia/Tokyo'
  );
  return [
    `${parts.year}/${parts.month}/${parts.day}`,
    `${parts.hour}:${parts.minute}`
  ].join(' ');
}

export function formatAdminShortDateHour(value, timezone = 'Asia/Tokyo') {
  const text = String(value || '').trim();
  if (!text) return '';
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'Asia/Tokyo',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false
  }).formatToParts(date);
  const map = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${map.month}/${map.day} ${map.hour}点`;
}

export function localParts(date, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
}

export function localTime(date, tz) {
  const p = localParts(date, tz);
  return `${p.hour}:${p.minute}`;
}

export function localDate(date, tz) {
  const p = localParts(date, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

export function completedAttendanceDate(now = new Date(), timezone = 'Asia/Tokyo') {
  const today = localDate(now, timezone);
  const hour = Number(localParts(now, timezone).hour);
  return addIsoDays(today, hour >= 12 ? -1 : -2);
}

export function absenceScanDates(store, now = new Date()) {
  if (!store || !store.absence_fine_enabled_at) return [];
  const timezone = store.timezone || 'Asia/Tokyo';
  const enabledDate = localDate(new Date(store.absence_fine_enabled_at), timezone);
  const firstDate = store.absence_last_checked_date
    ? addIsoDays(store.absence_last_checked_date, 1)
    : enabledDate;
  const finalDate = completedAttendanceDate(now, timezone);
  const dates = [];
  for (let date = firstDate; date <= finalDate; date = addIsoDays(date, 1)) dates.push(date);
  return dates;
}

export function getBusinessDate(date, tz) {
  const p = localParts(date, tz);
  const hour = Number(p.hour);
  if (hour >= 12) return `${p.year}-${p.month}-${p.day}`;
  const prev = new Date(date.getTime() - 24 * 60 * 60 * 1000);
  const q = localParts(prev, tz);
  return `${q.year}-${q.month}-${q.day}`;
}

export function minutesOf(hhmm) {
  const [hRaw, mRaw] = String(hhmm).split(':');
  let h = Number(hRaw);
  const m = Number(mRaw || 0);
  if (h < 12) h += 24;
  return h * 60 + m;
}

export function validateLeaveDate(store, value, now = new Date()) {
  const date = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'invalid_format' };
  const tz = (store && store.timezone) || 'Asia/Tokyo';
  const minDays = normalizePositiveInt(store && store.leave_min_notice_days, 1, 1, 365);
  const maxDays = Math.max(normalizePositiveInt(store && store.leave_max_notice_days, 5, 1, 365), minDays);
  const today = localDate(now, tz);
  const minDate = addIsoDays(today, leaveWindowMinDays(store, now, tz));
  const maxDate = addIsoDays(today, maxDays);
  if (date < minDate || date > maxDate) return { ok: false, error: 'outside_window', min_date: minDate, max_date: maxDate };
  return { ok: true, date };
}

export function leaveDateOptions(store, now = new Date()) {
  const tz = (store && store.timezone) || 'Asia/Tokyo';
  const minDays = leaveWindowMinDays(store, now, tz);
  const maxDays = Math.max(normalizePositiveInt(store && store.leave_max_notice_days, 5, 1, 365), minDays);
  const today = localDate(now, tz);
  const dates = [];
  for (let day = minDays; day <= maxDays; day += 1) {
    dates.push(addIsoDays(today, day));
  }
  return dates;
}

function leaveWindowMinDays(store, now, tz) {
  const minDays = normalizePositiveInt(store && store.leave_min_notice_days, 1, 1, 365);
  const cutoffHour = normalizePositiveInt(store && store.leave_same_day_cutoff_hour, 5, 0, 23);
  return minDays === 1 && Number(localParts(now, tz).hour) < cutoffHour ? 0 : minDays;
}

export function leaveMonthRange(leaveDate) {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(leaveDate || '');
  if (!match) return { startDate: '', endDate: '' };
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const start = new Date(Date.UTC(year, monthIndex, 1));
  const end = new Date(Date.UTC(year, monthIndex + 1, 1));
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10)
  };
}

export function addIsoDays(isoDate, days) {
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + Number(days || 0)));
  return date.toISOString().slice(0, 10);
}

export function leaveRuleParams(store, now = new Date()) {
  const tz = (store && store.timezone) || 'Asia/Tokyo';
  const min = leaveWindowMinDays(store, now, tz);
  const max = Math.max(normalizePositiveInt(store && store.leave_max_notice_days, 5, 1, 365), min);
  return { min, max };
}
