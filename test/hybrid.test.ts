import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPublicStatus, HybridUnsupported, parsePublicView, parseSearchView, publicViewUrl, resetHybridSearch, resolvePublicViewLink } from '../src/hybrid.js';
import { CipaBrowser } from '../src/browser.js';
import { loadConfig } from '../src/config.js';
import { ApiError } from '../src/errors.js';

const uin = 'BW00000123456';
function bootstrap(identifier = uin, mode = 'View', code = 'privateCompanyView', appCode = 'companies') {
  const catalyst = { appCode, serviceTransactionId: '123', serviceTransactionUid: '123:Company:View',
    serviceCode: code, businessIdentifier: identifier, identifier: '456', useServiceTransactionId: 'XP-example' };
  return `var viewTree = ${JSON.stringify({ root: 'abc', abc: { id: 'abc', children: ['removed'] }, removed: null })};\n` +
    `serviceVue = initVerne("#serviceTransaction", {serviceIgnored: {}, service:${JSON.stringify({ mode, code })}, layout:"layout"});\n` +
    Object.entries(catalyst).map(([key, value]) => `Catalyst.${key} = ${JSON.stringify(value)};`).join('\n');
}

test('public-view parsing preserves null nodes and reads JSON without executing source scripts', () => {
  const parsed = parsePublicView(bootstrap() + '\nglobalThis.untrustedBootstrapExecuted = true;', uin);
  assert.equal(parsed.graph.removed, null);
  assert.equal(parsed.graph.root, 'abc');
  assert.equal(parsed.catalyst.businessIdentifier, uin);
  assert.equal((globalThis as any).untrustedBootstrapExecuted, undefined);
  assert.throws(() => parsePublicView('var viewTree = invalid;\n', uin), HybridUnsupported);
  assert.throws(() => parsePublicView(bootstrap().replace('"root":"abc"', '"root":"toString"'), uin), HybridUnsupported);
  assert.throws(() => parsePublicView(bootstrap(uin, 'Edit'), uin), HybridUnsupported);
  assert.throws(() => parsePublicView(bootstrap('BW00000999999'), uin), { code: 'UPSTREAM_IDENTITY_MISMATCH' });
});

test('hybrid reads reject non-public redirects and surface denials without fallback errors', () => {
  assert.equal(publicViewUrl('/companies/ui/XP-sample', 'https://www.cipa.co.bw/master/ui/start/search'), 'https://www.cipa.co.bw/companies/ui/XP-sample');
  for (const url of ['https://example.com/companies/ui/x', '/security/ui/logon', 'https://guest@www.cipa.co.bw/companies/ui/x', 'http://www.cipa.co.bw/companies/ui/x']) {
    assert.throws(() => publicViewUrl(url, 'https://www.cipa.co.bw'), { code: 'UPSTREAM_ACCESS_RESTRICTED' });
  }
  assert.doesNotThrow(() => checkPublicStatus(200));
  assert.throws(() => checkPublicStatus(429), { code: 'UPSTREAM_RATE_LIMITED' });
  for (const status of [401, 403]) assert.throws(() => checkPublicStatus(status), { code: 'UPSTREAM_ACCESS_RESTRICTED' });
  assert.throws(() => checkPublicStatus(500), { code: 'UPSTREAM_UNAVAILABLE' });
});

function fallbackFixture(failure: Error, closed = false) {
  const provider = new CipaBrowser(loadConfig({ HYBRID_NAVIGATION: 'true' })) as any;
  const calls: string[] = [];
  // The ordinary path reads identity from the opened header, like the hybrid path.
  const page = { isClosed: () => closed, url: () => 'https://www.cipa.co.bw/companies/ui/example',
    getByRole: (_role: string, options: any) => ({ click: async () => { calls.push(`click:${options.name}`); }, waitFor: async () => {} }),
    evaluate: async () => ({ heading: `Example (${uin})`, status: 'Removed', entityType: 'Private Company', businessIdentifier: uin }) };
  provider.searchOn = async (_session: any, _options: any, hybrid: boolean) => {
    calls.push(hybrid ? 'hybrid' : 'ordinary');
    if (hybrid) throw failure;
    return { items: [{ uin, name: 'Example', status: 'Removed / Cancelled', entityType: 'Private company', register: 'Companies' }] };
  };
  provider.prepareSearchForm = async (_session: any, forceNavigation: boolean) => { assert.equal(forceNavigation, true); calls.push('reset'); };
  provider.settle = async () => {};
  return { provider, session: { page, state: {} } as any, calls };
}

