import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Request } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from './config.js';
import { ApiError, upstreamError } from './errors.js';
import { readDocument, unavailableDocument } from './documents.js';
import { checkPublicStatus, HybridUnsupported, loadHybridView, readPublicIdentity, resolvePublicViewLink, resetHybridSearch, submitHybridSearch } from './hybrid.js';
import { PublicViewLinks } from './public-links.js';
import { commandsOf, expectedClickCommand, matchesClick } from './ui-commands.js';
import { cardLabel, headingIdentifies, isBusinessName, isBusinessNameRegister } from './identifiers.js';
import type { RegistryDocument, DocumentKind, DocumentsResult, SearchItem } from './types.js';
import { clean, fieldKey, mergeSection, parseSearch, parseSection, parseOwnershipStatements, deduplicateSearch } from './parser.js';
import { ENTRY_URL, SECTION_LABELS, sectionKeyFor, type EntityOptions, type EntityResult, type RegistryProvider, type SearchOptions, type SearchResult, type Section } from './types.js';

type Session = { context: BrowserContext; page: Page; state: Record<string, any>; failure?: ApiError; searchReady?: boolean; entityReady?: boolean; widgetsReady?: boolean };
const unavailable = (label: string): Section => ({ label, status: 'unavailable', fields: [], records: [], tables: [], text: '', pagesFetched: 0, total: null, complete: true, warnings: [] });
/** Detail tabs in CIPA's own order, then its top-level tabs, then any requested-but-absent keys, whichever view read them first. */
function inTabOrder(sections: Record<string, Section>, available: Array<{ key: string }>): Record<string, Section> {
  const tabs = available.map(section => section.key);
  const keys = [...new Set([...tabs.filter(key => !TOP_LEVEL_SECTIONS.includes(key)), ...tabs, ...Object.keys(sections)])];
  return Object.fromEntries(keys.filter(key => key in sections).map(key => [key, sections[key]]));
}
const isUiPost = (url: string) => url.includes('cipa.co.bw/') && url.includes('/ui/');
// After a page response has been applied, how long the renderer may take to show the new page indicator.
const PAGE_CHANGE_GRACE_MS = 3000;
// Top-level tabs replace the Company Details subtab strip, so a view that has opened one cannot read subtabs without another round trip.
const TOP_LEVEL_SECTIONS = ['filings', 'visualisation'];
// Observed per-tab cost, heaviest first (filings: lazy list, page-size change and pagination; directors: pagination).
const SECTION_PRIORITY = ['filings', 'directors', 'shareholders', 'addresses', 'secretaries', 'shareAllocations', 'beneficialOwners', 'auditors', 'visualisation'];
// Public widget modules that company views import lazily on first use (static assets; no company data).
const ENTITY_WIDGET_MODULES = ['mjs/glue-search-results.js', 'mjs/glue-card.js', 'mjs/glue-tabs.js', 'mjs/glue-tab-panel.js', 'mjs/glue-alerts.js', 'mjs/glue-entity-heading.js', 'cjs/glue-menu.js', 'mjs/glue-menu-buttons.js',
  'mjs/glue-visualiser-button.js', 'mjs/glue-badge.js', 'mjs/glue-sub.js', 'mjs/glue-pillbox.js', 'mjs/glue-completed-filing-history.js', 'mjs/glue-completed-filing-history-list.js',
  'rjs/gluemodal_v2.js', 'mjs/glue-modal-panel.js', 'rjs/gluemodalpanel.js'];

/** Shared queue of section keys for one entity read. Branches take the heaviest remaining subtab; top-level tabs go last. */
class SectionPool {
  private queue: string[] = [];
  private seeded = false;
  constructor(private requested: string[] | null, private known: string[]) {}
  seed(available: string[]) {
    if (this.seeded) return;
    this.seeded = true;
    const wanted = available.filter(key => !this.requested || this.requested.includes(key));
    const rank = (key: string) => { const index = SECTION_PRIORITY.indexOf(key); return index === -1 ? SECTION_PRIORITY.length : index; };
    this.queue = [...new Set(wanted)].sort((a, b) => rank(a) - rank(b));
  }
  /**
   * A fresh view reads the preselected `general` without a click and then starts the longest job (`filings`).
   * Other views take the heaviest remaining subtab; a view on a top-level tab only takes top-level tabs.
   * Unfamiliar tabs stay with the primary discovery pass.
   */
  take(state: { clicked: boolean; topLevel: boolean }, primary: boolean): string | undefined {
    const eligible = (key: string) => (primary || this.known.includes(key)) && (!state.topLevel || TOP_LEVEL_SECTIONS.includes(key));
    const pick = (key: string | undefined) => { if (key !== undefined) this.queue.splice(this.queue.indexOf(key), 1); return key; };
    if (!state.clicked) {
      if (this.queue.includes('general')) return pick('general');
      if (this.queue.includes('filings') && eligible('filings')) return pick('filings');
    }
    return pick(this.queue.find(key => eligible(key) && !TOP_LEVEL_SECTIONS.includes(key)) ?? this.queue.find(eligible));
  }
}

