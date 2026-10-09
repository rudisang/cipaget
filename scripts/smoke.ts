import { writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { CipaBrowser } from '../src/browser.js';
import { loadConfig } from '../src/config.js';
const provider = new CipaBrowser(loadConfig());
// Save diagnostic UI only for an explicitly invoked live smoke run, never in the API.
const debug = provider as any;
const originalSearch = debug.searchOn.bind(provider);
const originalSection = debug.readSection.bind(provider);
debug.readSection = async (...args: any[]) => {
  console.log('Reading', args[2]);
  try { return await originalSection(...args); } catch(error) { console.log('Section error', args[2], String(error)); throw error; }
};
debug.searchOn = async (session: any, options: any) => {
  try { return await originalSearch(session, options); }
  catch (error) {
    await writeFile('output/playwright/smoke/failure.html', await session.page.content()).catch(() => {});
    await writeFile('output/playwright/smoke/failure.txt', await session.page.getByRole('main').innerText()).catch(() => {});
    throw error;
  }
};
const signal = AbortSignal.timeout(300000);
await mkdir('output/playwright/smoke', { recursive: true });
const mode = process.argv[2] ?? 'basic';
async function save(name: string, action: () => Promise<any>) {
  const start = performance.now();
  const result = await action();
  await writeFile(`output/playwright/smoke/${name}.json`, JSON.stringify(result, null, 2));
  console.log(name, Math.round(performance.now()-start), 'ms', JSON.stringify(result.sections ? Object.fromEntries(Object.entries(result.sections).map(([k,v]:[string,any]) => [k,{status:v.status,fields:v.fields.length,records:v.records.length,pages:v.pagesFetched,complete:v.complete,warnings:v.warnings}])) : {results:result.items.length,hasMore:result.hasMore}));
  return result;
}
try {
  if (mode === 'basic') {
    const found = await save('search', () => provider.search({ q: 'Sefalana', page: 1, pageSize: 20 }, signal));
    assert.equal(found.items[0].uin, 'BW00000790718');
    const empty = await save('empty', () => provider.search({ q: 'zzzxqvnoentity982346', page: 1, pageSize: 20 }, signal));
    assert.equal(empty.items.length, 0);
    const entity = await save('general', () => provider.getEntity('BW00000790718', { include:['general','auditors'], history:true, filingDetails:false, maxPages:10 }, signal));
    assert.equal(entity.complete, true);
    assert.equal(entity.sections.general.fields.find((f:any) => f.key === 'CompanyNumber').value, 'BW00000790718');
  } else if (mode === 'full') {
    for (const uin of ['BW00000790718','BW00001142508']) {
      const entity = await save(uin, () => provider.getEntity(uin, { include:['all'], history:true, filingDetails:false, maxPages:10 }, signal));
      assert.equal(entity.complete, true);
    }
  } else if (mode === 'deep') {
    const entity = await save('filing-details', () => provider.getEntity('BW00000790718', { include:['filings'], history:true, filingDetails:true, maxPages:1 }, signal));
    assert.ok(entity.sections.filings.filingDetails?.length);
  } else if (mode === 'pagination') {
    let first: any;
    for (const options of [{q:'Choppies',page:1,pageSize:50},{q:'Choppies',page:2,pageSize:20}]) {
      const result=await save(`pagination-${options.page}-${options.pageSize}`,()=>provider.search(options,signal));
      if (options.pageSize === 50) { assert.ok(result.items.length > 20, 'Requested pageSize must actually change the UI'); first=result; }
      else assert.deepEqual(result.items.map((x:any)=>x.name),first.items.slice(20,40).map((x:any)=>x.name),'Logical pages must not repeat the previous page');
    }
  }
} finally { await provider.close(); }
