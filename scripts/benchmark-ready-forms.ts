// Research only: fresh company reads after preparing empty search forms.
// No company response cache and no company data fetched during preparation.
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { CipaBrowser } from '../src/browser.js';
import { loadConfig } from '../src/config.js';

const label = process.argv[2] ?? 'ready-forms';
const out = `output/performance/${label}`;
await mkdir(out, { recursive: true });
const provider = new CipaBrowser(loadConfig());
const p = provider as any;
if (process.argv.includes('--hybrid-navigation')) {
  const { installHybridNavigation, installBatchedEntitySearch } = await import('./hybrid-navigation-experiment.js');
  installHybridNavigation(p);
  if (process.argv.includes('--batch-search')) installBatchedEntitySearch(p);
}
if (process.argv.includes('--balanced-groups') || process.argv.includes('--balanced-groups-v2')) {
  const original = p.getEntityPart.bind(provider);
  p.getEntityPart = (uin: string, options: any, signal: AbortSignal, excluded: string[] = []) => {
    if (process.argv.includes('--balanced-groups-v2')) {
      if (options.include.includes('all')) return original(uin, options, signal, [...excluded.filter(key => !['shareholders', 'auditors', 'visualisation'].includes(key)), 'addresses']);
      const include = options.include.includes('directors') ? ['addresses', 'directors', 'secretaries']
        : options.include.filter((key: string) => !['auditors', 'visualisation'].includes(key));
      return original(uin, { ...options, include }, signal, excluded);
    }
    const moveToPrimary = ['shareholders', 'visualisation'];
    return original(uin, { ...options, include: options.include.filter((key: string) => !moveToPrimary.includes(key)) }, signal, excluded.filter(key => !moveToPrimary.includes(key)));
  };
}
if (process.argv.includes('--fast-waits') || process.argv.includes('--fast-general')) {
  // Research only: measure the effect of Playwright's increasing waitFor poll intervals.
  const acquire = p.acquire.bind(provider);
  let installed = false;
  p.acquire = async (signal: AbortSignal) => {
    const session = await acquire(signal);
    if (!installed) {
      installed = true;
      const prototype = Object.getPrototypeOf(session.page.locator('body'));
      const original = prototype.waitFor;
      prototype.waitFor = async function (options: any = {}) {
        const state = options.state ?? 'visible';
        // Do not accelerate search heading waits: that heading can precede result-card hydration.
        const selectedHeading = this._selector.includes('role=heading') && (
          process.argv.includes('--fast-waits') && this._selector.includes('role=tabpanel') ||
          process.argv.includes('--fast-general') && this._selector.includes('General Details')
        );
        if (state !== 'visible' || !selectedHeading) return original.call(this, options);
        const deadline = performance.now() + (options.timeout ?? loadConfig().actionTimeoutMs);
        do {
          if (await this.isVisible() === (state === 'visible')) return;
          await new Promise(resolve => setTimeout(resolve, 25));
        } while (performance.now() < deadline);
        return original.call(this, { ...options, timeout: 1 });
      };
    }
    return session;
  };
}
let events: object[] = [], start = 0;
for (const method of ['searchOn', 'openEntity', 'readSection', 'remoteClick']) {
  const original = p[method].bind(provider);
  p[method] = async (...args: any[]) => {
    const at = performance.now();
    const detail = method === 'readSection' ? args[3] : method === 'remoteClick' ? await args[1].innerText() : undefined;
    try { return await original(...args); }
    finally { events.push({ method, detail, at: Math.round(at - start), ms: Math.round(performance.now() - at) }); }
  };
}
const measurements: object[] = [];
try {
  for (let round = 0; round < (process.argv.includes('--one') ? 1 : 2); round++) {
    for (const uin of ['BW00000790718', 'BW00001142508'].slice(0, process.argv.includes('--one') ? 1 : 2)) {
      const prep = performance.now();
      await provider.warmup(AbortSignal.timeout(30000));
      const preparationMs = Math.round(performance.now() - prep);
      events = []; p.hybridTimings = []; start = performance.now();
      const result = await provider.getEntity(uin, { include: ['all'], history: true, filingDetails: false, maxPages: 10 }, AbortSignal.timeout(60000));
      const ms = Math.round(performance.now() - start);
      await writeFile(`${out}/${uin}-${round}.json`, JSON.stringify(result, null, 2));
      await writeFile(`${out}/${uin}-${round}-events.json`, JSON.stringify(events, null, 2));
      if (p.hybridTimings.length) await writeFile(`${out}/${uin}-${round}-navigation.json`, JSON.stringify(p.hybridTimings, null, 2));
      assert.equal(result.complete, true, JSON.stringify(result.warnings));
      const measurement = { uin, round, preparationMs, ms };
      measurements.push(measurement); console.log(measurement);
      await writeFile(`${out}/measurements.json`, JSON.stringify(measurements, null, 2));
    }
  }
} finally { await provider.close(); }
