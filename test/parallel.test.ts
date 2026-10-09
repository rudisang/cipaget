import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { CipaBrowser } from '../src/browser.js';
import { loadConfig } from '../src/config.js';
import { parseSection } from '../src/parser.js';
import { ApiError } from '../src/errors.js';

for (const hybrid of [false,true]) test(`parallel traversal preserves discovered unknown tabs, explicit absent tabs and partial sections (hybrid=${hybrid})`,async()=>{
 const p=new CipaBrowser(loadConfig({HYBRID_NAVIGATION:String(hybrid)})) as any;
 let active=0,peak=0;
 const available=['general','addresses','directors','shareholders','shareAllocations','filings','visualisation','newPublicTab'];
 p.getEntityPart=async(uin:string,options:any,signal:AbortSignal,excluded:string[]=[])=>{
  active++;peak=Math.max(peak,active);await delay(5);active--;
  const keys=(options.include.includes('all')?available:options.include).filter((key:string)=>!excluded.includes(key));
  const sections=Object.fromEntries(keys.map((key:string)=>[key,{...parseSection(`<h2>${key}</h2>`,key),status:available.includes(key)?'available':'unavailable',complete:key!=='filings',warnings:key==='filings'?['Page limit']:[]} ]));
  return {uin,name:'Example',status:'Registered',entityType:'Private Company',availableSections:available.map(key=>({key,label:key})),sections,complete:!keys.includes('filings'),warnings:[],retrievedAt:'now',source:'CIPA'};
 };
 const all=await p.getEntity('BW00000123456',{include:['all'],history:true,filingDetails:false,maxPages:10},new AbortController().signal);
 assert.equal(peak,4);assert.deepEqual(Object.keys(all.sections).sort(),available.sort());assert.equal(all.complete,false);assert.ok(all.sections.newPublicTab);assert.equal(all.sections.secretaries,undefined);
 const selected=await p.getEntity('BW00000123456',{include:['general','addresses','missing'],history:true,filingDetails:false,maxPages:10},new AbortController().signal);
 assert.equal(selected.sections.missing.status,'unavailable');assert.equal(selected.complete,true);
 await p.close();
});
test('failed branch cancels and drains sibling reads before returning',async()=>{
 const p=new CipaBrowser(loadConfig({})) as any;let active=0,cleaned=0;
 p.getEntityPart=async(_uin:string,options:any,signal:AbortSignal)=>{
  active++;
  try {
   if(options.include.includes('all')){await delay(5);throw new ApiError('UPSTREAM_ACCESS_RESTRICTED','Denied',503);}
   await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  } finally {active--;cleaned++;}
 };
 await assert.rejects(p.getEntity('BW00000123456',{include:['all'],history:true,filingDetails:false,maxPages:10},new AbortController().signal),{code:'UPSTREAM_ACCESS_RESTRICTED'});
 assert.equal(active,0);assert.equal(cleaned,4);await p.close();
});

test('concurrent views share one section queue: general is free, filings starts first, a view on a top-level tab takes no subtab, unknown tabs stay with the primary',async()=>{
 const p=new CipaBrowser(loadConfig({HYBRID_NAVIGATION:'true'})) as any;
 const available=['general','addresses','directors','secretaries','shareholders','shareAllocations','beneficialOwners','auditors','filings','visualisation','newPublicTab'];
 const taken:string[][]=[];let primaryKeys:string[]=[];
 p.getEntityPart=async(uin:string,options:any,_signal:AbortSignal,_excluded:string[],shared:any)=>{
  assert.ok(shared?.pool,'every view receives the shared pool');
  shared.pool.seed(available);
  const view={clicked:false,topLevel:false},keys:string[]=[];
  for(let key=shared.pool.take(view,shared.primary);key!==undefined;key=shared.pool.take(view,shared.primary)){
   keys.push(key);
   if(key!=='general')view.clicked=true;
   if(['filings','visualisation'].includes(key))view.topLevel=true;
   await delay(1);
  }
  taken.push(keys);if(shared.primary)primaryKeys=keys;
  const sections=Object.fromEntries(keys.map(key=>[key,{...parseSection(`<h2>${key}</h2>`,key),status:'available',complete:true,warnings:[]}]));
  return {uin,name:'Example',status:'Registered',entityType:'Private Company',availableSections:available.map(key=>({key,label:key})),sections,complete:true,warnings:[],retrievedAt:'now',source:'CIPA'};
 };
 const all=await p.getEntity('BW00000123456',{include:['all'],history:true,filingDetails:false,maxPages:10},new AbortController().signal);
 assert.equal(taken.length,4);
 assert.deepEqual(taken.flat().sort(),[...available].sort(),'every available tab is read exactly once');
 const general=taken.find(keys=>keys.includes('general'))!,filings=taken.find(keys=>keys.includes('filings'))!;
 assert.equal(general[0],'general','the preselected tab is read before any click');
 assert.ok(filings.indexOf('filings')<=1&&filings.slice(0,filings.indexOf('filings')).every(key=>key==='general'),`the longest job starts on a view that has not clicked yet: ${filings}`);
 for(const keys of taken){const first=keys.findIndex(key=>['filings','visualisation'].includes(key));if(first!==-1)assert.ok(keys.slice(first).every(key=>['filings','visualisation'].includes(key)),`no subtab after a top-level tab: ${keys}`);}
 assert.ok(primaryKeys.includes('newPublicTab'),'an unfamiliar tab is read by the primary discovery view');
 assert.deepEqual(Object.keys(all.sections).sort(),[...available].sort());
 await p.close();
});

