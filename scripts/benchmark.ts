import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { CipaBrowser } from '../src/browser.js';
import { loadConfig } from '../src/config.js';
const label = process.argv[2] ?? 'run';
const rounds = Number(process.argv[3] ?? 1);
const path = `output/performance/${label}`;
await mkdir(path, {recursive:true});
const provider = new CipaBrowser(loadConfig());
const p = provider as any;
const views: Array<{uin:string;url:string}> = [];
const openEntity = p.openEntity.bind(provider);
p.openEntity = async (...args:any[]) => {
  const result = await openEntity(...args);
  assert.ok(!views.some(view => view.url === result.url), 'Every branch/read must receive an independent fresh company view');
  views.push({uin:args[1],url:result.url});
  return result;
};
if (process.argv.includes('--direct-links')) {
  const { installDirectLinks } = await import('./direct-links-experiment.js');
  installDirectLinks(p);
}
if (process.argv.includes('--direct-read-clicks')) {
  const acquire = p.acquire.bind(provider); let initialized = false;
  p.acquire = async (signal: AbortSignal) => {
    const session = await acquire(signal);
    if (!initialized) {
      initialized = true;
      const prototype = Object.getPrototypeOf(session.page.locator('body')), click = prototype.click;
      prototype.click = async function(options: any) {
        const activated = await this.evaluate((element: HTMLElement) => {
          const role = element.getAttribute('role'), label = element.getAttribute('aria-label') ?? '';
          const allowed = role === 'tab' || label === 'Next Page' || /^Results per page \d+$/.test(label) || role === 'menuitem' && /^\d+$/.test(element.innerText.trim());
          const style = getComputedStyle(element);
          if (!allowed || element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true' || element.closest('[hidden],[aria-hidden="true"]') || !element.getClientRects().length || style.visibility === 'hidden' || style.pointerEvents === 'none') return false;
          element.click(); return true;
        });
        if (!activated) return click.call(this, options);
      };
    }
    return session;
  };
}
if (process.argv.includes('--reduce-overlay')) {
  const acquire = p.acquire.bind(provider), initialized = new WeakSet();
  p.acquire = async (signal: AbortSignal) => {
    const session = await acquire(signal);
    if (!initialized.has(session.context)) {
      initialized.add(session.context);
      await session.context.addInitScript(() => document.addEventListener('DOMContentLoaded', () => {
        const w = window as any;
        if (w.Catalyst) w.Catalyst.processingMin = 0;
        if (w.jQuery?.fx) w.jQuery.fx.off = true;
      }));
    }
    await session.page.evaluate(() => {
      const w = window as any;
      if (w.Catalyst) w.Catalyst.processingMin = 0;
      if (w.jQuery?.fx) w.jQuery.fx.off = true;
    });
    return session;
  };
}
if (process.argv.includes('--batch-tabs')) {
  const { installBatchedTabs } = await import('./batched-tabs-experiment.js');
  installBatchedTabs(p);
}
if (process.argv.includes('--persistent-reset')) {
  const { installPersistentReset } = await import('./persistent-reset-experiment.js');
  installPersistentReset(p);
}
let timing: Record<string,{calls:number;ms:number}> = {};
for (const key of ['acquire','searchOn','remoteClick','settle','expand','visibleHtml','readSection','getEntityPart']) {
  const original=p[key].bind(provider);
  p[key]=async(...args:any[])=>{
    const start=performance.now();
    try {return await original(...args);}
    finally {const label=key==='getEntityPart'?`${key}:${args[1].include.join(',')}`:key;const entry=timing[label]??={calls:0,ms:0};entry.calls++;entry.ms+=performance.now()-start;}
  };
}
const measurements:any[]=[];
try {
  if (process.argv.includes('--prewarm')) {
    const started=performance.now();await provider.warmup(AbortSignal.timeout(30000));
    const startup = {startupWarmupMs:Math.round(performance.now()-started)};
    console.log(JSON.stringify(startup));
    await writeFile(`${path}/startup.json`,JSON.stringify(startup,null,2));
  }
  for(let round=0;round<rounds;round++) for(const uin of ['BW00000790718','BW00001142508']) {
    timing={};const start=performance.now();
    const data=await provider.getEntity(uin,{include:['all'],history:true,filingDetails:false,maxPages:10},AbortSignal.timeout(180000));
    await writeFile(`${path}/${uin}-${round}.json`,JSON.stringify(data,null,2));
    assert.equal(data.complete,true,JSON.stringify(data.warnings));
    const measurement={uin,round,ms:Math.round(performance.now()-start),timing:Object.fromEntries(Object.entries(timing).map(([k,v])=>[k,{...v,ms:Math.round(v.ms)}]))};
    measurements.push(measurement);console.log(JSON.stringify(measurement));
    await writeFile(`${path}/measurements.json`,JSON.stringify(measurements,null,2));
    await writeFile(`${path}/views.json`,JSON.stringify(views,null,2));
  }
} finally {await provider.close();}
