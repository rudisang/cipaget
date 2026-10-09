import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublicViewLinks } from '../src/public-links.js';
import { readPublicIdentity, HybridUnsupported } from '../src/hybrid.js';
import { CipaBrowser } from '../src/browser.js';
import { loadConfig } from '../src/config.js';

const uin = 'BW00000123456', other = 'BW00000123457', third = 'BW00000123458';
const link = 'https://www.cipa.co.bw/companies/ui/start/entityView/81b72c08670bc23f26b8f20046ca9ea7?dom=Company';
test('routing cache accepts only observed public start routes, expires and bounds entries', () => {
  let now = 0;
  const cache = new PublicViewLinks(2, 1000, () => now);
  for (const value of [link.replace('https:', 'http:'), link.replace('www.cipa.co.bw', 'example.org'), link + '&token=secret', link + '#fragment', link.replace('Company', 'Person'), 'https://www.cipa.co.bw/companies/ui/XP-session']) {
    assert.equal(cache.set(uin, value), false);
  }
  assert.equal(cache.set(uin, link), true); cache.set(other, link);
  assert.equal(cache.get(uin), link); cache.set(third, link);
  assert.equal(cache.get(other), undefined, 'least recently used route is evicted');
  now = 1000; assert.equal(cache.get(uin), undefined, 'TTL expires without extending on reads');
  cache.set(uin, link); cache.clear(); assert.equal(cache.get(uin), undefined);
});

test('identity comes from each fresh header, with explicit observed type casing and no invented empty values', async () => {
  const values: Record<string, unknown> = { heading: `Example Limited (${uin})`, status: 'Registered', entityType: 'Public Company' };
  const page = { evaluate: async () => values } as any;
  assert.deepEqual(await readPublicIdentity(page, uin), { uin, name: 'Example Limited', status: 'Registered', entityType: 'Public company' });
  values.heading = `Renamed Limited (${uin})`; values.status = 'Removed';
  assert.equal((await readPublicIdentity(page, uin)).name, 'Renamed Limited');
  assert.equal((await readPublicIdentity(page, uin)).status, 'Removed');
  for (const [displayed, normalized] of [['External Company', 'External company'], ['Close Company', 'Close company'], ['Other Entity', 'Other Entity']]) {
    values.entityType = displayed; assert.equal((await readPublicIdentity(page, uin)).entityType, normalized);
  }
  values.businessIdentifier = uin; assert.equal((await readPublicIdentity(page, uin)).uin, uin);
  values.businessIdentifier = other; await assert.rejects(readPublicIdentity(page, uin), { code: 'UPSTREAM_IDENTITY_MISMATCH' }, 'bootstrap identifier disagrees with the heading');
  values.businessIdentifier = null; values.entityType = ''; await assert.rejects(readPublicIdentity(page, uin), HybridUnsupported);
  values.heading = `Wrong (${other})`; await assert.rejects(readPublicIdentity(page, uin), { code: 'UPSTREAM_IDENTITY_MISMATCH' });
});

test('business-name identity needs the bootstrap registration number because the heading shows none', async () => {
  const number = 'BN2019/11223';
  const values: Record<string, unknown> = { heading: 'Example Hyper ', status: 'Cancelled', entityType: 'Business name', businessIdentifier: number };
  const page = { evaluate: async () => values } as any;
  assert.deepEqual(await readPublicIdentity(page, number), { uin: number, name: 'Example Hyper', status: 'Cancelled', entityType: 'Business name' });
  values.heading = `Example Hyper (${number})`; assert.equal((await readPublicIdentity(page, number)).name, 'Example Hyper');
  values.businessIdentifier = 'BN2016/556363'; await assert.rejects(readPublicIdentity(page, number), { code: 'UPSTREAM_IDENTITY_MISMATCH' });
  values.businessIdentifier = null; await assert.rejects(readPublicIdentity(page, number), { code: 'UPSTREAM_IDENTITY_MISMATCH' }, 'no identifier is not a match');
  values.businessIdentifier = number; values.heading = ''; await assert.rejects(readPublicIdentity(page, number), { code: 'UPSTREAM_IDENTITY_MISMATCH' });
});

test('routing cache keys business names to their own observed start route only', () => {
  const cache = new PublicViewLinks();
  const number = 'BN2019/11223', route = 'https://www.cipa.co.bw/businessnames/ui/start/businessNameView/d25c4d23f680ab36d9717a9a54edcd21?dom=BusinessName';
  assert.equal(cache.set(number, route), true);
  assert.equal(cache.get(number), route);
  assert.equal(cache.set(number, link), false, 'a company route cannot be stored for a business name');
  assert.equal(cache.set(uin, route), false, 'a business-name route cannot be stored for a company');
  assert.equal(cache.set(number, route.replace('BusinessName', 'Company')), false);
  assert.equal(cache.set('BN2019-11223', route), false, 'only the identifier form CIPA accepts is a key');
});

test('cached routing denial evicts the link and stops without search or fallback', async () => {
  const provider = new CipaBrowser(loadConfig({ HYBRID_NAVIGATION: 'true' })) as any;
  provider.publicLinks.set(uin, link);
  provider.searchOn = async () => { assert.fail('Denial must not trigger another search'); };
  const page = { url: () => 'https://www.cipa.co.bw/companies/ui/XP-old', isClosed: () => false,
    evaluate: async () => ({ status: 429, text: '', url: link }) };
  await assert.rejects(provider.openEntity({ page, state: {} }, uin, true), { code: 'UPSTREAM_RATE_LIMITED' });
  assert.equal(provider.publicLinks.get(uin), undefined);
  assert.equal(provider.diagnostics.hybridFallbacks, 0);
  await provider.close();
});

test('hybrid entity renderers remain idle without background registry requests', async () => {
  const provider = new CipaBrowser(loadConfig({ HYBRID_NAVIGATION: 'true' })) as any;
  const session = { page: { isClosed: () => false }, entityReady: true, state: {}, context: { close: async () => {} } };
  provider.idle.push(session); provider.sessions.add(session);
  provider.prepareSearchForm = async () => { assert.fail('No reset for a retained entity renderer'); };
  provider.prepareIdleSessions();
  assert.equal(provider.preparing.size, 0);
  assert.equal(await provider.acquire(), session);
  await provider.close();
});

test('ROUTE_CACHE_TTL_MS sets how long an observed public start link is reused; 0 disables reuse', () => {
  const link = 'https://www.cipa.co.bw/companies/ui/start/entityView/81b72c08670bc23f26b8f20046ca9ea7?dom=Company';
  assert.equal(loadConfig({}).routeCacheTtlMs, 12 * 60 * 60_000);
  assert.throws(() => loadConfig({ ROUTE_CACHE_TTL_MS: '-1' }), /ROUTE_CACHE_TTL_MS/);
  const kept = new CipaBrowser(loadConfig({})) as any;
  assert.equal(kept.publicLinks.set('BW00000123456', link), true);
  assert.equal(kept.publicLinks.get('BW00000123456'), link);
  const disabled = new CipaBrowser(loadConfig({ ROUTE_CACHE_TTL_MS: '0' })) as any;
  disabled.publicLinks.set('BW00000123456', link);
  assert.equal(disabled.publicLinks.get('BW00000123456'), undefined);
});