/** Public read-only workflow with optional same-session hybrid navigation. No login or payments. */
export class CipaBrowser implements RegistryProvider {
  private browser?: Promise<Browser>;
  private idle: Session[] = [];
  private preparing = new Set<Promise<void>>();
  private preparationFailure?: ApiError;
  private sessions = new Set<Session>();
  private closed = false;
  private hybridViews = 0;
  private hybridFallbacks = 0;
  private hybridResets = 0;
  private resetFallbacks = 0;
  private publicLinks: PublicViewLinks;
  private pendingLinks = new Map<string, Promise<string>>();
  private publicLinkHits = 0;
  private searchFallbacks = 0;
  // Observed public start links only; each reuse still fetches a fresh view and verifies its identity.
  constructor(private config: Config) { this.publicLinks = new PublicViewLinks(2000, config.routeCacheTtlMs); }
  get diagnostics() { return { transport: this.config.hybridNavigation ? 'hybrid' as const : 'browser' as const, hybridViews: this.hybridViews, hybridFallbacks: this.hybridFallbacks, hybridResets:this.hybridResets, resetFallbacks:this.resetFallbacks, publicLinkHits:this.publicLinkHits, searchFallbacks:this.searchFallbacks }; }

  private async acquire(signal?: AbortSignal): Promise<Session> {
    signal?.throwIfAborted();
    if (this.closed) throw new ApiError('SHUTTING_DOWN', 'The browser service is shutting down.', 503);
    if (this.preparationFailure) {
      const failure = this.preparationFailure; this.preparationFailure = undefined;
      throw failure; // Let CipaClient apply the same cooldown as a foreground denial.
    }
    const idle = this.idle.pop();
    if (idle && !idle.page.isClosed()) { idle.failure = undefined; return idle; }
    if(idle)this.sessions.delete(idle);
    // Reuse a browser being reset rather than allocating an extra context. An immediate
    // next request includes this wait in its latency; preparation is not a result cache.
    if (this.preparing.size) {
      let abort: (() => void) | undefined;
      try {
        await Promise.race([Promise.race(this.preparing), new Promise<never>((_, reject) => {
          abort = () => reject(signal?.reason);
          signal?.addEventListener('abort', abort, { once: true });
        })]);
      } finally { if (abort) signal?.removeEventListener('abort', abort); }
      return this.acquire(signal);
    }
    this.browser ??= chromium.launch({ channel: this.config.channel, headless: this.config.headless, timeout: this.config.actionTimeoutMs }).catch(error => { this.browser = undefined; throw error; });
    const browser = await this.browser;
    if (!browser.isConnected()) { this.browser = undefined; return this.acquire(signal); }
    const context = await browser.newContext({ locale: 'en-GB', viewport: { width: 1440, height: 1000 }, acceptDownloads: true, reducedMotion: 'reduce' });
    // Routing disables Chromium's HTTP cache. Let it reuse CIPA's versioned JS/CSS.
    // Remove cosmetic motion only; data loading and visibility checks stay intact.
    await context.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style');
        style.textContent = '*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;scroll-behavior:auto!important}';
        document.head.appendChild(style);
      }, { once: true });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(this.config.actionTimeoutMs);
    page.setDefaultNavigationTimeout(this.config.actionTimeoutMs);
    const session: Session = { context, page, state: {} };
    this.sessions.add(session);
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) { session.state = {}; session.widgetsReady = false; } });
    page.on('response', async response => {
      if (!response.url().startsWith('https://www.cipa.co.bw/') || !['document','xhr','fetch'].includes(response.request().resourceType())) return;
      if (response.status() === 429) session.failure = new ApiError('UPSTREAM_RATE_LIMITED', 'CIPA has rate-limited this session. Retry later.', 503, true);
      if (response.status() === 403) session.failure = new ApiError('UPSTREAM_ACCESS_RESTRICTED', 'CIPA denied access to this session.', 503, false);
      if (response.request().method() !== 'POST') return;
      try {
        const data = await response.json();
        if (data.state && typeof data.state === 'object') Object.assign(session.state, data.state);
      } catch { /* HTML navigation and non-JSON responses have no field enrichment. */ }
    });
    return session;
  }

  private async withSession<T>(signal: AbortSignal, work: (session: Session) => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    const session = await this.acquire(signal);
    let healthy = false;
    const abort = () => { void session.context.close().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      const value = await work(session);
      if (session.failure) throw session.failure;
      signal.throwIfAborted();
      healthy = true;
      return value;
    } catch (error) { throw signal.aborted ? signal.reason : session.failure ?? upstreamError(error); }
    finally {
      signal.removeEventListener('abort', abort);
      if (healthy && !this.closed && !session.page.isClosed()) this.idle.push(session);
      else { this.sessions.delete(session); await session.context.close().catch(() => {}); }
    }
  }

  private prepareIdleSessions(): void {
    if (this.closed || !this.config.prewarm) return;
    for (const session of this.idle.splice(0)) {
      if ((session.searchReady || this.config.hybridNavigation && session.entityReady) && !session.page.isClosed()) { this.idle.push(session); continue; }
      const task = (async () => {
        try {
          await this.prepareSearchForm(session);
          if (!this.closed && !session.page.isClosed()) { this.idle.push(session); return; }
        } catch (error) {
          // Do not hide an upstream denial just because it arrived during a reset.
          // Report it on the next lookup without changing a response already returned.
          if (session.failure) this.preparationFailure = session.failure;
          else if (error instanceof ApiError && ['UPSTREAM_RATE_LIMITED','UPSTREAM_ACCESS_RESTRICTED'].includes(error.code)) this.preparationFailure = error;
        }
        this.sessions.delete(session);
        await session.context.close().catch(() => {});
      })().finally(() => this.preparing.delete(task));
      this.preparing.add(task);
    }
  }

  private async prepareSearchForm(session: Session, forceNavigation = false) {
    session.searchReady = false;
    session.entityReady = false;
    if (this.config.hybridNavigation && !forceNavigation && session.page.url().startsWith('https://www.cipa.co.bw/')) {
      try {
        await resetHybridSearch(session.page, this.config.actionTimeoutMs);
        session.state = {};
        await this.settle(session);
        session.searchReady = true; this.hybridResets++;
        await this.preloadWidgets(session);
        return;
      } catch (error) {
        if (session.failure) throw session.failure;
        if (!(error instanceof HybridUnsupported) || session.page.isClosed()) throw error;
        this.resetFallbacks++;
      }
    }
    const response = await session.page.goto(ENTRY_URL, { waitUntil: 'domcontentloaded' });
    if (response && response.status() >= 400) checkPublicStatus(response.status());
    await session.page.getByRole('textbox', { name: 'Name or number', exact: true }).waitFor();
    await this.settle(session);
    session.searchReady = true;
    await this.preloadWidgets(session);
  }

  /**
   * Company views import their widget modules lazily on first use, one dependency level per server round trip
   * (about 0.2 s each). Import those public static modules once per browser context while it is idle so the first
   * company read in a context does not pay for them. No company data is requested; failures are ignored.
   */
  private async preloadWidgets(session: Session) {
    if (session.widgetsReady || session.page.isClosed()) return;
    session.widgetsReady = true;
    try {
      await session.page.evaluate(async modules => {
        const version = (window as any).fingerPrintVersion;
        if (typeof version !== 'string' || !document.querySelector('script[type="importmap"]')) return;
        await Promise.race([
          Promise.all(modules.map(name => import(/* @vite-ignore */ `${name}?${version}`).catch(() => undefined))),
          new Promise(resolve => setTimeout(resolve, 15000)),
        ]);
      }, ENTITY_WIDGET_MODULES);
    } catch { /* Optional warm-up only; the view still imports modules on demand. */ }
  }

  private async settle(session: Session, root: Locator = session.page.getByRole('main')) {
    if (session.failure) throw session.failure;
    // Vue renders tab headings before lazy field components. Network-idle alone misses this.
    // One browser turn: two frames, then until no visible loading placeholder remains under root, then one more frame.
    await root.evaluate(async (element, timeoutMs) => {
      const deadline = performance.now() + timeoutMs;
      for (let frame = 0; frame < 2; frame++) await new Promise(next => requestAnimationFrame(() => next(undefined)));
      while ([...element.querySelectorAll('.cat-loading-component')].some(node => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden';
      })) {
        if (performance.now() > deadline) throw new Error('Timed out waiting for CIPA loading placeholders to finish.');
        await new Promise(next => requestAnimationFrame(() => next(undefined)));
      }
      await new Promise(next => requestAnimationFrame(() => next(undefined)));
    }, this.config.actionTimeoutMs);
    if (session.failure) throw session.failure;
  }

  private async remoteClick(session: Session, locator: Locator) {
    if (session.failure) throw session.failure;
    const { page } = session;
    const control = await locator.evaluate(element => ({ id: element.id || null, role: element.getAttribute('role') }));
    const expectation = expectedClickCommand(control);
    // Only a command issued after this point can belong to this click. A notification already in
    // flight (scroll, blur, a list's disclosure state) shares the pager's node id and must not
    // satisfy the waiter, or the panel is read before CIPA has answered the click at all.
    const issued = new WeakSet<Request>();
    const onRequest = (request: Request) => { if (request.method() === 'POST' && isUiPost(request.url())) issued.add(request); };
    page.on('request', onRequest);
    const responsePromise = page.waitForResponse(response => issued.has(response.request()) && matchesClick(commandsOf(response.request().postData()), expectation));
    try {
      // Attach rejection handler before clicking; a failed click must not leak an unhandled waiter.
      await Promise.all([responsePromise.then(response => response.finished()), locator.click()]);
    } finally { page.off('request', onRequest); }
    await this.drainCommands(session);
    await this.settle(session);
  }

  /** CIPA serialises UI commands through a client queue; empty means the click's command and anything queued behind it were applied. */
  private async drainCommands(session: Session) {
    await session.page.waitForFunction(() => {
      const queue = (window as any).Catalyst?.queue;
      return !queue || typeof queue.empty !== 'function' || queue.empty() === true;
    }, null, { timeout: this.config.actionTimeoutMs });
  }

  /** The page indicator of the pager owning a control, read by the control's stable id rather than a locator that may now match another list. */
  private async pagerState(page: Page, controlId: string | null): Promise<string | null> {
    if (!controlId) return null;
    return page.evaluate(id => {
      const pager = document.getElementById(id)?.closest('.cat-pagination');
      if (!pager) return null;
      const label = pager.querySelector('.pagination-page-items[aria-label]')?.getAttribute('aria-label') ?? '';
      const input = pager.querySelector<HTMLInputElement>('input[id$="-pageSelect"]')?.value ?? '';
      return label || input ? `${label}|${input}` : null;
    }, controlId);
  }

  /** Click Next Page and wait until the pager actually reports another page before the caller reads it. */
  private async advancePage(session: Session, next: Locator) {
    const controlId = await next.getAttribute('id');
    const before = await this.pagerState(session.page, controlId);
    await this.remoteClick(session, next);
    if (before === null) return;
    // The response is applied and the queue drained; allow the renderer a bounded grace period.
    // If the indicator still never moves, the caller's content comparison decides whether CIPA genuinely repeated the page.
    const deadline = Date.now() + Math.min(this.config.actionTimeoutMs, PAGE_CHANGE_GRACE_MS);
    while (await this.pagerState(session.page, controlId) === before) {
      if (session.failure) throw session.failure;
      if (Date.now() >= deadline) return;
      await delay(50);
    }
  }

  private async visibleHtml(root: Locator): Promise<string> {
    return root.evaluate(element => {
      const copy = element.cloneNode(true) as Element;
      const originals = [element, ...element.querySelectorAll('*')];
      const clones = [copy, ...copy.querySelectorAll('*')];
      originals.forEach((original, index) => {
        const style = getComputedStyle(original);
        if (style.display === 'none' || style.visibility === 'hidden' || original.getAttribute('aria-hidden') === 'true') clones[index].remove();
      });
      return copy.outerHTML;
    });
  }

  private async searchOn(session: Session, options: SearchOptions, hybrid = false): Promise<SearchResult> {
    const { page } = session;
    session.searchReady = false;
    session.entityReady = false;
    session.state = {};
    if (!page.url().includes('/master/ui/') || !await page.getByRole('textbox', { name: 'Name or number', exact: true }).isVisible()) {
      await this.prepareSearchForm(session);
    }
    const input = page.getByRole('textbox', { name: 'Name or number', exact: true });
    await input.waitFor();
    await this.settle(session);
    await this.submitSearch(session, options.q, hybrid);
    await page.getByRole('heading', { name: 'Search Results', exact: true }).waitFor();
    // The heading can mount before result widgets, even with no loading placeholder yet.
    await page.getByRole('main').locator('.search-result a.searchView').or(
      page.getByRole('main').getByText(/Your search returned no results|No results found using the given search criteria/i),
    ).first().waitFor();
    await this.settle(session);
    // The public search supports 20/50/100/200. Expose bounded choices up to 100.
    await this.setPageSize(session, page.getByRole('main'), options.pageSize);
    // CIPA's mixed company/business-name search can overlap source pages. Build logical
    // pages from unique records, not from the misleading source page number.
    const target = options.page * options.pageSize, offset = target - options.pageSize;
    let items: SearchResult['items'] = [], sourcePagesFetched = 0, hasMore = false, total: number | null = null, duplicates = 0;
    const seenPages = new Set<string>();
    while (sourcePagesFetched < 20) {
      const parsed = parseSearch(await this.visibleHtml(page.getByRole('main')));
      const signature = JSON.stringify(parsed.items);
      if (seenPages.has(signature)) throw new ApiError('UPSTREAM_PAGINATION_STALLED', 'CIPA repeated a search page instead of advancing.');
      seenPages.add(signature); sourcePagesFetched++;
      const combined = [...items, ...parsed.items], unique = deduplicateSearch(combined);
      duplicates += combined.length - unique.length; items = unique; total = parsed.total;
      const next = this.nextPage(page.getByRole('main'));
      hasMore = await next.count() > 0;
      if (items.length >= target || !hasMore) break;
      if (sourcePagesFetched === 20) throw new ApiError('SEARCH_PAGE_LIMIT', 'The requested logical page requires more than 20 source pages. Use a narrower search.', 400);
      await this.advancePage(session, next);
    }
    if (options.page > 1 && items.length <= offset) throw new ApiError('PAGE_OUT_OF_RANGE', 'The requested search page does not exist.', 400);
    return { items: items.slice(offset,target), hasMore:items.length > target || hasMore, total:duplicates ? null : total,
      sourcePagesFetched,warnings:duplicates ? [`Deduplicated ${duplicates} repeated result(s) across CIPA source pages.`] : [],
      query: options.q, page: options.page, pageSize: options.pageSize, retrievedAt: new Date().toISOString(), source: ENTRY_URL };
  }

  /** One batched command set in hybrid mode; otherwise the ordinary field and Search button. */
  private async submitSearch(session: Session, q: string, hybrid: boolean) {
    const { page } = session;
    if (hybrid) {
      try { await submitHybridSearch(page, q); return; }
      catch (error) {
        if (session.failure) throw session.failure;
        if (!(error instanceof HybridUnsupported) || page.isClosed()) throw error;
        this.searchFallbacks++;
        // The form shape changed: start a fresh ordinary view once. Denials and server errors are never retried.
        await this.prepareSearchForm(session, true);
      }
    }
    await page.getByRole('textbox', { name: 'Name or number', exact: true }).fill(q);
    await this.remoteClick(session, page.getByRole('button', { name: 'Search', exact: true }));
  }

  private nextPage(root: Locator) { return root.locator('[aria-label="Next Page"]:visible:not([disabled]):not([aria-disabled="true"])').first(); }

  private async setPageSize(session: Session, root: Locator, size: number) {
    const control = root.getByRole('button', { name: /^Results per page / }).first();
    if (!await control.count()) return;
    if ((await control.innerText()).trim() === String(size)) return;
    await control.click();
    // The menu mounts asynchronously. Do not mistake a not-yet-mounted option for an unsupported size.
    const option = session.page.getByRole('menuitem', { name: String(size), exact: true }).first();
    await option.waitFor();
    await this.remoteClick(session, option);
    await root.getByRole('button', { name: `Results per page ${size}`, exact:true }).first().waitFor();
  }

  search(options: SearchOptions, signal: AbortSignal) {
    return this.withSession(signal, session => this.searchOn(session, options, this.config.hybridNavigation)).finally(() => this.prepareIdleSessions());
  }

  warmup(signal: AbortSignal): Promise<void> {
    const count=Math.max(this.config.concurrency,this.detailWorkers);
    return Promise.all(Array.from({length:count},()=>this.withSession(signal, async session => {
      await this.prepareSearchForm(session);
    }))).then(()=>{});
  }

  getEntity(uin: string, options: EntityOptions, signal: AbortSignal): Promise<EntityResult> {
    // A business name has only four small tabs; one view keeps the registry load modest.
    const result = isBusinessName(uin) || this.detailWorkers===1 || (!options.include.includes('all') && options.include.length<=2)
      ? this.getEntityPart(uin,options,signal) : this.getEntityConcurrent(uin,options,signal);
    return result.finally(() => this.prepareIdleSessions());
  }

  private get detailWorkers() { return Math.min(this.config.detailConcurrency,Math.max(1,Math.floor(4/this.config.concurrency))); }

  private async getEntityConcurrent(uin:string,options:EntityOptions,signal:AbortSignal):Promise<EntityResult> {
    const all=options.include.includes('all');
    // Views share one queue of sections and take the heaviest remaining tab as they become free, instead of
    // a fixed tab-to-view assignment whose longest group bounded every read. The known-key list keeps
    // unfamiliar tabs in the primary discovery pass.
    const pool=new SectionPool(all?null:options.include,Object.keys(SECTION_LABELS));
    const workers=all?this.detailWorkers:Math.min(this.detailWorkers,options.include.length);
    const abort=new AbortController(),combined=AbortSignal.any([signal,abort.signal]);
    let failure:unknown;
    const settled=await Promise.allSettled(Array.from({length:workers},async(_,index)=>{
      try{return await this.getEntityPart(uin,options,combined,[],{pool,primary:index===0});}
      catch(error){failure??=error;abort.abort(error);throw error;}
    }));
    if(failure)throw failure;
    const results=settled.map(result=>(result as PromiseFulfilledResult<EntityResult>).value),primary=results[0];
    if(results.some(result=>result.uin!==primary.uin||result.name!==primary.name||result.status!==primary.status||result.entityType!==primary.entityType))throw new ApiError('UPSTREAM_IDENTITY_MISMATCH','Concurrent CIPA views returned inconsistent entity details.',502,true);
    const read:Record<string,Section>={};
    for(const result of results)for(const [key,section]of Object.entries(result.sections)){
      if(!all||primary.availableSections.some(item=>item.key===key))read[key]=section;
    }
    // An unfamiliar section stays with the primary discovery pass; no tab is silently dropped.
    // Views take tabs as they become free, so the response order is fixed here rather than by arrival.
    const sections=inTabOrder(read,primary.availableSections);
    const warnings=Object.values(sections).filter(s=>!s.complete).map(s=>`${s.label}: incomplete; see section warnings.`);
    return {...primary,sections,complete:Object.values(sections).every(s=>s.complete),warnings,retrievedAt:new Date().toISOString()};
  }

  /**
   * Pick the search card for an identifier that CIPA's own search accepted. Company cards carry the
   * UIN. Business-name cards show no number, so a number search is expected to yield exactly one
   * business-name card; the opened view's own identifier is verified afterwards.
   */
  private findMatch(items: SearchItem[], uin: string): SearchItem {
    if (!isBusinessName(uin)) {
      const match = items.find(item => item.uin === uin);
      if (!match) throw new ApiError('ENTITY_NOT_FOUND', 'No public entity with this UIN was returned by CIPA.', 404);
      return match;
    }
    const candidates = items.filter(item => item.uin === null && isBusinessNameRegister(item.register));
    if (!candidates.length) throw new ApiError('ENTITY_NOT_FOUND', 'No public business name with this registration number was returned by CIPA.', 404);
    if (candidates.length > 1) throw new ApiError('ENTITY_AMBIGUOUS', 'CIPA returned several business-name results for this registration number; refine with /v1/search.', 409);
    return candidates[0];
  }

  private async openEntity(session:Session,uin:string,hybrid=false):Promise<{match:Pick<SearchItem,'uin'|'name'|'status'|'entityType'>;url:string}> {
    const {page}=session;
    // Company views title-case this heading; business-name views use "General details".
    const generalHeading = () => page.getByRole('heading', { name: /^general details$/i });
    if (hybrid && this.config.hybridNavigation) {
      try {
        let link = this.publicLinks.get(uin);
        if (link) {
          if (!page.url().startsWith('https://www.cipa.co.bw/')) await this.prepareSearchForm(session);
          this.publicLinkHits++;
        } else {
          link = await this.resolvePublicLink(session, uin);
          // A sibling view may have received the link without loading the public site itself.
          if (!page.url().startsWith('https://www.cipa.co.bw/')) await this.prepareSearchForm(session);
        }
        const url = await loadHybridView(page, uin, link, this.config.actionTimeoutMs);
        session.state = {};
        await generalHeading().waitFor();
        await this.settle(session);
        const match = await readPublicIdentity(page, uin);
        this.publicLinks.set(uin, link);
        session.searchReady = false; session.entityReady = true;
        this.hybridViews++;
        return { match, url };
      } catch (error) {
        this.publicLinks.delete(uin);
        session.entityReady = false;
        if (session.failure) throw session.failure;
        if (!(error instanceof HybridUnsupported) || page.isClosed()) throw error;
        this.hybridFallbacks++;
        // Start a fresh ordinary UI view once. Never retry denial, timeout, or identity errors.
        await this.prepareSearchForm(session, true);
      }
    }
    const search=await this.searchOn(session,{q:uin,page:1,pageSize:20});
    const match=this.findMatch(search.items,uin);
    await page.getByRole('link',{name:cardLabel(match.name,uin),exact:true}).click();
    await generalHeading().waitFor();
    await this.settle(session);
    // Identity, status and type come from the opened header in both transports, so a removed
    // company reads "Removed" here as it does in hybrid mode rather than the card's "Removed / Cancelled".
    try { return { match: await readPublicIdentity(page, uin), url: page.url() }; }
    catch (error) {
      if (error instanceof HybridUnsupported) throw new ApiError('UPSTREAM_LAYOUT_CHANGED', 'The opened CIPA entity header could not be read.');
      throw error;
    }
  }

  /** The first concurrent view for a UIN searches and resolves its public start link; sibling views wait for that one result. */
  private resolvePublicLink(session: Session, uin: string): Promise<string> {
    const pending = this.pendingLinks.get(uin);
    if (pending) return pending;
    const task = (async () => {
      const search = await this.searchOn(session, { q: uin, page: 1, pageSize: 20 }, true);
      return resolvePublicViewLink(session.page, uin, this.findMatch(search.items, uin), this.config.actionTimeoutMs);
    })().finally(() => this.pendingLinks.delete(uin));
    task.catch(() => {}); // Each waiting caller handles the rejection itself.
    this.pendingLinks.set(uin, task);
    return task;
  }

  private getEntityPart(uin: string, options: EntityOptions, signal: AbortSignal, excluded:string[]=[], shared?: { pool: SectionPool; primary: boolean }): Promise<EntityResult> {
    return this.withSession(signal,async session=>{
      const { page } = session;
      const {match}=await this.openEntity(session,uin,true);
      const heading = clean(await page.getByRole('heading', { level: 1 }).first().innerText());
      if (!headingIdentifies(heading, uin, match.name)) throw new ApiError('UPSTREAM_IDENTITY_MISMATCH', 'CIPA opened a different entity than requested.');
      // The container tab ("Company Details", "Business name details") only hosts the detail subtabs.
      const labels = (await page.getByRole('tab').allTextContents()).map(clean).filter(label => !['company details', 'business name details', 'details'].includes(label.toLowerCase()));
      const availableSections = [...new Set(labels)].map(label => ({ key: sectionKeyFor(label, fieldKey), label }));
      const wanted = (options.include.includes('all') ? availableSections.map(section => section.key) : options.include).filter(key=>!excluded.includes(key));
      const sections: Record<string, Section> = {};
      // Detail subtabs first; top-level Filings/Visualisation replace the subtab list.
      const ordered = [...new Set(wanted)].sort((a,b) => Number(TOP_LEVEL_SECTIONS.includes(a)) - Number(TOP_LEVEL_SECTIONS.includes(b)));
      const view = { clicked: false, topLevel: false };
      let pending = ordered;
      if (shared) {
        shared.pool.seed(availableSections.map(section => section.key));
        // Explicitly requested absent sections are reported once, by the primary view.
        pending = shared.primary ? ordered.filter(key => !availableSections.some(section => section.key === key)) : [];
      }
      for (let key = pending.shift() ?? shared?.pool.take(view, shared.primary); key !== undefined; key = pending.shift() ?? shared?.pool.take(view, shared.primary)) {
        signal.throwIfAborted();
        const available = availableSections.find(section => section.key === key);
        if (!available) { sections[key] = unavailable((SECTION_LABELS as Record<string,string>)[key] ?? key); continue; }
        try {
          const tab = page.getByRole('tab', { name: available.label, exact: true });
          if (await tab.getAttribute('aria-selected') !== 'true') { await this.remoteClick(session, tab); view.clicked = true; }
          if (TOP_LEVEL_SECTIONS.includes(key)) view.topLevel = true;
          const panel = page.getByRole('tabpanel', { name: available.label, exact: true });
          await panel.waitFor();
          if (key !== 'visualisation') await panel.getByRole('heading', { name: available.label, exact: true }).first().waitFor();
          sections[key] = await this.readSection(session, panel, available.label, key, options);
          if (key === 'visualisation') {
            const statements = parseOwnershipStatements(session.state);
            if (statements !== null) {
              sections[key].ownershipStatements = statements;
              sections[key].status = statements.length ? 'available' : 'empty';
              sections[key].warnings.push('Includes the BODS data supplied to the public diagram at its default depth (1); diagram rendering is not required.');
            } else {
              sections[key].complete = false;
              sections[key].warnings.push('The ownership diagram did not expose readable BODS records.');
            }
          }
        } catch (error) {
          signal.throwIfAborted();
          if (session.failure) throw session.failure;
          const failure = upstreamError(error);
          sections[key] = { ...unavailable(available.label), status: 'error', complete: false, warnings: [`${failure.code}: ${failure.message}`] };
          // A failed section must not leave a modal overlay blocking subsequent tabs.
          const close = page.getByRole('dialog').getByRole('button', { name: /^(Close|Cancel)$/i }).first();
          if (await close.isVisible()) await close.click().catch(() => {});
        }
      }
      const values = Object.values(sections);
      if (values.length && values.every(section => section.status === 'error')) throw new ApiError('UPSTREAM_LAYOUT_CHANGED', 'None of the requested CIPA sections could be read.');
      return { uin, name: match.name, status: match.status, entityType: match.entityType, availableSections,
        sections: inTabOrder(sections, availableSections), complete: values.every(section => section.complete), warnings: values.filter(section => !section.complete).map(section => `${section.label}: incomplete; see section warnings.`),
        retrievedAt: new Date().toISOString(), source: ENTRY_URL };
    });
  }

  getDocuments(uin:string,signal:AbortSignal):Promise<DocumentsResult> {
    return this.withSession(signal,async session=>{
      const {page}=session;
      const {match}=await this.openEntity(session,uin);
      const heading=clean(await page.getByRole('heading',{level:1}).first().innerText());
      if(!headingIdentifies(heading,uin,match.name))throw new ApiError('UPSTREAM_IDENTITY_MISMATCH','CIPA opened a different entity than requested.');
      const documents=await this.readDocuments(session,uin,match.name);
      const failed=documents.filter(doc=>['error','restricted'].includes(doc.status));
      return {uin,name:match.name,documents,complete:failed.length===0,warnings:failed.map(doc=>`${doc.kind}: incomplete; see document warnings.`),retrievedAt:new Date().toISOString(),source:ENTRY_URL};
    }).finally(() => this.prepareIdleSessions());
  }

  private async readDocuments(session: Session, uin: string, name: string): Promise<RegistryDocument[]> {
    const {page}=session;
    const documents:RegistryDocument[]=[];
    // Company extracts and certificate filenames carry the UIN. Business-name documents never show the
    // registration number: the certificate is named after the business name and the extract page repeats it.
    const businessName = isBusinessName(uin);
    const identifiesEntity = (text: string) => businessName ? clean(text).includes(name) : text.includes(`(${uin})`);
    const filenameIdentifies = (kind: DocumentKind, filename: string) => businessName ? kind === 'standardExtract' || filename.includes(name) : filename.includes(uin);
    for(const kind of ['incorporationCertificate','standardExtract'] as DocumentKind[]) {
      let document=unavailableDocument(kind);
      try {
        const menu=page.getByRole('button',{name:'Certificates and Extracts',exact:true});
        if(!await menu.isVisible()){documents.push(document);continue;}
        const option=page.getByRole('menuitem',{name:kind==='standardExtract'?'View standard extract':'Download certificate',exact:true});
        if(!await option.isVisible()){
          await menu.click();
          await page.locator('[role="menu"][data-label="Certificates and Extracts"]').first().waitFor();
        }
        if(!await option.isVisible()){await page.keyboard.press('Escape');documents.push(document);continue;}
        if(kind==='standardExtract') {
          const previous=page.url();
          await Promise.all([page.waitForURL(url=>url.toString()!==previous,{waitUntil:'domcontentloaded'}),option.click()]);
          await page.getByRole('main').waitFor();
          await this.settle(session);
          const main=page.getByRole('main');
          if(!identifiesEntity(clean(await main.innerText())))throw new ApiError('UPSTREAM_IDENTITY_MISMATCH','The standard extract did not identify the requested entity.');
          const link=page.getByRole('link',{name:'Download PDF',exact:true});
          await link.waitFor();
          const [download]=await Promise.all([page.waitForEvent('download'),link.click()]);
          document=await readDocument(kind,download);
        } else {
          const [download]=await Promise.all([page.waitForEvent('download'),option.click()]);
          document=await readDocument(kind,download);
        }
        if(document.filename&&!filenameIdentifies(kind,document.filename))throw new ApiError('UPSTREAM_IDENTITY_MISMATCH','The downloaded document filename did not identify the requested entity.');
      } catch(error) {
        if(session.failure)throw session.failure;
        const failure=upstreamError(error);
        document={...unavailableDocument(kind),status:'error',warnings:[`${failure.code}: ${failure.message}`]};
      }
      documents.push(document);
    }
    return documents;
  }

  private async expand(session: Session, panel: Locator, history: boolean): Promise<boolean> {
    if (session.failure) throw session.failure;
    // These are read-only disclosure controls observed on CIPA's public detail pages.
    // Open visible siblings together, wait for their lazy content to settle, then look for newly revealed
    // nested controls; the whole loop runs in one browser turn instead of one evaluate and settle per level.
    const complete = await panel.evaluate(async (root, { history, limit, timeoutMs }) => {
      const deadline = performance.now() + timeoutMs;
      let remaining = limit;
      while (remaining > 0) {
        let count = 0;
        for (const element of root.querySelectorAll<HTMLElement>('.toggle-details-btn[aria-expanded="false"],.cat-expando-trigger[aria-expanded="false"]')) {
          if (count >= remaining) break;
          if (!element.isConnected || !element.getClientRects().length || getComputedStyle(element).visibility === 'hidden' || element.closest('[hidden],[aria-hidden="true"]')) continue;
          const label = element.getAttribute('aria-label') ?? element.innerText;
          if (!/^More Details\b/i.test(label) && !(history && /\bShow\b.*(?:previous|historic|ceased|removed|former)/i.test(label))) continue;
          element.click(); count++;
        }
        if (!count) return true;
        remaining -= count;
        for (let frame = 0; frame < 2; frame++) await new Promise(next => requestAnimationFrame(() => next(undefined)));
        while ([...root.querySelectorAll('.cat-loading-component')].some(node => {
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden';
        })) {
          if (performance.now() > deadline) throw new Error('Timed out waiting for CIPA loading placeholders to finish.');
          await new Promise(next => requestAnimationFrame(() => next(undefined)));
        }
        await new Promise(next => requestAnimationFrame(() => next(undefined)));
      }
      return false;
    }, { history, limit: 250, timeoutMs: this.config.actionTimeoutMs });
    if (session.failure) throw session.failure;
    return complete;
  }

  private async maximizePageSize(session: Session, panel: Locator) {
    const control = panel.getByRole('button', { name: /^Results per page / }).first();
    if (!await control.count() || !await this.nextPage(panel).count()) return;
    const current = Number((await control.innerText()).trim());
    await control.click();
    const options = session.page.getByRole('menuitem');
    await options.first().waitFor();
    const sizes = (await options.allTextContents()).map(value => Number(value.trim())).filter(value => Number.isInteger(value) && value > current && value <= 100);
    if (!sizes.length) { await session.page.keyboard.press('Escape'); return; }
    const size = Math.max(...sizes);
    await this.remoteClick(session, session.page.getByRole('menuitem', { name:String(size), exact:true }).first());
    await panel.getByRole('button', { name:`Results per page ${size}`, exact:true }).first().waitFor();
  }

  private async readSection(session: Session, panel: Locator, label: string, key: string, options: EntityOptions): Promise<Section> {
    // Retrieve the same filing rows with fewer server round trips. Keep the original
    // page granularity for explicit small limits and expensive per-filing dialog reads.
    if (key === 'filings' && !options.filingDetails && options.maxPages >= 10) await this.maximizePageSize(session, panel);
    let result: Section | undefined;
    const seen = new Set<string>();
    for (let pageIndex = 0; pageIndex < options.maxPages; pageIndex++) {
      try {
      // A lazy child may mount only after the section heading becomes visible.
      // Recheck within this panel before disclosing or reading its fields.
      await this.settle(session, panel);
      const expanded = await this.expand(session, panel, options.history);
      const part = parseSection(await this.visibleHtml(panel), label, session.state);
      const signature = JSON.stringify([part.fields, part.records, part.tables]);
      if (seen.has(signature)) { result!.complete = false; result!.warnings.push('Pagination repeated the same content; stopped.'); break; }
      seen.add(signature);
      if (!result) result = part; else mergeSection(result, part);
      if (!expanded) { result.complete = false; result.warnings.push('Disclosure limit reached (250 controls per page).'); }
      if (key === 'filings' && options.filingDetails) {
        result.filingDetails ??= [];
        await this.readFilingDetails(session, panel, result, options);
      }
      const next = this.nextPage(panel);
      if (!await next.count()) break;
      if (pageIndex + 1 === options.maxPages) { result.complete = false; result.warnings.push(`Page limit reached (${options.maxPages}); more records are available.`); break; }
      await this.advancePage(session, next);
      } catch (error) {
        if (session.failure || !result) throw error;
        const failure = upstreamError(error);
        result.complete = false;
        result.warnings.push(`${failure.code}: ${failure.message} Retained the pages already read.`);
        break;
      }
    }
    return result!;
  }

  private async readFilingDetails(session: Session, panel: Locator, result: Section, options: EntityOptions) {
    const buttons = panel.locator('tbody [role="button"][id$="-modal_btn"]');
    for (let index = 0; index < await buttons.count(); index++) {
      const button = buttons.nth(index), title = clean(await button.innerText());
      await button.click();
      const dialog = session.page.getByRole('dialog').filter({ visible: true }).last();
      await dialog.waitFor();
      try {
        await dialog.getByRole('heading', { name: title, exact: true }).waitFor();
        await this.settle(session, dialog);
        const detail = await this.readSection(session, dialog, title, 'filingDetail', { ...options, filingDetails: false });
        result.filingDetails!.push({ title, text: detail.text, fields: detail.fields, records:detail.records, tables: detail.tables, status: detail.status,
          complete:detail.complete,pagesFetched:detail.pagesFetched,warnings:detail.warnings });
        if (!detail.complete) { result.complete = false; result.warnings.push(`Filing details incomplete: ${title}`); }
      } catch(error) {
        if (session.failure) throw error;
        const failure = upstreamError(error);
        result.complete = false;
        result.filingDetails!.push({title,text:'',fields:[],records:[],tables:[],status:'error',complete:false,pagesFetched:0,warnings:[`${failure.code}: ${failure.message}`]});
        result.warnings.push(`Could not read filing details: ${title}`);
      } finally {
        await dialog.getByRole('button', { name: /^(Close|Cancel)$/i }).last().click();
        await dialog.waitFor({ state: 'hidden' });
      }
    }
  }

  async close() {
    this.closed = true; this.idle = [];
    this.publicLinks.clear();
    await Promise.allSettled([...this.sessions].map(session => session.context.close())); this.sessions.clear();
    await Promise.allSettled(this.preparing);
    await (await this.browser?.catch(() => undefined))?.close(); this.browser = undefined;
  }
}
