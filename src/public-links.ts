import { identifierKind } from './identifiers.js';

// Only these public start routes were observed to create independent fresh views.
const START_ROUTES = {
  company: { path: /^\/companies\/ui\/start\/entityView\/[a-f\d]{32}$/, search: '?dom=Company' },
  businessName: { path: /^\/businessnames\/ui\/start\/businessNameView\/[a-f\d]{32}$/, search: '?dom=BusinessName' },
} as const;

/** Bounded routing cache. Values contain no entity attributes or session view URLs. */
export class PublicViewLinks {
  private entries = new Map<string, { url: string; expires: number }>();
  constructor(private maxEntries = 500, private ttlMs = 30 * 60_000, private now = Date.now) {}
  get(uin: string): string | undefined {
    const entry = this.entries.get(uin);
    if (!entry) return;
    if (entry.expires <= this.now()) { this.entries.delete(uin); return; }
    this.entries.delete(uin); this.entries.set(uin, entry);
    return entry.url;
  }
  set(uin: string, value: string): boolean {
    let url: URL;
    try { url = new URL(value); } catch { return false; }
    const kind = identifierKind(uin), route = kind && START_ROUTES[kind];
    if (!route || url.origin !== 'https://www.cipa.co.bw' || url.username || url.password || url.hash ||
      !route.path.test(url.pathname) || url.search !== route.search) return false;
    this.entries.delete(uin);
    this.entries.set(uin, { url: url.href, expires: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    return true;
  }
  delete(uin: string) { this.entries.delete(uin); }
  clear() { this.entries.clear(); }
}
