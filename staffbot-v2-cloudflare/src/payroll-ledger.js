export const MICROS_PER_UNIT = 1_000_000;

export const PAYROLL_ENTRY_TYPES = new Set([
  'income',
  'fine',
  'advance',
  'bonus',
  'adjustment',
  'reversal',
  'negative_carry'
]);

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

function requireIsoUtc(value, field) {
  requireText(value, field);
  if (new Date(value).toISOString() !== value) {
    throw new TypeError(`${field} must be an ISO UTC timestamp`);
  }
}

export function amountToMicros(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value)) {
    throw new TypeError('amount must be a finite number');
  }
  const micros = Math.round(value * MICROS_PER_UNIT);
  if (!Number.isSafeInteger(micros)) {
    throw new RangeError('amount micros must be a JavaScript safe integer');
  }
  return micros;
}

export function legacyPayrollImpactMicros(record) {
  switch (record && record.type) {
    case 'income':
      return amountToMicros(record.commission_income);
    case 'fine':
    case 'advance':
      return -amountToMicros(record.fine);
    default:
      throw new TypeError(`unsupported legacy payroll type: ${record && record.type}`);
  }
}

export function validatePayrollEntry(entry, originalEntry = null) {
  if (!entry || typeof entry !== 'object') {
    throw new TypeError('payroll entry is required');
  }
  requireText(entry.entry_id, 'entry_id');
  requireText(entry.store_id, 'store_id');
  requireText(entry.telegram_id, 'telegram_id');
  requireText(entry.type, 'type');
  requireText(entry.currency, 'currency');
  requireText(entry.source, 'source');
  requireText(entry.created_by, 'created_by');
  requireIsoUtc(entry.effective_at, 'effective_at');
  requireIsoUtc(entry.created_at, 'created_at');

  if (!PAYROLL_ENTRY_TYPES.has(entry.type)) {
    throw new TypeError(`unsupported payroll entry type: ${entry.type}`);
  }
  if (!Number.isSafeInteger(entry.amount_micros)) {
    throw new RangeError('amount_micros must be a JavaScript safe integer');
  }
  if (entry.source_id !== null && entry.source_id !== undefined) {
    requireText(entry.source_id, 'source_id');
  }
  requireText(entry.metadata_json, 'metadata_json');
  try {
    JSON.parse(entry.metadata_json);
  } catch {
    throw new TypeError('metadata_json must be valid JSON');
  }

  if (entry.type === 'income' || entry.type === 'bonus') {
    if (entry.amount_micros <= 0) {
      throw new RangeError(`${entry.type} amount_micros must be positive`);
    }
  } else if (entry.type === 'fine' || entry.type === 'advance' || entry.type === 'negative_carry') {
    if (entry.amount_micros >= 0) {
      throw new RangeError(`${entry.type} amount_micros must be negative`);
    }
  } else if (entry.type === 'adjustment') {
    if (entry.amount_micros === 0) {
      throw new RangeError('adjustment amount_micros must be non-zero');
    }
  } else {
    if (!originalEntry) {
      throw new TypeError('reversal requires the original entry');
    }
    if (entry.reverses_entry_id !== originalEntry.entry_id) {
      throw new TypeError('reversal must reference the original entry');
    }
    if (entry.amount_micros !== -originalEntry.amount_micros) {
      throw new RangeError('reversal amount_micros must be the exact opposite');
    }
    if (entry.store_id !== originalEntry.store_id) {
      throw new TypeError('reversal must use the same store');
    }
    if (entry.telegram_id !== originalEntry.telegram_id) {
      throw new TypeError('reversal must use the same employee');
    }
    if (entry.currency !== originalEntry.currency) {
      throw new TypeError('reversal must use the same currency');
    }
  }

  if (entry.type !== 'reversal' && entry.reverses_entry_id) {
    throw new TypeError('only a reversal may reference an original entry');
  }
  return entry;
}

export function legacyIncomeRecordToPayrollEntry(record, currency, createdAt) {
  const amountMicros = legacyPayrollImpactMicros(record);
  if (amountMicros === 0) return null;

  const entry = {
    entry_id: `PAY-MIG-${record.record_id}`,
    store_id: record.store_id,
    telegram_id: record.telegram_id,
    type: record.type,
    amount_micros: amountMicros,
    currency,
    effective_at: record.approved_at,
    source: record.source,
    source_id: record.record_id,
    created_by: record.admin_id,
    created_at: createdAt,
    reverses_entry_id: null,
    metadata_json: JSON.stringify({
      legacy_record_id: record.record_id,
      legacy_request_id: record.request_id ?? null,
      legacy_income: Number(record.income || 0),
      legacy_commission_rate: Number(record.commission_rate || 0),
      legacy_commission_income: Number(record.commission_income || 0),
      legacy_original_fine: Number(record.original_fine || 0),
      legacy_fine: Number(record.fine || 0)
    })
  };
  return validatePayrollEntry(entry);
}