test('an unsupported layout resets once and opens the complete ordinary UI', async () => {
  const f = fallbackFixture(new HybridUnsupported('Changed layout'));
  const result = await f.provider.openEntity(f.session, uin, true);
  assert.deepEqual(result.match, { uin, name: 'Example', status: 'Removed', entityType: 'Private company' }, 'header identity, not the search card');
  assert.deepEqual(f.calls, ['hybrid', 'reset', 'ordinary', `click:Example (${uin})`]);
  assert.deepEqual(f.provider.diagnostics, { transport: 'hybrid', hybridViews: 0, hybridFallbacks: 1, hybridResets: 0, resetFallbacks: 0, publicLinkHits: 0, searchFallbacks: 0 });
  await f.provider.close();
});

test('hybrid failures do not retry denial, identity mismatch, timeout, abort, or not-found', async () => {
  for (const code of ['UPSTREAM_ACCESS_RESTRICTED', 'UPSTREAM_RATE_LIMITED', 'UPSTREAM_IDENTITY_MISMATCH', 'UPSTREAM_TIMEOUT', 'ENTITY_NOT_FOUND']) {
    const f = fallbackFixture(new ApiError(code, code));
    await assert.rejects(f.provider.openEntity(f.session, uin, true), { code });
    assert.deepEqual(f.calls, ['hybrid']); await f.provider.close();
    assert.equal(f.provider.diagnostics.hybridFallbacks, 0);
  }
  const closed = fallbackFixture(new HybridUnsupported('Closed'), true);
  await assert.rejects(closed.provider.openEntity(closed.session, uin, true), HybridUnsupported);
  assert.deepEqual(closed.calls, ['hybrid']); await closed.provider.close();
  const denied = fallbackFixture(new HybridUnsupported('Changed'));
  denied.session.failure = new ApiError('UPSTREAM_ACCESS_RESTRICTED', 'Denied');
  await assert.rejects(denied.provider.openEntity(denied.session, uin, true), { code: 'UPSTREAM_ACCESS_RESTRICTED' });
  assert.deepEqual(denied.calls, ['hybrid']); await denied.provider.close();
});

test('document navigation stays on ordinary UI even with hybrid data enabled', async () => {
  const f = fallbackFixture(new Error('Hybrid must not run'));
  await f.provider.openEntity(f.session, uin);
  assert.deepEqual(f.calls, ['ordinary', `click:Example (${uin})`]); await f.provider.close();
  assert.equal(loadConfig({}).hybridNavigation, false);
});

