// Research only: cache observed public navigation links, never company response data.
import assert from 'node:assert/strict';
import { resolvePublicViewLink, loadHybridView } from '../src/hybrid.js';
import { clean } from '../src/parser.js';
export function installDirectLinks(provider: any) {
  const links = new Map<string, string>(), getEntity = provider.getEntity.bind(provider);
  provider.prepareIdleSessions = () => {}; // Retain each page's loaded renderer for the next fresh view.
  provider.getEntity = async (uin: string, options: any, signal: AbortSignal) => {
    if (!links.has(uin)) await provider.withSession(signal, async (session: any) => {
      const search = await provider.searchOn(session, { q: uin, page: 1, pageSize: 20 }, true);
      const match = search.items.find((item: any) => item.uin === uin); assert.ok(match);
      const link = await resolvePublicViewLink(session.page, uin, match, 20000);
      const url = new URL(link);
      assert.match(url.pathname, /^\/companies\/ui\/start\/entityView\/[a-f\d]{32}$/);
      assert.equal(url.searchParams.get('dom'), 'Company');
      links.set(uin, link);
    });
    return getEntity(uin, options, signal);
  };
  provider.openEntity = async (session: any, uin: string) => {
    const { page } = session;
    if (!page.url().startsWith('https://www.cipa.co.bw/')) await provider.prepareSearchForm(session);
    const url = await loadHybridView(page, uin, links.get(uin)!, 20000);
    session.state = {};
    await page.getByRole('heading', { name: 'General Details', exact: true }).waitFor();
    await provider.settle(session);
    const heading = clean(await page.getByRole('heading', { level: 1 }).first().innerText());
    assert.ok(heading.endsWith(` (${uin})`));
    const name = heading.slice(0, -(` (${uin})`.length));
    const status = clean(await page.locator('.entity-summary-data [data-attribute-name="Status"] .dd.value').first().innerText());
    const entityType = clean(await page.locator('.entity-summary-data [data-attribute-name="EntityType"] .dd.value').first().innerText());
    assert.ok(name && status && entityType);
    return { url, match: { uin, name, status, entityType, register: null, registeredOn: null, address: null, previousAddresses: [], fields: [], text: '' } };
  };
}
