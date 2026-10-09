import type { Page } from 'playwright';
import { ApiError } from './errors.js';
import { ENTRY_URL, type SearchItem } from './types.js';
import { cardLabel, isBusinessName } from './identifiers.js';
import { clean } from './parser.js';

/** Only a changed/unsupported public view may fall back to ordinary navigation. */
export class HybridUnsupported extends Error {}
const requireShape: (condition: unknown) => asserts condition = condition => {
  if (!condition) throw new HybridUnsupported('The public view does not match the supported hybrid layout.');
};
export function publicViewUrl(value: string, base: string): string {
  const url = new URL(value, base);
  // Companies of every observed type open under /companies/; business names under /businessnames/.
  if (url.origin !== 'https://www.cipa.co.bw' || url.username || url.password || !/^\/(?:companies|businessnames)\/ui\//.test(url.pathname)) {
    throw new ApiError('UPSTREAM_ACCESS_RESTRICTED', 'CIPA redirected outside the public entity view.', 503, false);
  }
  return url.href;
}
export function checkPublicStatus(status: number): void {
  if (status === 429) throw new ApiError('UPSTREAM_RATE_LIMITED', 'CIPA has rate-limited this session. Retry later.', 503, true);
  if ([401, 403].includes(status)) throw new ApiError('UPSTREAM_ACCESS_RESTRICTED', 'CIPA denied access to this session.', 503, false);
  if (status !== 200) throw new ApiError('UPSTREAM_UNAVAILABLE', `CIPA returned HTTP ${status}.`, 502, true);
}

function parseBootstrap(html: string) {
  try {
    requireShape(html.length <= 10 * 1024 * 1024);
    const graph = JSON.parse(html.match(/var viewTree = (.+);\s*\n/)?.[1] ?? 'null');
    requireShape(graph && typeof graph === 'object' && !Array.isArray(graph));
    requireShape(typeof graph.root === 'string' && Object.hasOwn(graph, graph.root) && graph[graph.root] && typeof graph[graph.root] === 'object');
    requireShape(!['__proto__', 'constructor', 'prototype'].some(key => Object.hasOwn(graph, key)));
    const init = html.split('\n').find(line => line.includes('serviceVue = initVerne('));
    const service = JSON.parse(init?.match(/, service:(\{.+\}), layout:/)?.[1] ?? 'null');
    requireShape(service && typeof service.code === 'string');
    const catalyst: Record<string, string> = {};
    for (const key of ['appCode', 'serviceTransactionId', 'serviceTransactionUid', 'serviceCode', 'businessIdentifier', 'identifier', 'useServiceTransactionId']) {
      const literal = html.match(new RegExp(`Catalyst\\.${key} = ("[^"\\n]*");`))?.[1];
      requireShape(literal); catalyst[key] = JSON.parse(literal);
    }
    requireShape(catalyst.serviceCode === service.code);
    return { graph, service, catalyst };
  } catch (error) {
    if (error instanceof ApiError || error instanceof HybridUnsupported) throw error;
    throw new HybridUnsupported('The public view bootstrap could not be read.');
  }
}

export function parsePublicView(html: string, uin: string) {
  const bootstrap = parseBootstrap(html);
  requireShape(bootstrap.service.mode === 'View' && bootstrap.catalyst.appCode === (isBusinessName(uin) ? 'businessnames' : 'companies'));
  if (bootstrap.catalyst.businessIdentifier !== uin) throw new ApiError('UPSTREAM_IDENTITY_MISMATCH', 'CIPA returned a different entity view.');
  return bootstrap;
}

export function parseSearchView(html: string) {
  const bootstrap = parseBootstrap(html);
  requireShape(bootstrap.service.mode === 'Search' && bootstrap.service.code === 'CIPARegisterSearch' && bootstrap.catalyst.appCode === 'master');
  return bootstrap;
}