test('a business name opens from its registration number through the card CIPA returns for it', async () => {
  const number = 'BN2019/11223';
  const open = (items: any[], header: any) => {
    const f = fallbackFixture(new Error('Hybrid must not run'));
    f.provider.searchOn = async (_s: any, options: any) => { f.calls.push(`search:${options.q}`); return { items }; };
    f.session.page.evaluate = async () => header;
    return f;
  };
  const card = { uin: null, name: 'Example Hyper', status: 'Registered', entityType: null, register: 'Business names' };
  const header = { heading: 'Example Hyper ', status: 'Registered', entityType: 'Business name', businessIdentifier: number };
  const f = open([card, { ...card, uin: 'BW00000123456', register: 'Companies' }], header);
  assert.deepEqual((await f.provider.openEntity(f.session, number)).match, { uin: number, name: 'Example Hyper', status: 'Registered', entityType: 'Business name' });
  assert.deepEqual(f.calls, [`search:${number}`, 'click:Example Hyper'], 'the card link carries no number');
  await f.provider.close();
  const none = open([{ ...card, uin: 'BW00000123456', register: 'Companies' }], header);
  await assert.rejects(none.provider.openEntity(none.session, number), { code: 'ENTITY_NOT_FOUND' }); await none.provider.close();
  const several = open([card, { ...card, name: 'Example Hyper Two' }], header);
  await assert.rejects(several.provider.openEntity(several.session, number), { code: 'ENTITY_AMBIGUOUS' });
  assert.deepEqual(several.calls, [`search:${number}`], 'no card is opened when the number is ambiguous'); await several.provider.close();
  const other = open([card], { ...header, businessIdentifier: 'BN2016/556363' });
  await assert.rejects(other.provider.openEntity(other.session, number), { code: 'UPSTREAM_IDENTITY_MISMATCH' }); await other.provider.close();
  const unreadable = open([card], { ...header, entityType: '' });
  await assert.rejects(unreadable.provider.openEntity(unreadable.session, number), { code: 'UPSTREAM_LAYOUT_CHANGED' }); await unreadable.provider.close();
});

test('a public card is bound by its whitespace-normalised label, as CIPA renders it', async () => {
  const match = { uin, name: 'Botswana Ostrich Company', status: 'Removed / Cancelled', entityType: 'External company' } as any;
  const run = (label: string | null, nodetype = 'button') => {
    let evaluations = 0;
    const page = {
      url: () => 'https://www.cipa.co.bw/master/ui/XP-search',
      getByRole: (_role: string, options: any) => ({ getAttribute: async () => options.name === `Botswana Ostrich Company (${uin})` ? 'b4b8ac6568c95b74_btn' : null }),
      evaluate: async () => ++evaluations === 1 ? { button: nodetype === 'button', label, renderer: true } : { status: 200, text: JSON.stringify({ redirect: '/companies/ui/start/entityView/7520c2cac1049a508e4102be527b5c10?dom=Company' }) },
    } as any;
    return resolvePublicViewLink(page, uin, match, 1000);
  };
  const expected = 'https://www.cipa.co.bw/companies/ui/start/entityView/7520c2cac1049a508e4102be527b5c10?dom=Company';
  assert.equal(await run(`Botswana Ostrich Company  (${uin})`), expected, 'double space inside the registered name');
  assert.equal(await run(`Botswana Ostrich Company (${uin})`), expected);
  await assert.rejects(run(`Another Company (${uin})`), HybridUnsupported);
  await assert.rejects(run(null), HybridUnsupported);
  await assert.rejects(run(`Botswana Ostrich Company (${uin})`, 'attribute'), HybridUnsupported);
});

test('business-name views bootstrap under the businessnames app and open through their own start route', () => {
  const number = 'BN2019/11223';
  const html = bootstrap(number, 'View', 'businessNameView', 'businessnames');
  assert.equal(parsePublicView(html, number).catalyst.businessIdentifier, number);
  assert.throws(() => parsePublicView(bootstrap(number), number), HybridUnsupported, 'a companies bootstrap cannot stand in for a business name');
  assert.throws(() => parsePublicView(bootstrap(uin, 'View', 'privateCompanyView', 'businessnames'), uin), HybridUnsupported);
  assert.throws(() => parsePublicView(bootstrap('BN2016/556363', 'View', 'businessNameView', 'businessnames'), number), { code: 'UPSTREAM_IDENTITY_MISMATCH' });
  assert.equal(publicViewUrl('/businessnames/ui/XP-sample', 'https://www.cipa.co.bw/master/ui/start/search'), 'https://www.cipa.co.bw/businessnames/ui/XP-sample');
  assert.throws(() => publicViewUrl('/reservednames/ui/XP-sample', 'https://www.cipa.co.bw'), { code: 'UPSTREAM_ACCESS_RESTRICTED' });
});

