// Explicit research only. Not exported by the library or enabled by the API.
// Reads the existing public search card's action and its same-session redirect.
import assert from 'node:assert/strict';
import { ApiError } from '../src/errors.js';
import { parseSearch } from '../src/parser.js';
import { ENTRY_URL } from '../src/types.js';

export function installBatchedEntitySearch(provider: any) {
  const original = provider.searchOn.bind(provider);
  provider.searchOn = async (session: any, options: any) => {
    if (!/^BW\d+$/.test(options.q) || options.page !== 1 || options.pageSize !== 20) return original(session, options);
    const { page } = session;
    session.state = {};
    const input = page.getByRole('textbox', { name: 'Name or number', exact: true });
    if (!page.url().includes('/master/ui/') || !await input.isVisible()) await provider.prepareSearchForm(session);
    await provider.settle(session);
    const inputId = await input.getAttribute('id');
    const buttonId = (await page.getByRole('button', { name: 'Search', exact: true }).getAttribute('id'))?.replace(/_btn$/, '');
    assert.match(inputId, /^[a-f\d]+$/); assert.match(buttonId, /^[a-f\d]+$/);
    await page.evaluate(async ({ inputId, buttonId, q }: any) => {
      const w = window as any;
      if (w.serviceVue.viewtree[inputId]?.nodetype !== 'attribute' || w.serviceVue.viewtree[buttonId]?.nodetype !== 'button') throw Error('Search control mapping changed');
      const data = await w.Catalyst.processUpdate({ commands: [
        { type: 'view-node-set-attribute-value', id: inputId, value: q },
        { type: 'view-node-button-click', id: buttonId },
      ] });
      if (data.error || !data.state || data.redirect) throw Error('Unexpected batched search response');
    }, { inputId, buttonId, q: options.q });
    await page.getByRole('heading', { name: 'Search Results', exact: true }).waitFor();
    const main = page.getByRole('main');
    await main.locator('.search-result a.searchView').or(main.getByText(/Your search returned no results|No results found using the given search criteria/i)).first().waitFor();
    await provider.settle(session);
    const parsed = parseSearch(await provider.visibleHtml(main));
    return { ...parsed, query: options.q, page: 1, pageSize: 20, sourcePagesFetched: 1, warnings: [], retrievedAt: new Date().toISOString(), source: ENTRY_URL };
  };
}

