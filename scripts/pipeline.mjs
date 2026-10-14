import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {from as copyFrom} from 'pg-copy-streams';
import {connect} from './db.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const client = connect();
const readSQL = name => fs.readFileSync(path.join(root, 'sql', name), 'utf8');
await client.connect();
try {
  await client.query('BEGIN');
  await client.query("SET LOCAL DateStyle = 'ISO, YMD'");
  await client.query(readSQL('01_raw.sql'));
  await client.query('TRUNCATE raw.portfolio, raw.fx');
  for (const [table, filename] of [['portfolio', 'portfolio.csv'], ['fx', 'fx.csv']]) {
    await pipeline(fs.createReadStream(path.join(root, 'data', filename)),
      client.query(copyFrom(`COPY raw.${table} FROM STDIN WITH (FORMAT csv, HEADER MATCH, ENCODING 'UTF8')`)));
  }
  await client.query(readSQL('03_views.sql'));
  await client.query(readSQL('04_validate.sql'));
  await client.query('COMMIT');
  // Export from one consistent read snapshot. JSON preserves NUMERIC as exact
  // decimal text in validation; display JSON converts only after DB calculations.
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const exports = {};
  for (const [name, view, order] of [
    ['metrics', 'v_metrics_delta', 'report_date'],
    ['segments', 'v_segment_risk', 'report_date, dimension, segment'],
    ['groups', 'v_group_risk', 'report_date, group_rank'],
    ['quality', 'v_data_quality', 'report_date']
  ]) {
    const result = await client.query(`SELECT to_char(report_date, 'YYYY-MM-DD') AS date_key, v.* FROM reporting.${view} v ORDER BY ${order}`);
    // pg returns date as JS Date; use to_char to prevent timezone-dependent dates.
    exports[name] = result.rows.map(({date_key, report_date, baseline_date, ...r}) => ({
      report_date: date_key,
      ...(baseline_date ? {baseline_date: '2026-09-01'} : {}),
      ...r
    }));
  }
  const version = (await client.query('SELECT version() AS version')).rows[0].version;
  await client.query('COMMIT');
  const outputDir = path.join(root, 'dashboard', 'data');
  fs.mkdirSync(outputDir, {recursive: true});
  fs.mkdirSync(path.join(root, 'validation'), {recursive: true});
  const inputs = Object.fromEntries(['portfolio.csv','fx.csv'].map(name => {
    const bytes = fs.readFileSync(path.join(root,'data',name));
    return [name,{bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}];
  }));
  fs.writeFileSync(path.join(root, 'validation', 'sql-results.json'), JSON.stringify({version, inputs, ...exports}, null, 2) + '\n');
  // The browser sees JSON numbers; all calculations already used NUMERIC in SQL.
  const numeric = new Set(['loan_count', 'group_count', 'group_rank', 'raw_rows', 'unique_rows', 'duplicates_removed', 'written_off_rows', 'active_rows']);
  for (const [name, rows] of Object.entries(exports)) {
    const display = rows.map(row => Object.fromEntries(Object.entries(row).map(([k, v]) =>
      [k, v !== null && (numeric.has(k) || /_(kzt|ratio|pp|share|contribution)$/.test(k)) ? Number(v) : v])));
    fs.writeFileSync(path.join(outputDir, name + '.json'), JSON.stringify(display, null, 2) + '\n');
  }
  console.log(JSON.stringify({version, quality: exports.quality, metrics: exports.metrics}, null, 2));
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await client.end();
}