test('search bootstrap cannot be substituted for a company view or another service', () => {
  const html = bootstrap('ETY-example', 'Search', 'CIPARegisterSearch', 'master');
  assert.equal(parseSearchView(html).service.code, 'CIPARegisterSearch');
  assert.throws(() => parsePublicView(html, uin), HybridUnsupported);
  assert.throws(() => parseSearchView(bootstrap()), HybridUnsupported);
  assert.throws(() => parseSearchView(bootstrap('ETY-example', 'Search', 'OtherSearch', 'master')), HybridUnsupported);
});

test('persistent reset drains old UI callbacks before applying a fresh empty search view', async () => {
  const events: string[] = [];
  let input = '', evaluations = 0;
  const page = {
    evaluate: async (_fn: any, args: any) => {
      evaluations++;
      if (evaluations === 1) { events.push('supported'); return true; }
      if (evaluations === 2) { events.push('fetch'); return { status: 200, url: 'https://www.cipa.co.bw/master/ui/XP-new', text: bootstrap('ETY-new', 'Search', 'CIPARegisterSearch', 'master') }; }
      events.push('apply'); assert.equal(args.service.code, 'CIPARegisterSearch');
    },
    waitForFunction: async () => { events.push('drain'); },
    getByRole: () => ({ waitFor: async () => {}, inputValue: async () => input, isVisible: async () => false }),
  };
  await resetHybridSearch(page as any, 1000);
  assert.deepEqual(events, ['supported', 'fetch', 'drain', 'apply']);
  evaluations = 0; input = 'Previous company';
  await assert.rejects(resetHybridSearch(page as any, 1000), HybridUnsupported);
});

test('unsupported reset falls back to navigation, while an upstream denial stops before applying a view', async () => {
  const p = new CipaBrowser(loadConfig({ HYBRID_NAVIGATION: 'true' })) as any;
  let navigations = 0;
  const page = { url: () => 'https://www.cipa.co.bw/companies/ui/XP-old', evaluate: async () => false,
    isClosed: () => false, goto: async () => { navigations++; return { status: () => 200 }; }, getByRole: () => ({ waitFor: async () => {} }) };
  p.settle = async () => {};
  const session = { page, state: {} } as any;
  await p.prepareSearchForm(session);
  assert.equal(navigations, 1); assert.equal(session.searchReady, true); assert.equal(p.diagnostics.resetFallbacks, 1);
  let calls = 0;
  const denied = { evaluate: async () => ++calls === 1 ? true : { status: 429, url: page.url(), text: '' } };
  await assert.rejects(resetHybridSearch(denied as any, 1000), { code: 'UPSTREAM_RATE_LIMITED' });
  assert.equal(calls, 2); await p.close();
});

for (const hybrid of [false, true]) test(`public search uses the batched submission only when hybrid navigation is enabled (${hybrid})`, async () => {
  const p = new CipaBrowser(loadConfig({ HYBRID_NAVIGATION: String(hybrid) })) as any;
  const session = { page: { isClosed: () => false }, context: { close: async () => {} }, state: {} };
  p.acquire = async () => session; p.prepareSearchForm = async () => {};
  let seen: boolean | undefined;
  p.searchOn = async (_session: any, options: any, batched: boolean) => { seen = batched; return { items: [], query: options.q }; };
  await p.search({ q: 'Example', page: 1, pageSize: 20 }, new AbortController().signal);
  assert.equal(seen, hybrid);
  await p.close();
});

function searchFixture(options: { supported: boolean; results?: any[]; failure?: ApiError }) {
  const p = new CipaBrowser(loadConfig({ HYBRID_NAVIGATION: 'true' })) as any;
  const calls: string[] = [];
  const results = [...(options.results ?? [])];
  const page = {
    isClosed: () => false,
    getByRole: (_role: string, o: any) => ({
      getAttribute: async () => options.supported ? (o.name === 'Search' ? 'abc123_btn' : 'def456') : null,
      fill: async (value: string) => { calls.push(`fill:${value}`); },
    }),
    evaluate: async () => { calls.push('evaluate'); return results.shift(); },
  };
  p.prepareSearchForm = async (_session: any, force: boolean) => { calls.push(`reset:${force}`); };
  p.remoteClick = async () => { calls.push('click'); };
  return { p, session: { page, state: {}, failure: options.failure } as any, calls };
}

