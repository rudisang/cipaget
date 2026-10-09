import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { CipaBrowser } from '../src/browser.js';
import { loadConfig } from '../src/config.js';
const path='output/performance/parallel';await mkdir(path,{recursive:true});
const browser=new CipaBrowser(loadConfig({...process.env,DETAIL_CONCURRENCY:'1'}));
const groups=[['general','addresses','directors','secretaries'],['shareholders','shareAllocations','beneficialOwners','auditors'],['filings','visualisation']];
try {
 const pre=performance.now();await Promise.all(groups.map(()=>browser.warmup(AbortSignal.timeout(30000))));console.log({startupMs:Math.round(performance.now()-pre)});
 for(let round=0;round<2;round++)for(const uin of ['BW00000790718','BW00001142508']){
  const start=performance.now();const timings:any[]=[];
  const results=await Promise.all(groups.map(async(include,i)=>{
   const t=performance.now();const result=await browser.getEntity(uin,{include,history:true,filingDetails:false,maxPages:10},AbortSignal.timeout(180000));
   timings[i]={branch:i,ms:Math.round(performance.now()-t),complete:result.complete};return result;
  }));
  const result={...results[0],sections:Object.assign({},...results.slice(0,3).map(r=>r.sections)),complete:results.every(r=>r.complete),warnings:results.flatMap(r=>r.warnings)};
  await writeFile(`${path}/${uin}-${round}.json`,JSON.stringify(result,null,2));
  console.log(JSON.stringify({uin,round,ms:Math.round(performance.now()-start),timings,warnings:result.warnings}));
  assert.equal(result.complete,true);
 }
}finally{await browser.close();}
