import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CipaBrowser } from '../src/browser.js';
import { loadConfig } from '../src/config.js';
import { ApiError } from '../src/errors.js';

function fixture(prewarm = true) {
  const browser = new CipaBrowser(loadConfig({ BROWSER_PREWARM: String(prewarm) })) as any;
  let closed = false;
  const session = { page: { isClosed: () => closed }, context: { close: async () => { closed = true; } }, state: {} };
  browser.idle.push(session); browser.sessions.add(session);
  let ready!: () => void, fail!: (error: Error) => void;
  browser.prepareSearchForm = () => new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; });
  return { browser, session, ready: () => ready(), fail: (error = new Error('Reset failed')) => fail(error), closed: () => closed };
}

test('a new lookup waits for a resetting context and cancellation does not consume it', async () => {
  const f = fixture();
  f.browser.prepareIdleSessions();
  assert.equal(f.browser.idle.length, 0);
  assert.equal(f.browser.preparing.size, 1);
  const controller = new AbortController();
  const waiting = f.browser.acquire(controller.signal);
  const reason = new Error('Caller stopped waiting'); controller.abort(reason);
  await assert.rejects(waiting, error => error === reason);
  assert.equal(f.closed(), false);
  const next = f.browser.acquire();
  f.ready();
  assert.equal(await next, f.session);
  assert.equal(f.browser.preparing.size, 0);
  assert.equal(f.browser.sessions.size, 1);
  await f.browser.close();
});

test('failed preparation discards the context without an unhandled rejection', async () => {
  const f = fixture(); f.browser.prepareIdleSessions();
  const pending = [...f.browser.preparing]; f.fail();
  await Promise.all(pending);
  assert.equal(f.browser.idle.length, 0);
  assert.equal(f.browser.sessions.size, 0);
  assert.equal(f.closed(), true);
  await f.browser.close();
});

test('shutdown drains preparation and prevents returning a closed context to the pool', async () => {
  const f = fixture(); f.browser.prepareIdleSessions();
  const closing = f.browser.close(); f.ready(); await closing;
  assert.equal(f.browser.idle.length, 0);
  assert.equal(f.browser.preparing.size, 0);
  assert.equal(f.closed(), true);
});

test('upstream denial during a reset reaches the next lookup for client cooldown', async () => {
  const f = fixture(); f.browser.prepareIdleSessions();
  const pending = [...f.browser.preparing];
  (f.session as any).failure = new ApiError('UPSTREAM_RATE_LIMITED', 'Rate limited', 503, true);
  f.fail(); await Promise.all(pending);
  await assert.rejects(f.browser.acquire(), { code: 'UPSTREAM_RATE_LIMITED' });
  assert.equal(f.browser.preparationFailure, undefined);
  await f.browser.close();
});

test('BROWSER_PREWARM=false also disables preparation between requests', async () => {
  const f = fixture(false); f.browser.prepareIdleSessions();
  assert.equal(f.browser.idle.length, 1);
  assert.equal(f.browser.preparing.size, 0);
  assert.equal(await f.browser.acquire(), f.session);
  await f.browser.close();
});

test('an untouched empty search context is not reset again after another worker finishes', async () => {
  const f = fixture(); (f.session as any).searchReady = true;
  f.browser.prepareIdleSessions();
  assert.equal(f.browser.preparing.size, 0);
  assert.equal(await f.browser.acquire(), f.session);
  await f.browser.close();
});

test('a denial thrown by reset reaches the next lookup even without a page-response flag', async () => {
  const f = fixture(); f.browser.prepareIdleSessions(); const pending = [...f.browser.preparing];
  f.fail(new ApiError('UPSTREAM_ACCESS_RESTRICTED', 'Denied', 503, false)); await Promise.all(pending);
  await assert.rejects(f.browser.acquire(), { code: 'UPSTREAM_ACCESS_RESTRICTED' });
  await f.browser.close();
});
