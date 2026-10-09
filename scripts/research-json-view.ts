// Read-only protocol research. No commands or company mutations are submitted.
// Inspect whether the current public UI can return its full rendering state as JSON.
import { mkdir, writeFile } from 'node:fs/promises';
import { CipaBrowser } from '../src/browser.js';
import { loadConfig } from '../src/config.js';
import { checkPublicStatus } from '../src/hybrid.js';
const provider = new CipaBrowser(loadConfig({ ...process.env, DETAIL_CONCURRENCY: '1', BROWSER_PREWARM: 'false' }));
const p = provider as any;
const dir = 'output/playwright/json-view';
await mkdir(dir, { recursive: true });
try {
  for (const uin of ['BW00000790718', 'BW00001142508']) await p.withSession(AbortSignal.timeout(60000), async (session: any) => {
    await p.openEntity(session, uin, true);
    const { page } = session;
    const before = await page.evaluate(() => (window as any).serviceVue.viewtree.root);
    if (process.argv.includes('--browser-fetch')) {
      const results = [];
      for (const kind of ['json', 'html', 'html', 'json']) {
        const result = await page.evaluate(async ({ kind, root }) => {
          const started = performance.now();
          const response = await fetch(location.href, kind === 'json' ? {
            method: 'POST', credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(20000),
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            body: JSON.stringify({ returnRootHtmlOnChange: false, returnChangesOnly: false, commands: [] }),
          } : { credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(20000) });
          const text = await response.text(), data = kind === 'json' && response.status === 200 ? JSON.parse(text) : null;
          const entry = performance.getEntriesByName(response.url).at(-1) as PerformanceResourceTiming | undefined;
          return { kind, status: response.status, ms: Math.round(performance.now() - started), encoding: response.headers.get('content-encoding'),
            bytes: new TextEncoder().encode(text).length, transferBytes: entry?.transferSize, encodedBytes: entry?.encodedBodySize,
            ttfbMs: entry ? Math.round(entry.responseStart - entry.requestStart) : null,
            serverMs: data?.elapsedMs, stateNodes: data ? Object.keys(data.state ?? {}).length : undefined,
            sameRoot: data ? data.state?.root === root : undefined, keys: data ? Object.keys(data) : undefined };
        }, { kind, root: before });
        checkPublicStatus(result.status); results.push(result);
      }
      await writeFile(`${dir}/${uin}-native.json`, JSON.stringify(results, null, 2));
      console.log(JSON.stringify({ uin, results })); return;
    }
    const started = performance.now();
    const response = await page.request.post(page.url(), {
      data: { returnRootHtmlOnChange: false, returnChangesOnly: false, commands: [] },
      headers: { 'X-Requested-With': 'XMLHttpRequest' }, timeout: 20000, maxRedirects: 0,
    });
    checkPublicStatus(response.status());
    const data = await response.json(), jsonMs = Math.round(performance.now() - started);
    await writeFile(`${dir}/${uin}.json`, JSON.stringify(data, null, 2));
    const htmlStarted = performance.now();
    const document = await page.request.get(page.url(), { timeout: 20000, maxRedirects: 0 });
    checkPublicStatus(document.status());
    const html = await document.text();
    console.log({ uin, jsonMs, htmlMs: Math.round(performance.now() - htmlStarted),
      keys: Object.keys(data), stateNodes: Object.keys(data.state ?? {}).length,
      sameRoot: data.state?.root === before, serviceStateKeys: Object.keys(data.serviceState ?? {}),
      responseDataKeys: Object.keys(data.responseData ?? {}), jsonBytes: Buffer.byteLength(JSON.stringify(data)), htmlBytes: Buffer.byteLength(html) });
  });
} finally { await provider.close(); }
