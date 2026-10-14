CREATE OR REPLACE VIEW reporting.v_portfolio_normalized AS
SELECT DISTINCT
  nullif(trim(report_date), '')::date AS report_date,
  nullif(trim(loan_id), '') AS loan_id,
  nullif(trim(borrower_id), '') AS borrower_id,
  nullif(trim(group_id), '') AS group_id,
  nullif(trim(sector), '') AS sector,
  nullif(trim(program), '') AS program,
  upper(nullif(trim(currency), '')) AS currency,
  nullif(trim(issue_date), '')::date AS issue_date,
  nullif(trim(maturity_date), '')::date AS maturity_date,
  nullif(trim(principal_outstanding), '')::numeric AS principal_outstanding,
  nullif(trim(days_past_due), '')::integer AS days_past_due,
  nullif(trim(restructured), '')::integer AS restructured,
  nullif(trim(written_off), '')::integer AS written_off
FROM raw.portfolio;

CREATE OR REPLACE VIEW reporting.v_fx AS
SELECT DISTINCT nullif(trim(date), '')::date AS rate_date,
       upper(nullif(trim(currency), '')) AS currency,
       nullif(trim(rate_kzt), '')::numeric AS rate_kzt
FROM raw.fx;

CREATE OR REPLACE VIEW reporting.v_loan_risk AS
WITH converted AS (
  SELECT p.*, CASE WHEN p.currency = 'KZT' THEN 1::numeric ELSE f.rate_kzt END AS rate_kzt
  FROM reporting.v_portfolio_normalized p
  LEFT JOIN reporting.v_fx f ON f.rate_date = p.report_date AND f.currency = p.currency
  WHERE p.written_off = 0
), classified AS (
  SELECT c.*, principal_outstanding * rate_kzt AS balance_kzt,
         days_past_due > 30 AS is_par30,
         days_past_due > 90 AS is_par90,
         days_past_due > 90 OR restructured = 1 AS is_npl,
         CASE WHEN days_past_due > 90 OR restructured = 1 THEN 0.50::numeric
              WHEN days_past_due > 30 THEN 0.10::numeric ELSE 0.01::numeric END AS provision_rate
  FROM converted c
)
SELECT *,
  CASE WHEN is_par30 THEN balance_kzt ELSE 0::numeric END AS par30_kzt,
  CASE WHEN is_par90 THEN balance_kzt ELSE 0::numeric END AS par90_kzt,
  CASE WHEN is_npl THEN balance_kzt ELSE 0::numeric END AS npl_kzt,
  balance_kzt * provision_rate AS provisions_kzt,
  CASE WHEN is_npl THEN 'NPL' WHEN is_par30 THEN '31–90 дней' ELSE '0–30 дней' END AS risk_band
FROM classified;

CREATE OR REPLACE VIEW reporting.v_group_risk AS
WITH groups AS (
  SELECT report_date, group_id, sum(balance_kzt) AS balance_kzt,
         sum(npl_kzt) AS npl_kzt, count(*) AS loan_count
  FROM reporting.v_loan_risk GROUP BY report_date, group_id
)
SELECT *, row_number() OVER (PARTITION BY report_date ORDER BY balance_kzt DESC, group_id) AS group_rank
FROM groups;

CREATE OR REPLACE VIEW reporting.v_metrics AS
WITH totals AS (
  SELECT report_date, count(*) AS loan_count, count(DISTINCT group_id) AS group_count,
         sum(balance_kzt) AS portfolio_kzt, sum(par30_kzt) AS par30_kzt,
         sum(par90_kzt) AS par90_kzt, sum(npl_kzt) AS npl_kzt,
         sum(provisions_kzt) AS provisions_kzt
  FROM reporting.v_loan_risk GROUP BY report_date
), top10 AS (
  SELECT report_date, sum(balance_kzt) FILTER (WHERE group_rank <= 10) AS top10_kzt
  FROM reporting.v_group_risk GROUP BY report_date
)
SELECT t.*, g.top10_kzt,
       par30_kzt / nullif(portfolio_kzt, 0) AS par30_ratio,
       par90_kzt / nullif(portfolio_kzt, 0) AS par90_ratio,
       npl_kzt / nullif(portfolio_kzt, 0) AS npl_ratio,
       provisions_kzt / nullif(portfolio_kzt, 0) AS provision_ratio,
       g.top10_kzt / nullif(portfolio_kzt, 0) AS top10_ratio
