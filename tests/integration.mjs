import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {connect} from '../scripts/db.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const sql = fs.readFileSync(new URL('../sql/04_validate.sql', import.meta.url), 'utf8');
const c = connect();
const tests = [];
await c.connect();
async function test(name, fn) {
  await fn(); tests.push(name); console.log('PASS', name);
}
async function rejected(mutation, expected) {
  await c.query('SAVEPOINT invalid_input');
  try {
    await c.query(mutation);
    await assert.rejects(c.query(sql), expected);
  } finally {
    await c.query('ROLLBACK TO SAVEPOINT invalid_input');
  }
}
async function snapshot() {
  return (await c.query("SELECT jsonb_agg(to_jsonb(m) ORDER BY report_date)::text AS value FROM reporting.v_metrics_delta m")).rows[0].value;
}
try {
  await test('Second full pipeline run preserves exact metrics', async () => {
    const before = await snapshot();
    const result = spawnSync(process.execPath, ['scripts/pipeline.mjs'], {cwd:root,encoding:'utf8',windowsHide:true});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await snapshot(), before);
  });
  await c.query('BEGIN');
  await c.query('TRUNCATE raw.portfolio, raw.fx');
  const insert = async (id, group, curr, balance, dpd, rest=0, off=0) => c.query(
    `INSERT INTO raw.portfolio VALUES ('2026-09-01',$1,'BTEST',$2,'Test','Test',$3,'2025-01-01','2030-01-01',$4,$5,$6,$7)`,
    [id,group,curr,String(balance),String(dpd),String(rest),String(off)]);
  await c.query("INSERT INTO raw.fx VALUES ('2026-09-01','USD','500'),('2026-08-31','USD','900')");
  for (const [id,dpd,rest] of [['D30',30,0],['D31',31,0],['D90',90,0],['D91',91,0],['R0',0,1],['R31',31,1],['R91',91,1]])
    await insert(id,id,'KZT',100,dpd,rest);
  await insert('USD','USD','USD',2,0);
  await insert('OFF','OFF','KZT',100000,100,1,1);
  for(let i=1;i<=11;i++) await insert('C'+i, 'C'+String(i).padStart(2,'0'), 'KZT', 1000, 0);
  // Group USD totals 1200 and outranks each individual 1000 loan.
  await insert('USD2','USD','KZT',200,0);
  await c.query("INSERT INTO raw.portfolio SELECT * FROM raw.portfolio WHERE loan_id='D30'");
  await c.query(sql);
  await test('Strict PAR boundaries and 50% NPL priority', async () => {
    const rows = (await c.query("SELECT loan_id, is_par30, is_par90, is_npl, provision_rate::text FROM reporting.v_loan_risk WHERE loan_id IN ('D30','D31','D90','D91','R0','R31','R91')")).rows;
    const expected = {
      D30:[false,false,false,'0.01'],D31:[true,false,false,'0.10'],D90:[true,false,false,'0.10'],
      D91:[true,true,true,'0.50'],R0:[false,false,true,'0.50'],R31:[true,false,true,'0.50'],R91:[true,true,true,'0.50']
    };
    for (const r of rows) assert.deepEqual([r.is_par30,r.is_par90,r.is_npl,r.provision_rate],expected[r.loan_id]);
    assert.equal(rows.length, 7);
  });
  await test('Exact snapshot FX, native currency and written-off exclusion', async () => {
    assert.equal((await c.query("SELECT balance_kzt::text FROM reporting.v_loan_risk WHERE loan_id='USD'")).rows[0].balance_kzt,'1000');
    assert.equal((await c.query("SELECT balance_kzt::text FROM reporting.v_loan_risk WHERE loan_id='D30'")).rows[0].balance_kzt,'100');
    assert.equal((await c.query("SELECT count(*) FROM reporting.v_loan_risk WHERE loan_id='OFF'")).rows[0].count,'0');
  });
  await test('Top-10 aggregates groups and resolves ties deterministically', async () => {
    const groups = (await c.query('SELECT group_id FROM reporting.v_group_risk WHERE group_rank<=10 ORDER BY group_rank')).rows.map(r=>r.group_id);
    assert.deepEqual(groups,['USD','C01','C02','C03','C04','C05','C06','C07','C08','C09']);
    const r = (await c.query('SELECT portfolio_kzt::text, top10_kzt::text FROM reporting.v_metrics')).rows[0];
    assert.equal(r.portfolio_kzt,'12900');assert.equal(r.top10_kzt,'10200');
  });
  await test('Exact duplicate does not double count', async () => {
    assert.equal((await c.query("SELECT count(*) FROM reporting.v_loan_risk WHERE loan_id='D30'")).rows[0].count,'1');
  });
  await test('Conflicting loan key is rejected', () => rejected("INSERT INTO raw.portfolio SELECT report_date,loan_id,borrower_id,group_id,sector,program,currency,issue_date,maturity_date,'101',days_past_due,restructured,written_off FROM raw.portfolio WHERE loan_id='D31'", /Conflicting duplicate loan/));
  await test('Missing snapshot FX is rejected', () => rejected("DELETE FROM raw.fx WHERE date='2026-09-01'", /Missing FX/));
  await test('Conflicting FX key is rejected', () => rejected("INSERT INTO raw.fx VALUES ('2026-09-01','USD','501')", /Conflicting duplicate FX/));
  await test('Negative balance is rejected', () => rejected("UPDATE raw.portfolio SET principal_outstanding='-1' WHERE loan_id='D31'", /Invalid or missing/));
  await test('Negative DPD is rejected', () => rejected("UPDATE raw.portfolio SET days_past_due='-1' WHERE loan_id='D31'", /Invalid or missing/));
  await test('Invalid flag is rejected', () => rejected("UPDATE raw.portfolio SET restructured='2' WHERE loan_id='D31'", /Invalid or missing/));
  await test('Missing group_id is rejected', () => rejected("UPDATE raw.portfolio SET group_id='' WHERE loan_id='D31'", /Invalid or missing/));
  await test('Zero denominator produces NULL, not a fabricated 0%', async () => {
    await c.query('SAVEPOINT zero_balance');
    await c.query("UPDATE raw.portfolio SET principal_outstanding='0'");
    const r = (await c.query('SELECT par30_ratio, par90_ratio, npl_ratio, top10_ratio, provision_ratio FROM reporting.v_metrics')).rows[0];
    assert.deepEqual(Object.values(r),[null,null,null,null,null]);
    await c.query('ROLLBACK TO SAVEPOINT zero_balance');
  });
  await c.query('ROLLBACK');
  fs.writeFileSync(new URL('../validation/integration.json',import.meta.url),JSON.stringify({status:'PASS',tests},null,2)+'\n');
} finally {await c.query('ROLLBACK').catch(()=>{});await c.end();}
