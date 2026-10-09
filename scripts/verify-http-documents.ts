import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const dir='output/playwright/http-documents';await mkdir(dir,{recursive:true});
for(const uin of ['BW00000790718','BW00001142508']) {
  const started=performance.now();
  const documentRequest=fetch(`http://127.0.0.1:3000/v1/entities/${uin}/documents`).then(async response=>{
    assert.equal(response.status,200);const body=await response.json();
    assert.equal(body.data.complete,true,JSON.stringify(body.data.warnings));assert.equal(body.meta.cache,'miss');assert.equal(body.data.documents.length,2);
    for(const doc of body.data.documents){
      assert.equal(doc.status,'available',JSON.stringify(doc.warnings));const bytes=Buffer.from(doc.contentBase64,'base64');
      assert.equal(bytes.subarray(0,5).toString(),'%PDF-');assert.equal(bytes.length,doc.sizeBytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),doc.sha256);assert.ok(doc.filename.includes(uin));
      await writeFile(`${dir}/${uin}-${doc.kind}.pdf`,bytes);
    }
    await writeFile(`${dir}/${uin}-documents.json`,JSON.stringify(body,null,2));
    return {ms:Math.round(performance.now()-started),meta:body.meta,documents:body.data.documents.map(({kind,sizeBytes}:any)=>({kind,sizeBytes}))};
  });
  const dataRequest=fetch(`http://127.0.0.1:3000/v1/entities/${uin}`).then(async response=>{
    assert.equal(response.status,200);const body=await response.json();assert.equal(body.data.complete,true);assert.equal(body.data.documents,undefined);assert.equal(body.meta.cache,'miss');
    const expected=JSON.parse(await readFile(`output/performance/final-data/${uin}-0.json`,'utf8'));
    assert.deepEqual(body.data.sections,expected.sections);await writeFile(`${dir}/${uin}-data.json`,JSON.stringify(body,null,2));
    return {ms:Math.round(performance.now()-started),meta:body.meta,sections:Object.keys(body.data.sections).length,parity:true};
  });
  const [documents,data]=await Promise.all([documentRequest,dataRequest]);
  console.log(JSON.stringify({uin,data,documents}));
}
const repeat=await fetch('http://127.0.0.1:3000/v1/entities/BW00000790718/documents').then(r=>r.json());assert.equal(repeat.meta.cache,'hit');console.log(JSON.stringify({documentRepeat:repeat.meta}));