async function applyView(page: Page, bootstrap: ReturnType<typeof parseBootstrap>, url: string, timeoutMs: number) {
  // Finish old UI callbacks before changing the service transaction they address.
  await page.waitForFunction(() => (window as any).Catalyst.queue.empty(), null, { timeout: timeoutMs });
  await page.evaluate(({ graph, service, catalyst, url }) => {
    const w = window as any;
    for (const [id, node] of Object.entries(graph)) if (id !== 'root') {
      if (node) w.vueGenerateInlineTemplate(node);
      graph[id] = w.freezeNodeState(node);
    }
    Object.assign(w.Catalyst, catalyst);
    w.viewTree = graph; w.serviceVue.viewtree = graph; w.serviceVue.service = service;
    w.serviceVue.errors = []; w.serviceVue.flash = false; w.serviceVue.childviewtree = {};
    history.replaceState(null, '', url);
  }, { ...bootstrap, url });
}

/** Fetch a fresh empty search form, preserving loaded modules rather than company results. */
export async function resetHybridSearch(page: Page, timeoutMs: number): Promise<void> {
  requireShape(await page.evaluate(() => {
    const w = window as any;
    return !!w.serviceVue && typeof w.Catalyst?.queue?.empty === 'function' && typeof w.vueGenerateInlineTemplate === 'function' && typeof w.freezeNodeState === 'function';
  }));
  const document = await page.evaluate(async ({ url, timeoutMs }) => {
    const response = await fetch(url, { credentials: 'same-origin', signal: AbortSignal.timeout(timeoutMs) });
    return { status: response.status, url: response.url, text: await response.text() };
  }, { url: ENTRY_URL, timeoutMs });
  checkPublicStatus(document.status);
  const url = new URL(document.url);
  if (url.origin !== 'https://www.cipa.co.bw' || url.username || url.password || !/^\/master\/ui\//.test(url.pathname)) {
    throw new ApiError('UPSTREAM_ACCESS_RESTRICTED', 'CIPA redirected outside the public search view.', 503, false);
  }
  await applyView(page, parseSearchView(document.text), url.href, timeoutMs);
  const input = page.getByRole('textbox', { name: 'Name or number', exact: true });
  await input.waitFor();
  requireShape(await input.inputValue() === '');
  requireShape(!await page.getByRole('heading', { name: 'Search Results', exact: true }).isVisible());
}

/** Batch only the observed public search-field update and Search button action. The query is validated by the caller. */
export async function submitHybridSearch(page: Page, q: string): Promise<void> {
  const inputId = await page.getByRole('textbox', { name: 'Name or number', exact: true }).getAttribute('id');
  const buttonId = (await page.getByRole('button', { name: 'Search', exact: true }).getAttribute('id'))?.replace(/_btn$/, '');
  requireShape(inputId && /^[a-f\d]+$/.test(inputId));
  requireShape(buttonId && /^[a-f\d]+$/.test(buttonId));
  const supported = await page.evaluate(({ inputId, buttonId }) => {
    const w = window as any;
    return w.serviceVue?.viewtree[inputId]?.nodetype === 'attribute' && w.serviceVue?.viewtree[buttonId]?.nodetype === 'button' && typeof w.Catalyst?.processUpdate === 'function';
  }, { inputId, buttonId });
  requireShape(supported);
  const result = await page.evaluate(async ({ inputId, buttonId, q }) => {
    const data = await (window as any).Catalyst.processUpdate({ commands: [
      { type: 'view-node-set-attribute-value', id: inputId, value: q },
      { type: 'view-node-button-click', id: buttonId },
    ] });
    return { error: !!data.error, hasState: !!data.state, redirect: !!data.redirect };
  }, { inputId, buttonId, q });
  if (result.error || result.redirect) throw new ApiError('UPSTREAM_UNAVAILABLE', 'CIPA did not complete the public search.', 502, true);
  requireShape(result.hasState);
}

