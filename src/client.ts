import { CipaBrowser } from './browser.js';
import { ResultCache } from './cache.js';
import { loadConfig, type Config } from './config.js';
import { ApiError } from './errors.js';
import { identifierKind } from './identifiers.js';
import { WorkQueue } from './queue.js';
import type { EntityOptions, EntityResult, RegistryProvider, SearchOptions, SearchResult, DocumentsResult } from './types.js';

export interface Envelope<T> { data: T; meta: { cache: 'hit' | 'miss' | 'coalesced'; ageMs: number; durationMs: number } }
export function validateSearch(input: Partial<SearchOptions> & { q: string }): SearchOptions {
  if (typeof input.q !== 'string' || /[\u0000-\u001f\u007f]/.test(input.q)) throw new ApiError('INVALID_QUERY', 'q must be a company name or number without control characters.', 400);
  const q = input.q.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (q.length < 2 || q.length > 200) throw new ApiError('INVALID_QUERY', 'q must contain between 2 and 200 characters.', 400);
  const page = input.page ?? 1, pageSize = input.pageSize ?? 20;
  if (!Number.isInteger(page) || page < 1 || page > 20) throw new ApiError('INVALID_PAGE', 'page must be an integer from 1 to 20.', 400);
  if (![20,50,100].includes(pageSize)) throw new ApiError('INVALID_PAGE_SIZE', 'pageSize must be 20, 50, or 100.', 400);
  return { q, page, pageSize };
}
export function validateEntity(uin: string, input: Partial<EntityOptions> = {}): { uin: string; options: EntityOptions } {
  const id = typeof uin === 'string' ? uin.trim().toUpperCase() : '';
  if (!identifierKind(id)) throw new ApiError('INVALID_UIN', 'uin must be a company UIN (BW followed by 5–20 digits) or a business name registration number (BN, four-digit year, slash, number; URL-encode the slash as %2F).', 400);
  const include = input.include ?? ['all'];
  if (!Array.isArray(include) || !include.length || include.length > 30 || include.some(key => typeof key !== 'string' || !/^[a-z][a-zA-Z0-9]{0,40}$/.test(key) || ['constructor','prototype'].includes(key))) throw new ApiError('INVALID_INCLUDE', 'include must be a non-empty list of section keys or all.', 400);
  if (include.includes('all') && include.length > 1) throw new ApiError('INVALID_INCLUDE', 'Use all alone, or specify individual sections.', 400);
  const maxPages = input.maxPages ?? 10;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20) throw new ApiError('INVALID_MAX_PAGES', 'maxPages must be an integer from 1 to 20.', 400);
  for (const key of ['history','filingDetails'] as const) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new ApiError('INVALID_OPTIONS', `${key} must be boolean.`, 400);
  return { uin: id, options: { include: [...new Set(include)].sort(), history: input.history ?? true, filingDetails: input.filingDetails ?? false, maxPages } };
}

