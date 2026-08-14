export function validTime(value) {
  return /^\d{2}:\d{2}$/.test(String(value || ''));
}

export function normalizePositiveInt(value, fallback, min, max) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}
