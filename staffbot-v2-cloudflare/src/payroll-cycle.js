import { addIsoDays, localDate } from './dates.js';

function zonedLocalHourIso(isoDate, hour, timezone) {
  const [year, month, day] = isoDate.split('-').map(Number);
  const target = Date.UTC(year, month - 1, day, hour, 0, 0);
  let utc = target;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(new Date(utc));
    const value = Object.fromEntries(
      parts
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, Number(part.value)])
    );
    const seen = Date.UTC(
      value.year,
      value.month - 1,
      value.day,
      value.hour,
      value.minute,
      value.second
    );
    utc += target - seen;
  }

  return new Date(utc).toISOString();
}

export function payrollStartDateOptions(store, now = new Date()) {
  const timezone = store && store.timezone
    ? store.timezone
    : 'Asia/Tokyo';
  const today = localDate(now, timezone);
  return Array.from({ length: 6 }, (_, day) => addIsoDays(today, day));
}

export function validatePayrollStartDate(store, rawDate, now = new Date()) {
  const date = String(rawDate || '').trim();
  return payrollStartDateOptions(store, now).includes(date)
    ? { ok: true, date }
    : { ok: false, error: 'payroll_start_date_outside_window' };
}

export function payrollCutoff(
  anchorDate,
  cycleDay,
  cycleIndex,
  timezone
) {
  if (![16, 30].includes(cycleDay)) {
    throw new RangeError('invalid payroll cycle day');
  }
  if (!Number.isInteger(cycleIndex) || cycleIndex < 0) {
    throw new RangeError('invalid payroll cycle index');
  }

  const scheduledDate = addIsoDays(
    anchorDate,
    cycleDay - 1 + cycleIndex * 30
  );
  return {
    scheduled_date: scheduledDate,
    cutoff_at: zonedLocalHourIso(scheduledDate, 12, timezone),
    cycle_day: cycleDay,
    cycle_index: cycleIndex
  };
}

export function payrollCutoffsBetween(
  anchorDate,
  timezone,
  afterIso,
  throughIso
) {
  const cutoffs = [];
  for (let cycleIndex = 0; ; cycleIndex += 1) {
    for (const cycleDay of [16, 30]) {
      const cutoff = payrollCutoff(
        anchorDate,
        cycleDay,
        cycleIndex,
        timezone
      );
      if (cutoff.cutoff_at > throughIso) return cutoffs;
      if (cutoff.cutoff_at > afterIso) cutoffs.push(cutoff);
    }
  }
}

export function nextPayrollCutoff(anchorDate, timezone, afterIso) {
  for (let cycleIndex = 0; ; cycleIndex += 1) {
    for (const cycleDay of [16, 30]) {
      const cutoff = payrollCutoff(
        anchorDate,
        cycleDay,
        cycleIndex,
        timezone
      );
      if (cutoff.cutoff_at > afterIso) return cutoff;
    }
  }
}
