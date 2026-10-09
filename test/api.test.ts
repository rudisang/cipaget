import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { RegistryProvider } from '../src/types.js';
import { ApiError } from '../src/errors.js';

const provider:RegistryProvider={
  search:async o=>({query:o.q,items:[],page:o.page,pageSize:o.pageSize,total:0,hasMore:false,retrievedAt:'2026-09-11T00:00:00Z',source:'CIPA'}),
  getEntity:async()=>{throw new ApiError('ENTITY_NOT_FOUND','Not found',404);}, close:async()=>{},
};
test('HTTP validation, authentication, cache headers, error shapes and OpenAPI',async()=>{
  const app=await buildApp({...loadConfig({}),apiKey:'test-key'},provider);
  try {
    assert.equal((await app.inject('/healthz')).statusCode,200);
    assert.equal((await app.inject('/v1/search?q=Example')).statusCode,401);
    const headers={authorization:'Bearer test-key'};
    for(const url of ['/v1/search?q=%20%20','/v1/search?q=Example&limit=1','/v1/search?q=Example&page=1.5','/v1/entities/BW00000123456?history=wat','/v1/entities/BW00000123456?include=__proto__'])assert.equal((await app.inject({url,headers})).statusCode,400,url);
    const response=await app.inject({url:'/v1/search?q=Example',headers});
    assert.equal(response.statusCode,200);assert.deepEqual(response.json().data.items,[]);assert.equal(response.headers['cache-control'],'no-store');
    assert.equal((await app.inject({url:'/v1/search?q=Example',headers})).headers['x-cache'],'hit');
    const missing=await app.inject({url:'/v1/entities/BW00000123456',headers});assert.equal(missing.statusCode,404);assert.equal(missing.json().error.code,'ENTITY_NOT_FOUND');
    const spec=(await app.inject('/openapi.json')).json();assert.ok(spec.paths['/v1/search']);assert.ok(spec.paths['/v1/entities/{uin}']);
    const docs=await app.inject('/docs/');assert.equal(docs.statusCode,200);assert.match(String(docs.headers['content-type']),/^text\/html/);
    for(const url of ['/','/docs']){const redirect=await app.inject(url);assert.equal(redirect.statusCode,302,url);assert.equal(redirect.headers.location,'/docs/',url);}
  } finally {await app.close();}
});
test('startup warms only the browser, can be disabled, and failure does not prevent serving',async()=>{
  for (const mode of ['enabled','disabled','failure']) {
    let warms=0, searches=0;
    const app=await buildApp({...loadConfig({}),prewarm:mode!=='disabled'}, {
      ...provider,
      warmup:async signal=>{assert.equal(signal.aborted,false);warms++;if(mode==='failure')throw new Error('Unavailable');},
      search:async options=>{searches++;return provider.search(options,new AbortController().signal);},
    });
    try {
      await app.ready();
      assert.equal(warms,mode==='disabled'?0:1);assert.equal(searches,0);
      assert.equal((await app.inject('/v1/search?q=Example')).statusCode,200);
      assert.equal(searches,1);
    } finally {await app.close();}
  }
});
test('HTTP responses keep field groups, record summaries and previous names (nothing stripped by the response schema)',async()=>{
  const field={key:'previousCompanyStatus',label:'Company status',value:'Removed (Effective from 11 March 2026 to 22 April 2026)',displayValue:'Removed (Effective from 11 March 2026 to 22 April 2026)',group:'Previous Statuses'};
  const record={title:'Aido Proprietary Limited (BW00008005890)',summary:['Botswana'],group:'Previous Secretaries',fields:[field],text:'Aido'};
  const section={label:'General Details',status:'available' as const,fields:[field],records:[record],tables:[],text:'',pagesFetched:1,total:null,complete:true,warnings:[]};
  const app=await buildApp({...loadConfig({}),prewarm:false},{...provider,
    search:async o=>({query:o.q,items:[{uin:'BW00000123456',name:'Example',status:'Registered',register:'Companies',entityType:'Private company',registeredOn:'2018-01-29',address:'Plot 1',previousNames:['Old Example (2010 - 2018)'],previousAddresses:['Plot 0 (2010 - 2018)'],fields:[field],text:'Example'}],page:1,pageSize:20,total:1,hasMore:false,retrievedAt:'2026-09-11T00:00:00Z',source:'CIPA'}),
    getEntity:async()=>({uin:'BW00000123456',name:'Example',status:'Registered',entityType:'Private company',availableSections:[{key:'general',label:'General Details'}],sections:{general:section},complete:true,warnings:[],retrievedAt:'2026-09-11T00:00:00Z',source:'CIPA'})});
  try {
    const entity=(await app.inject('/v1/entities/BW00000123456')).json().data;
    assert.deepEqual(entity.sections.general.fields,[field]);
    assert.deepEqual(entity.sections.general.records,[record]);
    const item=(await app.inject('/v1/search?q=Example')).json().data.items[0];
    assert.deepEqual(item.previousNames,['Old Example (2010 - 2018)']);
    assert.deepEqual(item.previousAddresses,['Plot 0 (2010 - 2018)']);
    assert.deepEqual(item.fields,[field]);
  } finally {await app.close();}
});
