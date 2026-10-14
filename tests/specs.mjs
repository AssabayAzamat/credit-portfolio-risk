import fs from 'node:fs';
import assert from 'node:assert/strict';
import {compile} from 'vega-lite';
import * as vega from 'vega';
import YAML from 'yaml';
import {connect} from '../scripts/db.mjs';
const dir = new URL('../dashboard/specs/',import.meta.url);
const root = new URL('../dashboard/',import.meta.url);
const tested=[];
for (const name of fs.readdirSync(dir).filter(n=>n.endsWith('.json'))) {
  const spec=JSON.parse(fs.readFileSync(new URL(name,dir),'utf8'));
  // Inline local JSON during validation, preserving the browser spec itself.
  spec.data.values=JSON.parse(fs.readFileSync(new URL(spec.data.url,root),'utf8'));
  delete spec.data.url;
  const compiled=compile(spec).spec;
  const view=new vega.View(vega.parse(compiled),{renderer:'none'});
  await view.runAsync();
  const svg=await view.toSVG();
  assert.ok(svg.includes('<svg'),name);
  if (name==='metrics.json' || name==='top10.json') {
    await view.signal('snapshot','2026-09-01').runAsync();
    assert.ok((await view.toSVG()).includes('<svg'));
  }
  view.finalize();tested.push(name);console.log('PASS',name);
}
const model=YAML.parse(fs.readFileSync(new URL('../semantic/loan_risk.yaml',import.meta.url),'utf8'));
assert.equal(model.source,'reporting.v_loan_risk');
const c=connect();await c.connect();
try {
  const columns=new Set((await c.query("SELECT column_name FROM information_schema.columns WHERE table_schema='reporting' AND table_name='v_loan_risk'")).rows.map(r=>r.column_name));
  for (const field of [...model.dimensions,...model.measures]) {
    assert.ok(columns.has(field.column),field.column);
    assert.ok(field.name && field.type && field.label);
  }
  for (const m of model.measures) assert.ok(['sum','avg','count'].includes(m.type) && m.format);
} finally {await c.end()}
fs.writeFileSync(new URL('../validation/specs.json',import.meta.url),JSON.stringify({status:'PASS',specs:tested,yaml_source_and_columns:'PASS'},null,2)+'\n');
