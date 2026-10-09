/** TTL/LRU bounded by count AND bytes. Values are JSON-cloned so callers cannot poison cached data. */
export class ResultCache {
  private entries = new Map<string, { json: string; expires: number; stored: number; bytes: number }>();
  private bytes = 0;
  constructor(private maxEntries: number, private maxBytes: number, private now = Date.now) {}
  get<T>(key: string): { data: T; ageMs: number } | undefined {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.expires <= this.now()) { this.remove(key); return; }
    this.entries.delete(key); this.entries.set(key, entry);
    return { data: JSON.parse(entry.json) as T, ageMs: this.now() - entry.stored };
  }
  set(key: string, value: unknown, ttlMs: number) {
    this.remove(key);
    if (ttlMs <= 0) return;
    const json = JSON.stringify(value), bytes = Buffer.byteLength(json) + Buffer.byteLength(key);
    if (bytes > this.maxBytes) return;
    for (const [k, entry] of this.entries) if (entry.expires <= this.now()) this.remove(k);
    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) this.remove(this.entries.keys().next().value!);
    this.entries.set(key, { json, bytes, expires: this.now() + ttlMs, stored: this.now() }); this.bytes += bytes;
  }
  private remove(key: string) { const entry = this.entries.get(key); if (entry) this.bytes -= entry.bytes; this.entries.delete(key); }
  clear() { this.entries.clear(); this.bytes = 0; }
  get stats() { return { entries: this.entries.size, bytes: this.bytes }; }
}