test('a name query is submitted as one batched command set', async () => {
  const f = searchFixture({ supported: true, results: [true, { error: false, hasState: true, redirect: false }] });
  await f.p.submitSearch(f.session, 'Example Company', true);
  assert.deepEqual(f.calls, ['evaluate', 'evaluate']);
  assert.equal(f.p.diagnostics.searchFallbacks, 0);
  await f.p.close();
});

test('an unsupported search form falls back once to the ordinary controls', async () => {
  const f = searchFixture({ supported: false });
  await f.p.submitSearch(f.session, 'Example', true);
  assert.deepEqual(f.calls, ['reset:true', 'fill:Example', 'click']);
  assert.equal(f.p.diagnostics.searchFallbacks, 1);
  await f.p.close();
});

test('search fallback never follows a denial or a server-reported search error', async () => {
  const denied = searchFixture({ supported: false, failure: new ApiError('UPSTREAM_ACCESS_RESTRICTED', 'Denied', 503, false) });
  await assert.rejects(denied.p.submitSearch(denied.session, 'Example', true), { code: 'UPSTREAM_ACCESS_RESTRICTED' });
  assert.deepEqual(denied.calls, []); await denied.p.close();
  const failed = searchFixture({ supported: true, results: [true, { error: true, hasState: false, redirect: false }] });
  await assert.rejects(failed.p.submitSearch(failed.session, 'Example', true), { code: 'UPSTREAM_UNAVAILABLE' });
  assert.deepEqual(failed.calls, ['evaluate', 'evaluate']);
  assert.equal(failed.p.diagnostics.searchFallbacks, 0); await failed.p.close();
});

test('ordinary search never touches the batched path', async () => {
  const f = searchFixture({ supported: true });
  await f.p.submitSearch(f.session, 'Example', false);
  assert.deepEqual(f.calls, ['fill:Example', 'click']);
  await f.p.close();
});

test('concurrent views for one UIN share a single search and route resolution', async () => {
  const p = new CipaBrowser(loadConfig({ HYBRID_NAVIGATION: 'true' })) as any;
  let searches = 0;
  p.searchOn = async () => { searches++; await new Promise(resolve => setTimeout(resolve, 5)); return { items: [{ uin, name: 'Example', status: 'Registered', entityType: 'Private company' }] }; };
  const link = '/companies/ui/start/entityView/81b72c08670bc23f26b8f20046ca9ea7?dom=Company';
  const page = { url: () => 'https://www.cipa.co.bw/master/ui/XP-search', getByRole: () => ({ getAttribute: async () => 'abc123_btn' }),
    evaluate: async (fn: any) => String(fn).includes('nodetype') ? { button: true, label: `Example (${uin})`, renderer: true } : { status: 200, text: JSON.stringify({ redirect: link }) } };
  const session = { page, state: {} };
  const [a, b, c] = await Promise.all([p.resolvePublicLink(session, uin), p.resolvePublicLink(session, uin), p.resolvePublicLink(session, uin)]);
  assert.equal(searches, 1);
  assert.equal(a, 'https://www.cipa.co.bw' + link); assert.equal(b, a); assert.equal(c, a);
  assert.equal(p.pendingLinks.size, 0, 'nothing stays pending after completion');
  await p.resolvePublicLink(session, uin);
  assert.equal(searches, 2, 'a later read without a cached route searches again');
  p.searchOn = async () => { searches++; throw new ApiError('ENTITY_NOT_FOUND', 'Missing', 404); };
  await Promise.all([assert.rejects(p.resolvePublicLink(session, uin), { code: 'ENTITY_NOT_FOUND' }), assert.rejects(p.resolvePublicLink(session, uin), { code: 'ENTITY_NOT_FOUND' })]);
  assert.equal(searches, 3, 'waiting views receive the same failure without searching again');
  await p.close();
});