export class CipaClient {
  private provider: RegistryProvider;
  private queue: WorkQueue;
  private searchQueue: WorkQueue;
  private searchProvider: RegistryProvider;
  private documentQueue: WorkQueue;
  private documentProvider: RegistryProvider;
  private cache: ResultCache;
  private inflight = new Map<string, Promise<unknown>>();
  private cooldownUntil = 0;
  private closed = false;
  constructor(private config: Config = loadConfig(), provider?: RegistryProvider) {
    this.provider = provider ?? new CipaBrowser(config);
    // Searches are short; give them their own browser views so they never queue behind entity reads.
    this.searchProvider = provider ?? new CipaBrowser({...config,concurrency:config.searchConcurrency,detailConcurrency:1});
    this.searchQueue = new WorkQueue(config.searchConcurrency, config.maxQueue, config.queueTimeoutMs, config.operationTimeoutMs);
    this.documentProvider = provider ?? new CipaBrowser({...config,concurrency:1,detailConcurrency:1,hybridNavigation:false});
    this.queue = new WorkQueue(config.concurrency, config.maxQueue, config.queueTimeoutMs, config.operationTimeoutMs);
    this.documentQueue = new WorkQueue(1,config.maxQueue,config.queueTimeoutMs,config.documentTimeoutMs);
    this.cache = new ResultCache(config.cacheMaxEntries, config.cacheMaxBytes);
  }
  get stats() { return { ...this.queue.stats, transport:this.provider.diagnostics ?? null, search:{...this.searchQueue.stats,transport:this.searchProvider.diagnostics ?? null}, documents:{...this.documentQueue.stats,transport:this.documentProvider.diagnostics ?? null}, cache: this.cache.stats, cooldownMs: Math.max(0, this.cooldownUntil-Date.now()) }; }
  async warmup(): Promise<void> {
    const lanes:Array<[RegistryProvider,WorkQueue]>=[[this.provider,this.queue]];
    if (this.searchProvider!==this.provider) lanes.push([this.searchProvider,this.searchQueue]);
    await Promise.all(lanes.map(([provider,queue]) => provider.warmup && queue.run(signal => provider.warmup!(AbortSignal.any([signal, AbortSignal.timeout(this.config.actionTimeoutMs)])))));
  }
  async search(input: Partial<SearchOptions> & { q: string }): Promise<Envelope<SearchResult>> {
    const options = validateSearch(input);
    // Preserve query spelling in the response; normalized whitespace still coalesces.
    return this.lookup(`search:${JSON.stringify(options)}`, signal => this.searchProvider.search(options, signal), this.searchQueue);
  }
  async getEntity(uin: string, input: Partial<EntityOptions> = {}): Promise<Envelope<EntityResult>> {
    const validated = validateEntity(uin, input);
    return this.lookup(`entity:${JSON.stringify(validated)}`, signal => this.provider.getEntity(validated.uin, validated.options, signal));
  }
  async getDocuments(uin:string):Promise<Envelope<DocumentsResult>> {
    const validated=validateEntity(uin).uin;
    if(!this.documentProvider.getDocuments)throw new ApiError('DOCUMENTS_UNSUPPORTED','The configured registry provider does not support document retrieval.',501);
    return this.lookup(`documents:${validated}`,signal=>this.documentProvider.getDocuments!(validated,signal),this.documentQueue);
  }
  private async lookup<T>(key: string, action: (signal: AbortSignal) => Promise<T>, queue:WorkQueue=this.queue): Promise<Envelope<T>> {
    if (this.closed) throw new ApiError('SHUTTING_DOWN', 'The API is shutting down.', 503, true);
    const started = performance.now();
    const cached = this.cache.get<T>(key);
    if (cached) return { data: cached.data, meta: { cache:'hit', ageMs:cached.ageMs, durationMs:Math.round(performance.now()-started) } };
    const existing = this.inflight.get(key);
    if (existing) return { data: structuredClone(await existing) as T, meta: { cache:'coalesced', ageMs:0, durationMs:Math.round(performance.now()-started) } };
    if (Date.now() < this.cooldownUntil) throw new ApiError('UPSTREAM_COOLDOWN', 'CIPA recently restricted requests. Retry after the cooldown.', 503, true);
    const promise = queue.run(action);
    this.inflight.set(key, promise);
    try {
      const data = await promise;
      const value = data as { complete?: boolean; items?: unknown[] };
      if (!this.closed && value.complete !== false) this.cache.set(key, data, value.items?.length === 0 ? Math.min(30000, this.config.cacheTtlMs) : this.config.cacheTtlMs);
      return { data, meta: { cache:'miss', ageMs:0, durationMs:Math.round(performance.now()-started) } };
    } catch (error) {
      if (error instanceof ApiError && ['UPSTREAM_RATE_LIMITED','UPSTREAM_ACCESS_RESTRICTED'].includes(error.code)) this.cooldownUntil = Date.now()+60000;
      throw error;
    } finally { this.inflight.delete(key); }
  }
  async close() { this.closed = true; this.queue.close(); this.searchQueue.close(); this.documentQueue.close(); this.cache.clear(); await Promise.all([...new Set([this.provider,this.searchProvider,this.documentProvider])].map(provider => provider.close())); }
}
