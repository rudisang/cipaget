import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { encodeDocument, readDocument, MAX_DOCUMENT_BYTES } from '../src/documents.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const bytes=Buffer.from('%PDF-1.7\nsynthetic test content\n%%EOF\n');
test('inline PDF preserves bytes, fingerprint and a safe filename; rejects HTML/truncated/oversized responses',()=>{
  const document=encodeDocument('standardExtract','../example.pdf',bytes);
  assert.deepEqual(Buffer.from(document.contentBase64!,'base64'),bytes);
  assert.equal(document.sha256,createHash('sha256').update(bytes).digest('hex'));
  assert.equal(document.sizeBytes,bytes.length);assert.ok(!document.filename!.includes('/'));
  assert.ok(encodeDocument('standardExtract',`${'Long company '.repeat(30)}-BW00000123456.pdf`,bytes).filename!.endsWith('BW00000123456.pdf'));
  for(const invalid of [Buffer.from('<html>denied</html>'),Buffer.from('%PDF-1.7\ntruncated')])assert.throws(()=>encodeDocument('standardExtract','x.pdf',invalid),{code:'INVALID_DOCUMENT'});
  assert.throws(()=>encodeDocument('standardExtract','x.pdf',Buffer.alloc(MAX_DOCUMENT_BYTES+1)),{code:'DOCUMENT_TOO_LARGE'});
});
test('download cleanup runs on success and invalid source',async()=>{
  let deleted=0,cancelled=0;
  const download:any={url:()=> 'https://www.cipa.co.bw/companies/document/example',suggestedFilename:()=> 'example.pdf',createReadStream:async()=>Readable.from([bytes]),delete:async()=>{deleted++;},cancel:async()=>{cancelled++;}};
  assert.equal((await readDocument('standardExtract',download)).status,'available');assert.equal(deleted,1);
  download.url=()=> 'https://example.com/not-cipa.pdf';
  await assert.rejects(readDocument('standardExtract',download),{code:'UNEXPECTED_DOCUMENT_SOURCE'});
  assert.equal(deleted,2);assert.equal(cancelled,1);
});
test('business-name certificates and extracts come from the businessnames document routes',async()=>{
  const download=(url:string):any=>({url:()=>url,suggestedFilename:()=>'Registration-Example Hyper.pdf',createReadStream:async()=>Readable.from([bytes]),delete:async()=>{},cancel:async()=>{}});
  assert.equal((await readDocument('incorporationCertificate',download('https://www.cipa.co.bw/businessnames/template/XP-x?template=CORR-N002-02'))).status,'available');
  assert.equal((await readDocument('standardExtract',download('https://www.cipa.co.bw/businessnames/document/abc:BusinessReport:View/def?attachment=true'))).status,'available');
  await assert.rejects(readDocument('standardExtract',download('https://www.cipa.co.bw/businessnames/template/XP-x')),{code:'UNEXPECTED_DOCUMENT_SOURCE'},'a certificate route is not an extract');
  await assert.rejects(readDocument('incorporationCertificate',download('https://www.cipa.co.bw/reservednames/template/XP-x')),{code:'UNEXPECTED_DOCUMENT_SOURCE'});
});
test('documents have a separate endpoint, schema, cache and worker queue',async()=>{
  let documents=0;
  const entity={uin:'BW00000123456',name:'Example',status:null,entityType:null,availableSections:[],sections:{},complete:true,warnings:[],retrievedAt:'now',source:'CIPA'};
  let release!:()=>void;
  const pending=new Promise<void>(resolve=>release=resolve);
  let started!:()=>void;const documentStarted=new Promise<void>(resolve=>started=resolve);
  const app=await buildApp({...loadConfig({}),prewarm:false},{search:async()=>{throw new Error('unused');},close:async()=>{},getEntity:async()=>entity,getDocuments:async uin=>{
    documents++;started();await pending;
    return {uin,name:'Example',documents:[encodeDocument('standardExtract','example.pdf',bytes)],complete:true,warnings:[],retrievedAt:'now',source:'CIPA'};
  }});
  try {
    const request=app.inject('/v1/entities/BW00000123456/documents');
    const documentResponse=Promise.resolve(request);await documentStarted;
    const data=await app.inject('/v1/entities/BW00000123456');assert.equal(data.statusCode,200);assert.equal(data.json().data.documents,undefined);
    release();const response=await documentResponse;assert.equal(response.statusCode,200);
    assert.deepEqual(Buffer.from(response.json().data.documents[0].contentBase64,'base64'),bytes);
    assert.equal((await app.inject('/v1/entities/BW00000123456/documents')).json().meta.cache,'hit');assert.equal(documents,1);
    assert.equal((await app.inject('/v1/entities/BW00000123456?documents=true')).statusCode,400);
    assert.equal((await app.inject('/openapi.json')).json().paths['/v1/entities/{uin}/documents'].get.tags[0],'Documents');
  } finally {release();await app.close();}
});
