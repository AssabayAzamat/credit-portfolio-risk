CREATE SCHEMA IF NOT EXISTS raw;
CREATE SCHEMA IF NOT EXISTS reporting;
-- Text preserves input values. Conversion and validation belong to reporting.
CREATE TABLE IF NOT EXISTS raw.portfolio (
  report_date text, loan_id text, borrower_id text, group_id text,
  sector text, program text, currency text, issue_date text, maturity_date text,
  principal_outstanding text, days_past_due text, restructured text, written_off text
);
CREATE TABLE IF NOT EXISTS raw.fx (date text, currency text, rate_kzt text);
