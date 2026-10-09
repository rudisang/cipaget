import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { ResultCache } from '../src/cache.js';
import { WorkQueue } from '../src/queue.js';
import { CipaClient, validateEntity, validateSearch } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { ApiError } from '../src/errors.js';
import type { RegistryProvider } from '../src/types.js';

test('cache enforces expiry, LRU, bytes, and caller mutation isolation',()=>{
  let now=0;const cache=new ResultCache(2,200,()=>now);
  cache.set('a',{name:'A'},100);cache.set('b',{name:'B'},100);
  const a=cache.get<any>('a')!;a.data.name='changed';assert.equal(cache.get<any>('a')!.data.name,'A');
  cache.set('c',{name:'C'},100);assert.equal(cache.get('b'),undefined);
  now=100;assert.equal(cache.get('a'),undefined);
  cache.set('large','x'.repeat(500),100);assert.equal(cache.get('large'),undefined);
});
test('queue bounds concurrency, rejects overflow, and times out queued work',async()=>{
  const queue=new WorkQueue(1,1,15,1000);let release!:()=>void;
  const first=queue.run(()=>new Promise<void>(r=>release=r));
  const second=queue.run(async()=>true);const rejected=assert.rejects(second,{code:'QUEUE_TIMEOUT'});
  await assert.rejects(queue.run(async()=>true),{code:'QUEUE_FULL'});
  await rejected;release();await first;assert.equal(queue.stats.active,0);queue.close();
});
test('operation timeout aborts the resource and releases slot only after cleanup',async()=>{
  const queue=new WorkQueue(1,1,1000,15);let aborted=false;
  const job=queue.run(signal=>new Promise<void>((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;setTimeout(()=>reject(signal.reason),10);}))); 
  await assert.rejects(job,{code:'OPERATION_TIMEOUT'});assert.equal(aborted,true);assert.equal(queue.stats.active,1);
  await delay(25);assert.equal(queue.stats.active,0);queue.close();
});
test('client coalesces identical work, serves cache, and does not cache partial results',async()=>{
  let calls=0;
  const provider:RegistryProvider={search:async o=>{calls++;await delay(15);return {query:o.q,items:[],page:1,pageSize:20,hasMore:false,total:0,retrievedAt:'now',source:'CIPA'};},getEntity:async()=>({uin:'BW00000123456',name:'Example',status:null,entityType:null,sections:{},availableSections:[],complete:false,warnings:['partial'],retrievedAt:'now',source:'CIPA'}),close:async()=>{}};
  const client=new CipaClient(loadConfig({}),provider);
  const [a,b]=await Promise.all([client.search({q:'Example'}),client.search({q:'Example'})]);
  assert.equal(calls,1);assert.equal(a.meta.cache,'miss');assert.equal(b.meta.cache,'coalesced');
  assert.equal((await client.search({q:'Example'})).meta.cache,'hit');
  await client.getEntity('BW00000123456');assert.equal((await client.getEntity('BW00000123456')).meta.cache,'miss');
  await client.close();
});
test('upstream access restrictions trigger a cooldown without extra requests',async()=>{
  let calls=0;const provider={search:async()=>{calls++;throw new ApiError('UPSTREAM_RATE_LIMITED','limited',503,true);},close:async()=>{}} as unknown as RegistryProvider;
  const client=new CipaClient(loadConfig({}),provider);
  await assert.rejects(client.search({q:'First'}),{code:'UPSTREAM_RATE_LIMITED'});
  await assert.rejects(client.search({q:'Second'}),{code:'UPSTREAM_COOLDOWN'});assert.equal(calls,1);await client.close();
});
test('library validates arguments before launching a browser',()=>{
  assert.throws(()=>validateSearch({q:'  '}),{code:'INVALID_QUERY'});
  assert.throws(()=>validateSearch({q:'Example',page:1.5}),{code:'INVALID_PAGE'});
  assert.throws(()=>validateEntity('https://example.com'),{code:'INVALID_UIN'});
  assert.throws(()=>validateEntity('BW00000123456',{include:['__proto__']}),{code:'INVALID_INCLUDE'});
  assert.equal(validateSearch({q:' Example   Co '}).q,'Example Co');
  assert.throws(()=>loadConfig({HOST:'0.0.0.0'}),/API_KEY/);
});
test('search has its own lane and does not wait behind an entity read',async()=>{
  let releaseEntity!:()=>void;const order:string[]=[];
  const entityResult={uin:'BW00000123456',name:'Example',status:null,entityType:null,sections:{},availableSections:[],complete:true,warnings:[],retrievedAt:'now',source:'CIPA'};
  const provider:RegistryProvider={
    search:async o=>{order.push('search');return {query:o.q,items:[],page:1,pageSize:20,hasMore:false,total:0,retrievedAt:'now',source:'CIPA'};},
    getEntity:()=>new Promise(resolve=>{releaseEntity=()=>{order.push('entity');resolve(entityResult);};}),
    close:async()=>{},
  };
  // One browser slot and a short queue wait: a search stuck behind the entity read would time out.
  const client=new CipaClient(loadConfig({QUEUE_TIMEOUT_MS:'100'}),provider);
  const entity=client.getEntity('BW00000123456');
  try {
    await delay(5);
    await client.search({q:'Example'});
    assert.deepEqual(order,['search']);
  } finally { releaseEntity();await entity;await client.close(); }
});
test('SEARCH_CONCURRENCY sizes the search lane and health reports it separately',async()=>{
  assert.equal(loadConfig({}).searchConcurrency,1);
  assert.throws(()=>loadConfig({SEARCH_CONCURRENCY:'0'}),/SEARCH_CONCURRENCY/);
  const provider={close:async()=>{}} as unknown as RegistryProvider;
  const client=new CipaClient(loadConfig({SEARCH_CONCURRENCY:'2'}),provider);
  assert.equal(client.stats.search.concurrency,2);
  assert.equal(client.stats.concurrency,1);
  await client.close();
});
