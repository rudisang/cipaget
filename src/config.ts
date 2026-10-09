export interface Config {
  host: string; port: number; apiKey?: string; channel?: string; headless: boolean;
  concurrency: number; maxQueue: number; queueTimeoutMs: number; operationTimeoutMs: number;
  actionTimeoutMs: number; cacheTtlMs: number; cacheMaxEntries: number; cacheMaxBytes: number;
  rateLimit: number; prewarm: boolean; detailConcurrency: number; documentTimeoutMs:number; hybridNavigation: boolean; searchConcurrency: number; routeCacheTtlMs: number; allowedHosts: string[];
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer between ${min} and ${max}`);
    return value;
  };
  const host = env.HOST ?? '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !env.API_KEY) {
    throw new Error('Set API_KEY before binding to a non-loopback HOST.');
  }
  return {
    host, port: integer('PORT', 3000, 1, 65535), apiKey: env.API_KEY || undefined,
    channel: env.BROWSER_CHANNEL || undefined, headless: env.HEADLESS !== 'false',
    concurrency: integer('BROWSER_CONCURRENCY', 1, 1, 4), maxQueue: integer('MAX_QUEUE', 20, 0, 100),
    queueTimeoutMs: integer('QUEUE_TIMEOUT_MS', 30000, 100, 300000),
    operationTimeoutMs: integer('OPERATION_TIMEOUT_MS', 180000, 1000, 600000),
    actionTimeoutMs: integer('ACTION_TIMEOUT_MS', 20000, 1000, 60000),
    cacheTtlMs: integer('CACHE_TTL_MS', 300000, 0, 3600000),
    cacheMaxEntries: integer('CACHE_MAX_ENTRIES', 100, 1, 10000),
    cacheMaxBytes: integer('CACHE_MAX_BYTES', 32 * 1024 * 1024, 1024, 512 * 1024 * 1024),
    rateLimit: integer('RATE_LIMIT', 60, 1, 10000),
    prewarm: env.BROWSER_PREWARM !== 'false',
    detailConcurrency: integer('DETAIL_CONCURRENCY', 4, 1, 4),
    documentTimeoutMs:integer('DOCUMENT_TIMEOUT_MS',180000,1000,600000),
    hybridNavigation: env.HYBRID_NAVIGATION === 'true',
    searchConcurrency: integer('SEARCH_CONCURRENCY', 1, 1, 4),
    routeCacheTtlMs: integer('ROUTE_CACHE_TTL_MS', 12 * 60 * 60_000, 0, 7 * 24 * 60 * 60_000),
    allowedHosts: (env.ALLOWED_HOSTS ?? '').split(',').map(name => name.trim().toLowerCase()).filter(Boolean),
  };
}
