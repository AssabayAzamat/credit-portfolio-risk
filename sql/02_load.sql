-- Run from repository root. The enclosing psql --single-transaction makes
-- replacement atomic: bad input restores the previously loaded dataset.
TRUNCATE raw.portfolio, raw.fx;
\copy raw.portfolio FROM 'data/portfolio.csv' WITH (FORMAT csv, HEADER MATCH, ENCODING 'UTF8')
\copy raw.fx FROM 'data/fx.csv' WITH (FORMAT csv, HEADER MATCH, ENCODING 'UTF8')
