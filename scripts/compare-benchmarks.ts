import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const before=process.argv[2]??'before', after=process.argv[3]??'optimized';
const afterRound=Number(process.argv[4]??0);
assert.ok(Number.isInteger(afterRound)&&afterRound>=0,'Round must be a nonnegative integer');
const normalize=(value:string)=>value.replace(/--- Next page ---/g,'').replace(/\b\d+ results\b/g,'').replace(/Results per page/g,'').replace(/Page\s*of\s*\d+/g,'').replace(/\s+/g,' ').trim();
const fields=(entries:any[])=>entries.map(({key,label,value,displayValue,machineValue})=>JSON.stringify({key,label,value,displayValue,machineValue})).sort();
for(const uin of ['BW00000790718','BW00001142508']){
 const a=JSON.parse(await readFile(`output/performance/${before}/${uin}-0.json`,'utf8'));
 const b=JSON.parse(await readFile(`output/performance/${after}/${uin}-${afterRound}.json`,'utf8'));
 assert.equal(b.complete,true);assert.equal(a.uin,b.uin);assert.equal(a.name,b.name);
 assert.equal(a.status,b.status);assert.equal(a.entityType,b.entityType);
 assert.deepEqual(a.availableSections,b.availableSections);
 assert.deepEqual(Object.keys(a.sections).sort(),Object.keys(b.sections).sort(),'exact section coverage');
 for(const name of Object.keys(a.sections)){
  const x=a.sections[name],y=b.sections[name];
  assert.equal(y.complete,true,name);assert.equal(x.status,y.status,name);
  assert.deepEqual(fields(x.fields),fields(y.fields),`${name} fields`);
  assert.deepEqual(x.records.map((r:any)=>({title:r.title,fields:fields(r.fields),text:normalize(r.text)})),y.records.map((r:any)=>({title:r.title,fields:fields(r.fields),text:normalize(r.text)})),`${name} records`);
  assert.deepEqual([...new Set(x.tables.map((t:any)=>JSON.stringify(t.headers)))].sort(),[...new Set(y.tables.map((t:any)=>JSON.stringify(t.headers)))].sort(),`${name} table headings`);
  if (name === 'filings') {
   // Baseline pagination had stale aria-label times. Use its independently captured
   // visible dates as the source of truth, but compare every filing name and order.
   const dates=x.text.split('\n').filter((line:string)=>/^\d{1,2} [A-Za-z]+ \d{4}$/.test(line));
   const oldRows=x.tables.flatMap((t:any)=>t.rows), newRows=y.tables.flatMap((t:any)=>t.rows);
   assert.equal(dates.length,oldRows.length,'baseline visible date count');
   assert.deepEqual(oldRows.map((r:any)=>r.slice(1)),newRows.map((r:any)=>r.slice(1)),'filing names and order');
   assert.deepEqual(dates,newRows.map((r:any)=>r[0].replace(/^Completed on /,'').replace(/ \d{2}:\d{2} CAT$/,'')),'filing dates match baseline visible dates');
  } else assert.deepEqual(x.tables.flatMap((t:any)=>t.rows),y.tables.flatMap((t:any)=>t.rows),`${name} table rows`);
  assert.deepEqual(x.ownershipStatements,y.ownershipStatements,`${name} ownership`);
  if (name !== 'filings') assert.equal(normalize(x.text),normalize(y.text),`${name} text`); // Filing rows are compared above; pagination UI text changes with page size.
 }
 console.log(`${uin}: section statuses, fields, records, non-filing text/tables and BODS match; every filing name/date matches the baseline visible dates (stale baseline aria timestamps corrected)`);
}