export function installHybridNavigation(provider: any) {
  const open = async (session: any, uin: string) => {
    const { page } = session;
    let previous = performance.now();
    const phases: Record<string, number> = {};
    const mark = (phase: string) => { const now = performance.now(); phases[phase] = Math.round(now - previous); previous = now; };
    const browserFetch = async (method: string, url: string, options: any) => {
      const result = await page.evaluate(async ({ method, url, options }: any) => {
        const response = await fetch(url, {
          method, credentials: 'same-origin', redirect: method === 'GET' ? 'follow' : 'error',
          headers: { 'Content-Type': 'application/json', ...options.headers },
          body: options.data ? JSON.stringify(options.data) : undefined,
          signal: AbortSignal.timeout(options.timeout),
        });
        return { status: response.status, url: response.url, headers: Object.fromEntries(response.headers), text: await response.text() };
      }, { method, url, options });
      return { status: () => result.status, url: () => result.url, headers: () => result.headers, text: async () => result.text, json: async () => JSON.parse(result.text) };
    };
    const request = process.argv.includes('--browser-fetch') ? {
      post: (url: string, options: any) => browserFetch('POST', url, options),
      get: (url: string, options: any) => browserFetch('GET', url, options),
    } : page.request;
    const search = await provider.searchOn(session, { q: uin, page: 1, pageSize: 20 });
    mark('search');
    const match = search.items.find((item: any) => item.uin === uin);
    if (!match) throw new ApiError('ENTITY_NOT_FOUND', 'No public entity with this UIN was returned by CIPA.', 404);
    const card = page.getByRole('link', { name: `${match.name} (${uin})`, exact: true });
    const domId = await card.getAttribute('id');
    assert.match(domId, /^[a-f\d]+_btn$/);
    const id = domId.slice(0, -4);
    // Bind the action to the rendered public card, never enumerate arbitrary node IDs.
    assert.equal(await page.evaluate(({ id, label }: any) => {
      const node = (window as any).serviceVue.viewtree[id];
      return node?.nodetype === 'button' && node.text?.label === label;
    }, { id, label: `${match.name} (${uin})` }), true);
    const response = await request.post(page.url(), {
      data: { returnRootHtmlOnChange: false, returnChangesOnly: true, commands: [{ type: 'view-node-button-click', id }] },
      headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: page.url() }, timeout: 20000, maxRedirects: 0,
    });
    assert.equal(response.status(), 200, `Public card HTTP ${response.status()}`);
    const data = await response.json();
    mark('cardAction');
    assert.ok(!data.error && typeof data.redirect === 'string', 'Expected a public company redirect');
    let url = new URL(data.redirect, page.url());
    assert.equal(url.origin, 'https://www.cipa.co.bw');
    assert.match(url.pathname, /^\/companies\/ui\//);
    let document;
    for (let hop = 0; hop < 5; hop++) {
      document = await request.get(url.href, { timeout: 20000, maxRedirects: 0 });
      if (![301, 302, 303, 307, 308].includes(document.status())) break;
      assert.ok(document.headers().location, 'Missing redirect location');
      url = new URL(document.headers().location, url);
      assert.equal(url.origin, 'https://www.cipa.co.bw');
      assert.match(url.pathname, /^\/companies\/ui\//);
    }
    assert.ok(document);
    assert.equal(document.status(), 200, `Company view HTTP ${document.status()}`);
    url = new URL(document.url());
    assert.equal(url.origin, 'https://www.cipa.co.bw');
    assert.match(url.pathname, /^\/companies\/ui\//);
    const html = await document.text();
    mark('viewDocument');
    const graph = JSON.parse(html.match(/var viewTree = (.+);\s*\n/)?.[1] ?? 'null');
    assert.ok(graph?.root, 'Missing company view graph');
    const init = html.split('\n').find((line: string) => line.includes('serviceVue = initVerne('));
    const service = JSON.parse(init?.match(/, service:(\{.+\}), layout:/)?.[1] ?? 'null');
    assert.ok(service?.code, 'Missing company service metadata');
    const catalyst: Record<string, string> = {};
    for (const key of ['appCode', 'serviceTransactionId', 'serviceTransactionUid', 'serviceCode', 'businessIdentifier', 'identifier', 'useServiceTransactionId']) {
      const literal = html.match(new RegExp(`Catalyst\\.${key} = ("[^"\\n]*");`))?.[1];
      assert.ok(literal, `Missing ${key}`); catalyst[key] = JSON.parse(literal);
    }
    assert.equal(catalyst.businessIdentifier, uin);
    mark('parseBootstrap');
    await page.evaluate(({ graph, service, catalyst, url }: any) => {
      const w = window as any;
      for (const [id, node] of Object.entries(graph)) if (id !== 'root') {
        if (node) w.vueGenerateInlineTemplate(node);
        graph[id] = w.freezeNodeState(node);
      }
      Object.assign(w.Catalyst, catalyst);
      w.viewTree = graph; w.serviceVue.viewtree = graph; w.serviceVue.service = service;
      history.replaceState(null, '', url);
    }, { graph, service, catalyst, url: url.href });
    session.state = {};
    mark('initializeRenderer');
    await page.getByRole('heading', { name: 'General Details', exact: true }).waitFor();
    mark('generalHeading');
    await provider.settle(session);
    mark('settle');
    (provider.hybridTimings ??= []).push({ uin, phases });
    return { match, url: url.href };
  };
  provider.openEntity = async (...args: any[]) => {
    try { return await open(args[0], args[1]); }
    catch (error) { console.error('Hybrid research failure:', error instanceof Error ? error.message.slice(0, 400) : 'Unknown error'); throw error; }
  };
}
