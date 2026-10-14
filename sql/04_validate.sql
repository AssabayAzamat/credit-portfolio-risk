DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM raw.portfolio) THEN RAISE EXCEPTION 'Empty portfolio'; END IF;
  IF EXISTS (
    SELECT 1 FROM reporting.v_portfolio_normalized
    WHERE report_date IS NULL OR loan_id IS NULL OR borrower_id IS NULL OR group_id IS NULL
       OR sector IS NULL OR program IS NULL OR currency IS NULL OR issue_date IS NULL OR maturity_date IS NULL
       OR principal_outstanding IS NULL OR principal_outstanding < 0
       OR days_past_due IS NULL OR days_past_due < 0
       OR restructured IS NULL OR restructured NOT IN (0,1)
       OR written_off IS NULL OR written_off NOT IN (0,1)
       OR issue_date > maturity_date OR issue_date > report_date
  ) THEN RAISE EXCEPTION 'Invalid or missing portfolio value'; END IF;
  IF EXISTS (SELECT 1 FROM reporting.v_portfolio_normalized GROUP BY report_date, loan_id HAVING count(*) > 1)
    THEN RAISE EXCEPTION 'Conflicting duplicate loan key'; END IF;
  IF EXISTS (SELECT 1 FROM reporting.v_fx WHERE rate_date IS NULL OR currency IS NULL OR rate_kzt IS NULL OR rate_kzt <= 0)
    THEN RAISE EXCEPTION 'Invalid FX value'; END IF;
  IF EXISTS (SELECT 1 FROM reporting.v_fx GROUP BY rate_date, currency HAVING count(*) > 1)
    THEN RAISE EXCEPTION 'Conflicting duplicate FX key'; END IF;
  IF EXISTS (SELECT 1 FROM reporting.v_fx WHERE currency = 'KZT' AND rate_kzt <> 1)
    THEN RAISE EXCEPTION 'KZT rate must equal 1'; END IF;
  IF EXISTS (SELECT 1 FROM reporting.v_loan_risk WHERE rate_kzt IS NULL)
    THEN RAISE EXCEPTION 'Missing FX on snapshot date'; END IF;
  IF NOT EXISTS (SELECT 1 FROM reporting.v_portfolio_normalized WHERE report_date = DATE '2026-09-01')
    THEN RAISE EXCEPTION 'Missing baseline 2026-09-01'; END IF;
END $$;