/** Follow the rendered public card within its own browser session, then use CIPA's renderer. */
export async function resolvePublicViewLink(page: Page, uin: string, match: SearchItem, timeoutMs: number): Promise<string> {
  const label = cardLabel(match.name, uin);
  const card = page.getByRole('link', { name: label, exact: true });
  const domId = await card.getAttribute('id');
  requireShape(domId && /^[a-f\d]+_btn$/.test(domId));
  const id = domId.slice(0, -4);
  // Registered names can carry stray whitespace ("Name  (BW…)") that the rendered link collapses.
  const node = await page.evaluate(id => {
    const w = window as any, node = w.serviceVue?.viewtree[id];
    return { button: node?.nodetype === 'button', label: typeof node?.text?.label === 'string' ? node.text.label : null,
      renderer: typeof w.vueGenerateInlineTemplate === 'function' && typeof w.freezeNodeState === 'function' };
  }, id);
  requireShape(node.button && node.renderer && node.label !== null && clean(node.label) === label);
  const response = await page.evaluate(async ({ id, timeoutMs }) => {
    const response = await fetch(location.href, {
      method: 'POST', credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ returnRootHtmlOnChange: false, returnChangesOnly: true, commands: [{ type: 'view-node-button-click', id }] }),
    });
    return { status: response.status, text: await response.text() };
  }, { id, timeoutMs });
  checkPublicStatus(response.status);
  let data: any;
  try { data = JSON.parse(response.text); } catch { throw new HybridUnsupported('Expected a public-view redirect.'); }
  if (data?.error) throw new ApiError('UPSTREAM_UNAVAILABLE', 'CIPA could not open the public company view.');
  requireShape(data && typeof data.redirect === 'string');
  return publicViewUrl(data.redirect, page.url());
}

export async function loadHybridView(page: Page, uin: string, link: string, timeoutMs: number): Promise<string> {
  const target = publicViewUrl(link, page.url());
  const document = await page.evaluate(async ({ target, timeoutMs }) => {
    const response = await fetch(target, { credentials: 'same-origin', signal: AbortSignal.timeout(timeoutMs) });
    return { status: response.status, url: response.url, text: await response.text() };
  }, { target, timeoutMs });
  checkPublicStatus(document.status);
  const url = publicViewUrl(document.url, target);
  const bootstrap = parsePublicView(document.text, uin);
  await applyView(page, bootstrap, url, timeoutMs);
  return url;
}

// Fresh headers title-case company types; search cards use sentence case. Business names already match.
const HEADER_TYPES: Record<string, string> = { 'Private Company': 'Private company', 'Public Company': 'Public company', 'External Company': 'External company', 'Close Company': 'Close company' };

/**
 * Read identity from the newly rendered view, never from cached search metadata. Company headings
 * carry the UIN; business-name headings show no number, so the view's own bootstrap identifier
 * (the registration number CIPA's search accepted) must match the request instead.
 */
export async function readPublicIdentity(page: Page, uin: string): Promise<Pick<SearchItem, 'uin' | 'name' | 'status' | 'entityType'>> {
  const values = await page.evaluate(() => ({
    heading: document.querySelector('h1')?.textContent ?? '',
    status: document.querySelector('.entity-summary-data [data-attribute-name="Status"] .dd.value')?.textContent ?? '',
    entityType: document.querySelector('.entity-summary-data [data-attribute-name="EntityType"] .dd.value')?.textContent ?? '',
    businessIdentifier: (window as any).Catalyst?.businessIdentifier ?? null,
  }));
  const heading = clean(values.heading), suffix = ` (${uin})`, identifier = typeof values.businessIdentifier === 'string' ? values.businessIdentifier : null;
  const mismatch = isBusinessName(uin) ? identifier !== uin || !heading : !heading.endsWith(suffix) || (identifier !== null && identifier !== uin);
  if (mismatch) throw new ApiError('UPSTREAM_IDENTITY_MISMATCH', 'CIPA opened a different entity than requested.');
  const name = heading.endsWith(suffix) ? heading.slice(0, -suffix.length) : heading, status = clean(values.status), displayedType = clean(values.entityType);
  requireShape(name && status && displayedType);
  return { uin, name, status, entityType: HEADER_TYPES[displayedType] ?? displayedType };
}

export async function openHybridView(page: Page, uin: string, match: SearchItem, timeoutMs: number): Promise<string> {
  return loadHybridView(page, uin, await resolvePublicViewLink(page, uin, match, timeoutMs), timeoutMs);
}
