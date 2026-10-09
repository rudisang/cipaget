// Research only: retain loaded UI modules while obtaining a fresh empty search view.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { ENTRY_URL } from '../src/types.js';
export function installPersistentReset(provider: any) {
  const original = provider.prepareSearchForm.bind(provider);
  let captured = false;
  provider.prepareSearchForm = async (session: any) => {
    const { page } = session;
    if (!page.url().startsWith('https://www.cipa.co.bw/') || !await page.evaluate(() => typeof (window as any).serviceVue === 'object')) return original(session);
    const started = performance.now();
    const document = await page.evaluate(async url => {
      const response = await fetch(url, { credentials: 'same-origin', signal: AbortSignal.timeout(20000) });
      return { status: response.status, url: response.url, html: await response.text() };
    }, ENTRY_URL);
    assert.equal(document.status, 200);
    assert.equal(new URL(document.url).origin, 'https://www.cipa.co.bw');
    assert.match(new URL(document.url).pathname, /^\/master\/ui\//);
    const graph = JSON.parse(document.html.match(/var viewTree = (.+);\s*\n/)?.[1] ?? 'null');
    assert.ok(graph?.root);
    const init = document.html.split('\n').find((line: string) => line.includes('serviceVue = initVerne('));
    const service = JSON.parse(init?.match(/, service:(\{.+\}), layout:/)?.[1] ?? 'null');
    const catalyst: Record<string, unknown> = {};
    for (const key of ['appCode', 'serviceTransactionId', 'serviceTransactionUid', 'serviceCode', 'businessIdentifier', 'identifier', 'useServiceTransactionId']) {
      const literal = document.html.match(new RegExp(`Catalyst\\.${key} = ([^;\\n]+);`))?.[1];
      assert.ok(literal, key); catalyst[key] = JSON.parse(literal);
    }
    assert.equal(catalyst.appCode, 'master');
    assert.equal(catalyst.serviceCode, 'CIPARegisterSearch');
    if (!captured) {
      captured = true; await mkdir('output/playwright/persistent-reset', { recursive: true });
      await writeFile('output/playwright/persistent-reset/search-bootstrap.json', JSON.stringify({ graph, service, catalyst }, null, 2));
      console.log({ searchService: service.code, mode: service.mode });
    }
    await page.waitForFunction(() => (window as any).Catalyst.queue.empty(), null, { timeout: 20000 });
    await page.evaluate(({ graph, service, catalyst, url }: any) => {
      const w = window as any;
      for (const [id, node] of Object.entries(graph)) if (id !== 'root') {
        if (node) w.vueGenerateInlineTemplate(node);
        graph[id] = w.freezeNodeState(node);
      }
      Object.assign(w.Catalyst, catalyst);
      w.viewTree = graph; w.serviceVue.viewtree = graph; w.serviceVue.service = service;
      w.serviceVue.errors = []; w.serviceVue.flash = false; w.serviceVue.childviewtree = {};
      history.replaceState(null, '', url);
    }, { graph, service, catalyst, url: document.url });
    session.state = {};
    const input = page.getByRole('textbox', { name: 'Name or number', exact: true });
    await input.waitFor(); await provider.settle(session);
    assert.equal(await input.inputValue(), '');
    assert.equal(await page.getByRole('heading', { name: 'Search Results', exact: true }).isVisible(), false);
    console.log({ resetMs: Math.round(performance.now() - started) });
  };
}
