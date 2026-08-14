WITH
legacy_current AS (
  SELECT
    m.store_id,
    m.telegram_id,
    m.cycle_start AS period_start,
    s.currency,
    COALESCE(SUM(
      ROUND((i.commission_income - i.fine) * 1000000)
    ), 0) AS legacy_micros
  FROM store_members m
  JOIN stores s ON s.store_id = m.store_id
  LEFT JOIN income_records i
    ON i.store_id = m.store_id
   AND i.telegram_id = m.telegram_id
   AND i.approved_at >= m.cycle_start
  GROUP BY m.store_id, m.telegram_id, m.cycle_start, s.currency
),
ledger_current AS (
  SELECT
    m.store_id,
    m.telegram_id,
    m.cycle_start AS period_start,
    s.currency,
    COALESCE(SUM(p.amount_micros), 0) AS ledger_micros
  FROM store_members m
  JOIN stores s ON s.store_id = m.store_id
  LEFT JOIN payroll_entries p
    ON p.store_id = m.store_id
   AND p.telegram_id = m.telegram_id
   AND p.effective_at >= m.cycle_start
  GROUP BY m.store_id, m.telegram_id, m.cycle_start, s.currency
),
current_differences AS (
  SELECT
    'current_cycle' AS scope,
    l.store_id || ':' || l.telegram_id AS scope_id,
    l.store_id,
    l.telegram_id,
    l.period_start,
    NULL AS period_end,
    l.currency,
    NULL AS entry_type,
    l.legacy_micros,
    n.ledger_micros,
    n.ledger_micros - l.legacy_micros AS difference_micros
  FROM legacy_current l
  JOIN ledger_current n
    ON n.store_id = l.store_id
   AND n.telegram_id = l.telegram_id
   AND n.period_start = l.period_start
   AND n.currency = l.currency
  WHERE n.ledger_micros != l.legacy_micros
),
legacy_history AS (
  SELECT
    r.record_id AS scope_id,
    r.store_id,
    r.telegram_id,
    r.period_start,
    r.period_end,
    s.currency,
    COALESCE(SUM(
      ROUND((i.commission_income - i.fine) * 1000000)
    ), 0) AS legacy_micros
  FROM salary_records r
  JOIN stores s ON s.store_id = r.store_id
  LEFT JOIN income_records i
    ON i.store_id = r.store_id
   AND i.telegram_id = r.telegram_id
   AND i.approved_at >= r.period_start
   AND i.approved_at < r.period_end
  GROUP BY
    r.record_id,
    r.store_id,
    r.telegram_id,
    r.period_start,
    r.period_end,
    s.currency
),
ledger_history AS (
  SELECT
    r.record_id AS scope_id,
    r.store_id,
    r.telegram_id,
    r.period_start,
    r.period_end,
    s.currency,
    COALESCE(SUM(p.amount_micros), 0) AS ledger_micros
  FROM salary_records r
  JOIN stores s ON s.store_id = r.store_id
  LEFT JOIN payroll_entries p
    ON p.store_id = r.store_id
   AND p.telegram_id = r.telegram_id
   AND p.effective_at >= r.period_start
   AND p.effective_at < r.period_end
  GROUP BY
    r.record_id,
    r.store_id,
    r.telegram_id,
    r.period_start,
    r.period_end,
    s.currency
),
historical_differences AS (
  SELECT
    'historical_period' AS scope,
    l.scope_id,
    l.store_id,
    l.telegram_id,
    l.period_start,
    l.period_end,
    l.currency,
    NULL AS entry_type,
    l.legacy_micros,
    n.ledger_micros,
    n.ledger_micros - l.legacy_micros AS difference_micros
  FROM legacy_history l
  JOIN ledger_history n ON n.scope_id = l.scope_id
  WHERE n.ledger_micros != l.legacy_micros
),
legacy_type_totals AS (
  SELECT
    i.store_id,
    s.currency,
    i.type AS entry_type,
    SUM(ROUND((i.commission_income - i.fine) * 1000000)) AS legacy_micros
  FROM income_records i
  JOIN stores s ON s.store_id = i.store_id
  GROUP BY i.store_id, s.currency, i.type
),
ledger_type_totals AS (
  SELECT
    store_id,
    currency,
    type AS entry_type,
    SUM(amount_micros) AS ledger_micros
  FROM payroll_entries
  GROUP BY store_id, currency, type
),
type_keys AS (
  SELECT store_id, currency, entry_type FROM legacy_type_totals
  UNION
  SELECT store_id, currency, entry_type FROM ledger_type_totals
),
type_differences AS (
  SELECT
    'type_total' AS scope,
    k.store_id || ':' || k.currency || ':' || k.entry_type AS scope_id,
    k.store_id,
    NULL AS telegram_id,
    NULL AS period_start,
    NULL AS period_end,
    k.currency,
    k.entry_type,
    COALESCE(l.legacy_micros, 0) AS legacy_micros,
    COALESCE(n.ledger_micros, 0) AS ledger_micros,
    COALESCE(n.ledger_micros, 0)
      - COALESCE(l.legacy_micros, 0) AS difference_micros
  FROM type_keys k
  LEFT JOIN legacy_type_totals l
    ON l.store_id = k.store_id
   AND l.currency = k.currency
   AND l.entry_type = k.entry_type
  LEFT JOIN ledger_type_totals n
    ON n.store_id = k.store_id
   AND n.currency = k.currency
   AND n.entry_type = k.entry_type
  WHERE COALESCE(n.ledger_micros, 0) != COALESCE(l.legacy_micros, 0)
),
legacy_store_totals AS (
  SELECT
    i.store_id,
    s.currency,
    SUM(ROUND((i.commission_income - i.fine) * 1000000)) AS legacy_micros
  FROM income_records i
  JOIN stores s ON s.store_id = i.store_id
  GROUP BY i.store_id, s.currency
),
ledger_store_totals AS (
  SELECT
    store_id,
    currency,
    SUM(amount_micros) AS ledger_micros
  FROM payroll_entries
  GROUP BY store_id, currency
),
store_keys AS (
  SELECT store_id, currency FROM legacy_store_totals
  UNION
  SELECT store_id, currency FROM ledger_store_totals
),
store_differences AS (
  SELECT
    'store_currency_total' AS scope,
    k.store_id || ':' || k.currency AS scope_id,
    k.store_id,
    NULL AS telegram_id,
    NULL AS period_start,
    NULL AS period_end,
    k.currency,
    NULL AS entry_type,
    COALESCE(l.legacy_micros, 0) AS legacy_micros,
    COALESCE(n.ledger_micros, 0) AS ledger_micros,
    COALESCE(n.ledger_micros, 0)
      - COALESCE(l.legacy_micros, 0) AS difference_micros
  FROM store_keys k
  LEFT JOIN legacy_store_totals l
    ON l.store_id = k.store_id
   AND l.currency = k.currency
  LEFT JOIN ledger_store_totals n
    ON n.store_id = k.store_id
   AND n.currency = k.currency
  WHERE COALESCE(n.ledger_micros, 0) != COALESCE(l.legacy_micros, 0)
)
SELECT * FROM current_differences
UNION ALL
SELECT * FROM historical_differences
UNION ALL
SELECT * FROM type_differences
UNION ALL
SELECT * FROM store_differences
ORDER BY scope, store_id, telegram_id, period_start, entry_type;
