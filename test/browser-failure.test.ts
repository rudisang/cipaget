import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CipaBrowser } from '../src/browser.js';
import { loadConfig } from '../src/config.js';
import { ApiError } from '../src/errors.js';

const options = { maxPages: 5, history: true, filingDetails: false, include: ['directors'] };
const person = (name: string) => `<div role="listitem" class="cat-repeater-child" aria-label="${name}"><h4>${name}</h4></div>`;

// Exercise the section orchestration without hitting CIPA or launching a browser.
function sectionFixture(env: Record<string, string> = {}) {
  const browser = new CipaBrowser(loadConfig(env)) as any;
  browser.expand = async () => true;
  browser.settle = async () => {};
  return browser;
}

test('a later-page failure retains previously retrieved filing rows and marks them incomplete', async () => {
  const browser = sectionFixture();
  browser.visibleHtml = async () => '<h2>Filings</h2><table><thead><tr><th>Item</th></tr></thead><tbody><tr><td>Annual Return</td></tr></tbody></table>';
  browser.nextPage = () => ({ count: async () => 1 });
  browser.advancePage = async () => { throw new ApiError('UPSTREAM_TIMEOUT', 'Timeout', 504, true); };
  const result = await browser.readSection({}, {}, 'Filings', 'filings', { ...options, maxPages: 2, include: ['filings'] });
  assert.equal(result.complete, false); assert.equal(result.pagesFetched, 1);
  assert.deepEqual(result.tables[0].rows, [['Annual Return']]);
  assert.match(result.warnings[0], /UPSTREAM_TIMEOUT/);
});

test('a page is only read after the pager has advanced, so people on later pages are not dropped', async () => {
  const browser = sectionFixture();
  // Page 1 lists current people plus the first previous people; Next replaces only the nested list.
  const pages = ['<h2>Directors</h2>' + person('Current One') + person('Previous A'), '<h2>Directors</h2>' + person('Current One') + person('Previous B')];
  let current = 0;
  browser.visibleHtml = async () => pages[current];
  browser.nextPage = () => ({ count: async () => (current === 0 ? 1 : 0) });
  browser.advancePage = async () => { current++; };
  const result = await browser.readSection({}, {}, 'Directors', 'directors', options);
  assert.equal(result.complete, true); assert.equal(result.pagesFetched, 2);
  assert.deepEqual(result.records.map((r: any) => r.title), ['Current One', 'Previous A', 'Previous B']);
  assert.deepEqual(result.warnings, []);
});

test('only a page whose content genuinely never changes is reported as repeated', async () => {
  const browser = sectionFixture();
  let advanced = 0;
  browser.visibleHtml = async () => '<h2>Directors</h2>' + person('Only One');
  browser.nextPage = () => ({ count: async () => 1 });
  browser.advancePage = async () => { advanced++; };
  const result = await browser.readSection({}, {}, 'Directors', 'directors', options);
  assert.equal(advanced, 1);
  assert.equal(result.complete, false); assert.equal(result.pagesFetched, 1);
  assert.deepEqual(result.records.map((r: any) => r.title), ['Only One']);
  assert.match(result.warnings[0], /repeated the same content/);
});

function advanceFixture(indicators: Array<string | null>, env: Record<string, string> = {}) {
  const browser = new CipaBrowser(loadConfig(env)) as any;
  const events: string[] = [];
  browser.remoteClick = async () => { events.push('click'); };
  browser.pagerState = async () => { events.push('pager'); return indicators.length > 1 ? indicators.shift()! : indicators[0]; };
  const next = { getAttribute: async () => 'abc123-pageNext' };
  return { browser, events, advance: () => browser.advancePage({ page: {} }, next) };
}

test('advancing waits for the page indicator to change after the click has been answered', async () => {
  const f = advanceFixture(['Page 1 of 2|1', 'Page 1 of 2|1', 'Page 1 of 2|1', 'Page 2 of 2|2']);
  await f.advance();
  assert.deepEqual(f.events, ['pager', 'click', 'pager', 'pager', 'pager']);
  const unknown = advanceFixture([null]);
  await unknown.advance();
  assert.deepEqual(unknown.events, ['pager', 'click']);
  await f.browser.close(); await unknown.browser.close();
});

test('an indicator that never changes is bounded by the action timeout and leaves the decision to the content comparison', async () => {
  const f = advanceFixture(['Page 1 of 2|1'], { ACTION_TIMEOUT_MS: '1000' });
  const started = performance.now();
  await f.advance();
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 900 && elapsed < 2500, `waited ${elapsed}ms`);
  assert.equal(f.events[1], 'click');
  await f.browser.close();
});