FROM totals t JOIN top10 g USING (report_date);

CREATE OR REPLACE VIEW reporting.v_metrics_delta AS
SELECT m.*, b.report_date AS baseline_date,
       m.portfolio_kzt - b.portfolio_kzt AS portfolio_delta_kzt,
       m.portfolio_kzt / nullif(b.portfolio_kzt, 0) - 1 AS portfolio_delta_ratio,
       m.provisions_kzt - b.provisions_kzt AS provisions_delta_kzt,
       m.provisions_kzt / nullif(b.provisions_kzt, 0) - 1 AS provisions_delta_ratio,
       100 * (m.par30_ratio - b.par30_ratio) AS par30_delta_pp,
       100 * (m.par90_ratio - b.par90_ratio) AS par90_delta_pp,
       100 * (m.npl_ratio - b.npl_ratio) AS npl_delta_pp,
       100 * (m.provision_ratio - b.provision_ratio) AS provision_delta_pp,
       100 * (m.top10_ratio - b.top10_ratio) AS top10_delta_pp
FROM reporting.v_metrics m
CROSS JOIN reporting.v_metrics b
WHERE b.report_date = DATE '2026-09-01';

CREATE OR REPLACE VIEW reporting.v_segment_risk AS
WITH segments AS (
  SELECT report_date, 'sector'::text AS dimension, sector AS segment,
         balance_kzt, par30_kzt, par90_kzt, npl_kzt, provisions_kzt
  FROM reporting.v_loan_risk
  UNION ALL
  SELECT report_date, 'program', program,
         balance_kzt, par30_kzt, par90_kzt, npl_kzt, provisions_kzt
  FROM reporting.v_loan_risk
), totals AS (
  SELECT report_date, dimension, segment, count(*) AS loan_count,
         sum(balance_kzt) AS portfolio_kzt, sum(par30_kzt) AS par30_kzt,
         sum(par90_kzt) AS par90_kzt, sum(npl_kzt) AS npl_kzt,
         sum(provisions_kzt) AS provisions_kzt
  FROM segments GROUP BY report_date, dimension, segment
)
SELECT t.*, par30_kzt / nullif(t.portfolio_kzt, 0) AS par30_ratio,
       par90_kzt / nullif(t.portfolio_kzt, 0) AS par90_ratio,
       npl_kzt / nullif(t.portfolio_kzt, 0) AS npl_ratio,
       t.portfolio_kzt / nullif(m.portfolio_kzt, 0) AS portfolio_share,
       npl_kzt / nullif(m.portfolio_kzt, 0) AS npl_contribution
FROM totals t JOIN (SELECT report_date, portfolio_kzt FROM reporting.v_metrics) m USING (report_date);

CREATE OR REPLACE VIEW reporting.v_data_quality AS
WITH r AS (
  SELECT report_date::date AS report_date, count(*) AS raw_rows FROM raw.portfolio GROUP BY 1
), n AS (
  SELECT report_date, count(*) AS unique_rows,
         count(*) FILTER (WHERE written_off = 1) AS written_off_rows,
         count(*) FILTER (WHERE written_off = 0) AS active_rows
  FROM reporting.v_portfolio_normalized GROUP BY report_date
)
SELECT r.*, n.unique_rows, r.raw_rows - n.unique_rows AS duplicates_removed,
       n.written_off_rows, n.active_rows
FROM r JOIN n USING (report_date);