test('a click completes on the response to its own command, not on a queued ui-expanded notification',async()=>{
 const p=new CipaBrowser(loadConfig({})) as any;
 p.settle=async()=>{}; p.drainCommands=async()=>{};
 const request=(commands:unknown[])=>({method:()=>'POST',url:()=>'https://www.cipa.co.bw/companies/ui/XP-view',postData:()=>JSON.stringify({commands})});
 const response=(req:any)=>({request:()=>req,url:()=>req?.url(),finished:async()=>{}});
 let predicate:((response:any)=>boolean)|undefined, onRequest:((request:any)=>void)|undefined;
 const page={on:(_:string,fn:any)=>{onRequest=fn;},off:()=>{onRequest=undefined;},waitForResponse:async(fn:(r:any)=>boolean)=>{predicate=fn;return response(undefined);}};
 // Observed pager ids are "<hex node>-pageNext". Requests "issued" during the click are the ones CIPA's client queue sends after the waiter is armed.
 const control=(id:string|null,role:string|null,issued:any[])=>({evaluate:async()=>({id,role}),click:async()=>{issued.forEach(r=>onRequest?.(r));}});
 const expanded=request([{type:'view-node-set-key-value',id:'exp1',key:'ui-expanded',value:true}]), paged=request([{type:'pagination-update',id:'7ab38d4a'}]), selected=request([{type:'view-node-fire-event',name:'ui-wizardSelect',id:'tabs1'}]);
 await p.remoteClick({page,state:{}},control(null,'tab',[expanded,paged,selected]));
 assert.equal(predicate!(response(expanded)),false,'an expanded-state notification does not complete a tab click');
 assert.equal(predicate!(response(paged)),false,'a page change does not complete a tab click');
 assert.equal(predicate!(response(selected)),true);
 const earlier=request([{type:'pagination-update',id:'7ab38d4a'}]);
 const listExpanded=request([{type:'view-node-set-key-value',id:'7ab38d4a',key:'ui-expanded',value:true}]), other=request([{type:'pagination-update',id:'5c0ffee1'}]), next=request([{type:'pagination-update',id:'7ab38d4a'}]);
 await p.remoteClick({page,state:{}},control('7ab38d4a-pageNext',null,[listExpanded,other,next]));
 assert.equal(predicate!(response(listExpanded)),false,'the repeater\'s own expanded-state notification does not complete its Next Page click');
 assert.equal(predicate!(response(other)),false);
 assert.equal(predicate!(response(earlier)),false,'a matching command sent before the click was armed does not complete it');
 assert.equal(predicate!(response(next)),true);
 await p.close();
});

test('sections come back as detail tabs then top-level tabs in CIPA order whichever view finished first, with absent requested keys last',async()=>{
 const p=new CipaBrowser(loadConfig({})) as any;
 // CIPA's page lists its top-level tabs before the detail subtabs.
 const tabs=['visualisation','filings','general','addresses','directors','shareholders'];
 // Each view returns the tabs it happened to take, in the order it took them.
 const taken=[['general','filings','missing'],['shareholders','visualisation'],['directors'],['addresses']];
 let call=0;
 p.getEntityPart=async(uin:string)=>{
  const keys=taken[call++]??[];await delay(5*(4-call));
  const sections=Object.fromEntries(keys.map(key=>[key,{...parseSection(`<h2>${key}</h2>`,key),status:tabs.includes(key)?'available':'unavailable'}]));
  return {uin,name:'Example',status:'Registered',entityType:'Private company',availableSections:tabs.map(key=>({key,label:key})),sections,complete:true,warnings:[],retrievedAt:'now',source:'CIPA'};
 };
 const result=await p.getEntity('BW00000123456',{include:[...tabs,'missing'],history:true,filingDetails:false,maxPages:10},new AbortController().signal);
 assert.deepEqual(Object.keys(result.sections),['general','addresses','directors','shareholders','visualisation','filings','missing']);
 await p.close();
});
