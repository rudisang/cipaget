// Run against a freshly restarted local API so the full-data checks are cache misses.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const base = process.env.CIPAGET_TEST_BASE ?? 'http://127.0.0.1:3000';
assert.equal(new URL(base).hostname, '127.0.0.1');
const label = process.argv[2] ?? 'idle-api';
assert.match(label, /^[a-z\d-]+$/);
const output = `output/playwright/${label}`;
const rounds = Number(process.argv[3] ?? 1);
assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 3);
const before = await fetch(base + '/healthz').then(response => response.json());
await mkdir(output, { recursive: true });
for (const path of ['/healthz', '/docs/', '/openapi.json']) {
  const response = await fetch(base + path);
  assert.equal(response.status, 200);
  if (path === '/openapi.json') assert.ok((await response.json()).paths['/v1/entities/{uin}/documents']);
}
for (let round = 0; round < rounds; round++) for (const uin of ['BW00000790718', 'BW00001142508']) {
  const started = performance.now();
  const response = await fetch(`${base}/v1/entities/${uin}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.meta.cache, 'miss');
  assert.equal(body.data.complete, true);
  assert.equal(body.data.documents, undefined);
  const expected = JSON.parse(await readFile(`output/performance/final-data/${uin}-0.json`, 'utf8'));
  for (const key of ['uin','name','status','entityType','availableSections']) assert.deepEqual(body.data[key], expected[key], key);
  assert.deepEqual(body.data.sections, expected.sections);
  await writeFile(`${output}/${uin}-${round}.json`, JSON.stringify(body, null, 2));
  console.log({ uin, round, httpMs: Math.round(performance.now() - started), meta: body.meta, sections: Object.keys(body.data.sections).length, parity: true });
}
const empty = await fetch(`${base}/v1/search?q=CIPAGET-NO-MATCH-20260912-ZZQJX`).then(async response => {
  assert.equal(response.status, 200); return response.json();
});
assert.deepEqual(empty.data.items, []); assert.equal(empty.data.hasMore, false);
console.log({ emptySearch: 'passed' });
const after = await fetch(base + '/healthz').then(response => response.json());
if (process.env.CIPAGET_EXPECT_HYBRID === 'true') {
  assert.equal(after.transport.transport, 'hybrid');
  assert.equal(after.transport.hybridViews - before.transport.hybridViews, rounds * 8);
  assert.equal(after.transport.hybridFallbacks, before.transport.hybridFallbacks);
  assert.ok(after.transport.publicLinkHits - before.transport.publicLinkHits >= (rounds - 1) * 8, 'Repeated UINs should reuse public routes but fetch fresh company views');
  assert.equal(after.transport.resetFallbacks, before.transport.resetFallbacks);
  assert.equal(after.documents.transport.transport, 'browser');
  console.log({ transport: after.transport, documentTransport: after.documents.transport.transport });
}
