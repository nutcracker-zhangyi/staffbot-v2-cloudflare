SELECT
  (
    SELECT COUNT(*)
    FROM income_records
    WHERE type IS NULL OR type NOT IN ('income', 'fine', 'advance')
  ) AS unknown_type_rows,
  (
    SELECT COUNT(*)
    FROM income_records
    WHERE record_id IS NULL
       OR store_id IS NULL
       OR telegram_id IS NULL
       OR approved_at IS NULL
       OR admin_id IS NULL
       OR source IS NULL
  ) AS missing_required_rows,
  (
    SELECT COUNT(*)
    FROM income_records
    WHERE ABS(
      ROUND(commission_income * 1000000)
      - commission_income * 1000000
    ) > 0.000001
       OR ABS(
         ROUND(fine * 1000000)
         - fine * 1000000
       ) > 0.000001
  ) AS sub_micro_precision_rows,
  (
    SELECT COUNT(*)
    FROM income_records
    WHERE ABS(ROUND(commission_income * 1000000)) > 9007199254740991
       OR ABS(ROUND(fine * 1000000)) > 9007199254740991
  ) AS unsafe_integer_rows,
  (
    SELECT COUNT(*)
    FROM income_records i
    LEFT JOIN stores s ON s.store_id = i.store_id
    WHERE s.store_id IS NULL
  ) AS missing_store_rows,
  (
    SELECT COUNT(*)
    FROM income_records i
    LEFT JOIN store_members m
      ON m.store_id = i.store_id
     AND m.telegram_id = i.telegram_id
    WHERE m.telegram_id IS NULL
  ) AS missing_member_rows,
  (
    SELECT COALESCE(SUM(identity_count - 1), 0)
    FROM (
      SELECT COUNT(*) AS identity_count
      FROM income_records
      GROUP BY source, record_id
      HAVING COUNT(*) > 1
    )
  ) AS duplicate_identity_rows,
  (
    SELECT COUNT(*)
    FROM income_records
    WHERE (type = 'income' AND ROUND(commission_income * 1000000) = 0)
       OR (
         type IN ('fine', 'advance')
         AND ROUND(fine * 1000000) = 0
       )
  ) AS zero_effect_rows;
