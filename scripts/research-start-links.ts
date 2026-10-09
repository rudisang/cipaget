import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { CipaBrowser } from '../src/browser.js';
import { loadConfig } from '../src/config.js';
import { checkPublicStatus } from '../src/hybrid.js';
const provider = new CipaBrowser(loadConfig({ ...process.env, DETAIL_CONCURRENCY: '1', BROWSER_PREWARM: 'false' }));
const p = provider as any, links = [];
try {
  for (const uin of ['BW00000790718', 'BW00001142508']) await p.withSession(AbortSignal.timeout(60000), async (session: any) => {
    const result = await p.searchOn(session, { q: uin, page: 1, pageSize: 20 }, true);
    const match = result.items.find((item: any) => item.uin === uin); assert.ok(match);
    const { page } = session;
    const id = (await page.getByRole('link', { name: `${match.name} (${uin})`, exact: true }).getAttribute('id')).replace(/_btn$/, '');
    await page.waitForFunction(() => (window as any).Catalyst.queue.empty());
    const response = await page.evaluate(async id => {
      const response = await fetch(location.href, { method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(20000),
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ returnRootHtmlOnChange: false, returnChangesOnly: true, commands: [{ type: 'view-node-button-click', id }] }) });
      return { status: response.status, data: await response.json() };
    }, id);
    checkPublicStatus(response.status); assert.equal(typeof response.data.redirect, 'string');
    const url = new URL(response.data.redirect, page.url());
    links.push({ uin, name: match.name, url: url.href });
    console.log({ uin, origin: url.origin, pathname: url.pathname.replace(/XP-[^/]+/g, '<opaque>'), params: [...url.searchParams].map(([key,value]) => [key, value.length > 100 ? '<opaque>' : value]), containsUin: url.href.includes(uin) });
  });
  await mkdir('output/playwright/start-links', { recursive: true });
  await writeFile('output/playwright/start-links/links.json', JSON.stringify(links, null, 2));
} finally { await provider.close(); }
