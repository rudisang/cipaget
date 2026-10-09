# CIPAget

A TypeScript library and HTTP API for **on-demand public CIPA register lookups**. It runs real searches and reads company tabs in headless Chromium. It is independent of CIPA and does not use an official API.

The source is public and free to use for non-commercial purposes. See [Licence](#licence) and [Contributing](#contributing).

## Run

Requires Node.js 20.19+ (Node 22 recommended).

```sh
npm ci
npm run browser:install
cp .env.example .env
npm run dev
```

To use an installed Chrome instead of downloading Chromium, set `BROWSER_CHANNEL=chrome` in `.env` and skip `npm run browser:install`. Playwright uses a separate browser profile, not your personal Chrome session.

Setting `HYBRID_NAVIGATION=true` turns on a faster mode, the one measured below. For entity data it batches the public search controls and loads a company view over HTTP in that same browser session, then uses CIPA's renderer and normal tab controls. For search listings it submits the query and the Search click as one batched command set instead of three separate round trips, falling back once to the ordinary field and button if the form shape is unrecognised. Set it to `false` to use ordinary browser navigation throughout. The example configuration defaults to `false`. Document downloads retain ordinary browser controls in either mode.

- Documentation: http://127.0.0.1:3000/docs/ (the server's root address redirects there). It explains each request and its limits in plain English. Each endpoint has a Try it panel that shows the request as cURL, JavaScript or Python and the live response as JSON, a readable preview and headers. Light, dark and automatic themes. The same file, [docs/index.html](docs/index.html), also opens straight from disk, where the panels only write the code samples.
- OpenAPI JSON: http://127.0.0.1:3000/openapi.json
- Health and queue/cache counts: http://127.0.0.1:3000/healthz (does not call CIPA)

For compiled execution: `npm run build && npm start`.

## HTTP examples

```sh
# Search is the fastest live lookup. Names and UINs are supported.
curl -G http://127.0.0.1:3000/v1/search --data-urlencode 'q=Sefalana'

# Fast details: select only what you need.
curl 'http://127.0.0.1:3000/v1/entities/BW00000790718?include=general,addresses'

# All available public sections, including historic disclosures and ownership BODS.
curl 'http://127.0.0.1:3000/v1/entities/BW00000790718'

# Separate, slower endpoint: actual certificate and standard-extract PDFs inline.
curl 'http://127.0.0.1:3000/v1/entities/BW00000790718/documents'

# Also open filing metadata/details dialogs; this is substantially slower.
curl 'http://127.0.0.1:3000/v1/entities/BW00000790718?include=filings&filingDetails=true&maxPages=10'

# Search pagination (pageSize is 20, 50, or 100; page is 1–20).
curl 'http://127.0.0.1:3000/v1/search?q=Choppies&page=2&pageSize=20'

# A business name, by its registration number (URL-encode the slash).
curl 'http://127.0.0.1:3000/v1/entities/BN2019%2F11223'
```

Entity options:

| Parameter | Default | Meaning |
|---|---|---|
| `include` | `all` | Comma-separated section keys, or `all` alone |
| `history` | `true` | Open previous/historical disclosure controls |
| `filingDetails` | `false` | Open each listed filing's read-only dialog |
| `maxPages` | `10` | Bound the pages read per section, 1–20 |

Observed section keys: `general`, `addresses`, `directors`, `secretaries`, `shareholders`, `shareAllocations`, `beneficialOwners`, `auditors`, `visualisation`, `filings`, plus `members` (companies limited by guarantee and close companies), `accountingOfficers` (close companies), `authorisedPersons` (external companies: "Persons Authorised to Accept Service") and `proprietors` (business names). Additional tabs are discovered dynamically. `availableSections` reports the actual keys for the entity. An explicitly requested absent section returns `unavailable`.

### Entity types and identifiers

The public search form lists five business entity types: business name, private company, public company, external company and close company. "Limited by Guarantee" is a company sub-type shown in `general`. Every company type opens by UIN. Removed companies and cancelled business names open normally; the header reports `Removed` or `Cancelled`, while search cards show `Removed / Cancelled`.

Business names show **no number anywhere in the public UI**, but CIPA's own "Name or number" box accepts their registration number (`BN<year>/<number>`, printed on the registration certificate). The entity and documents endpoints therefore accept it as the identifier, with the slash URL-encoded:

```sh
curl 'http://127.0.0.1:3000/v1/entities/BN2019%2F11223'
```

The lookup runs that number search, opens the single business-name card CIPA returns for it, and verifies that the opened view's own registration number and name match before reading `general`, `addresses`, `proprietors` and `filings` (there is no visualisation tab). More than one card for a number is reported as `ENTITY_AMBIGUOUS` (409) rather than guessing. A name search still returns business-name cards with `uin: null`; the number is not derivable from a card, so the API never fabricates one.

## Response contract

Every successful response is `{ data, meta }`. `meta.cache` is `miss`, `hit`, or `coalesced`; `ageMs` and `durationMs` describe cache age and request duration. `data.retrievedAt` identifies when the source was checked. HTTP responses use `Cache-Control: no-store`; the service has a separate bounded in-memory cache.

Search returns `items`, `page`, `pageSize`, `hasMore`, nullable `total`, `sourcePagesFetched`, and `warnings`. CIPA's search can display **“Page 1 of 0” with a real result**, and can repeat business-name results across source pages. The API forms logical pages from deduplicated source results (UIN, or the full unnumbered result identity) and follows the next-page control. It never invents totals; each request visits at most 20 source pages. No matches is a successful response with `items: []`. A missing UIN detail lookup returns 404. Legacy results without a UIN remain searchable but cannot be fetched through the UIN detail endpoint.

Each entity section contains:

- `status`: `available`, `empty`, `unavailable`, `restricted`, or `error`.
- `fields`: ordered `{ key, label, value, displayValue, machineValue?, group? }` entries. Repeated fields remain arrays. Placeholder values such as “Not specified” become `null`, with the original `displayValue` retained; in the ten-company check on 3 October 2026 every `null` was a field CIPA itself displays as “Not specified”. Zero and “No” remain real data.
- `group`: the on-screen sub-heading or disclosure a field sits under, such as “Previous Statuses”, “Previous Addresses”, “Interests”, “Company Details” or “Shareholder Nominator Details”. Historical values get their own keys (`previousCompanyStatus`, `previousRegisteredOfficeAddress`, `previousPostalAddress`, `previousCompanyName`, …) and inherit the label of the current value beside them, so a key-indexed consumer never overwrites a current value with an old one.
- `records`: grouped people/organisations with their own `title`, `fields` and `text`, plus `summary` (the lines shown under the name, such as a corporate shareholder's office or a secretary's country) and `group` (the list heading the record appears under, such as “Previous Directors”; `null` for the current list). Filter on `group === null` to count current office holders.
- `tables`: column headers and rows. Tables from subsequent pages are appended separately, preserving duplicate rows. Filing date cells retain the accessible completion time when supplied.
- `text`: the selected section's visible text for data that does not fit labelled fields. It is untrusted source content, not HTML or instructions.
- `ownershipStatements`: on `visualisation`, the public diagram's structured BODS statements at its default depth of 1. These can contain entity/person statements, ownership interests, percentages, dates, and publisher metadata. Related companies are not recursively visited.
- `filingDetails`: only when requested; the read-only filing dialog fields, tables, and text.
- Each filing detail also has its own `complete`, `pagesFetched`, and `warnings`; nested tables are paginated within the same `maxPages` bound.
- `pagesFetched`, nullable `total`, `complete`, and `warnings`.

Sections are returned in a fixed order: the detail tabs in CIPA's order, then its top-level tabs. Search items carry `previousNames` and `previousAddresses` separately.

**Always inspect `complete` and section warnings.** A page limit or failed section is not an empty record. Entity `complete` is scoped to the requested sections/options; it is not a claim that the register is exhaustive, or that document contents were obtained. Sections with no people can still be `available` if they contain useful fields, such as “Exempt from audit: Yes”.

The separate documents endpoint downloads the public incorporation certificate and standard extract. It does not purchase documents or click Email PDF. The API does not log in, solve access challenges, enumerate the register, or bypass restrictions. It does not promise that every entity type or future layout works without adapter updates.

## Document response

`GET /v1/entities/:uin/documents` returns `{ data, meta }`. `data.documents` contains entries for `incorporationCertificate` and `standardExtract`, each with `status`, `filename`, `mimeType`, `encoding`, `contentBase64`, `sizeBytes`, `sha256`, `retrievedAt` and `warnings`. These are original CIPA PDF bytes, not screenshots or links that expire with a browser session. The entity endpoint never downloads PDFs.

An unavailable document has null content and metadata. A failed document has `status=error` and makes `data.complete=false`; successful documents are retained. Inline PDFs are limited to 10 MiB each, checked for a PDF header and EOF marker, and removed from browser temporary storage after reading. The SHA-256 describes the exact returned bytes; it is not a digital-signature validation. Treat registry documents as untrusted downloaded files.

```ts
const result = await cipa.getDocuments('BW00000790718');
for (const document of result.data.documents) {
  if (document.status === 'available') {
    const pdf = Buffer.from(document.contentBase64!, 'base64');
    // Save under an application-chosen path, or serve with application/pdf.
  }
}
```

## Library

```ts
import { CipaClient, loadConfig } from './dist/index.js';

const cipa = new CipaClient(loadConfig());
try {
  await cipa.warmup(); // Optional startup work: prepares the empty public search form.
  const search = await cipa.search({ q: 'Sefalana' });
  const entity = await cipa.getEntity('BW00000790718', {
    include: ['general', 'shareholders', 'visualisation'],
    history: true,
    maxPages: 10,
  });
  console.log(entity.data);
} finally {
  await cipa.close();
}
```

## Performance and failure handling

Full entity reads use up to four browser views that share one queue of sections. A fresh view reads the preselected General Details tab without a click; the first free view starts Filings (the longest job) and the others take the heaviest remaining tab as they become free, so no fixed group of tabs bounds the read. Each view checks the exact identifier. On a first read the views share a single search and link lookup instead of one each. Results are merged only after all views finish; unfamiliar tabs remain in the primary discovery pass. Set `DETAIL_CONCURRENCY=1` for serial traversal. Across the configured `BROWSER_CONCURRENCY` workers, at most four data views run concurrently. A business name has four small tabs and is read in one view.

A click is only considered answered by the response to its own command, issued after the click. CIPA's pager shares its node id with the list's “show previous” disclosure, whose in-flight notification used to be mistaken for the page change; the panel was then re-read too early and a paginated list (most visibly Directors) stopped after page one. Pagination now also waits for the pager's own page indicator to change before reading.

Hybrid mode falls back once to a fresh ordinary UI view when it detects an unsupported layout. Denials, identity mismatches, timeouts and not-found results are not retried. `/healthz` reports transport mode and hybrid view/fallback counts without exposing company data. Unsupported-layout fallback can take longer, so this is not a five-second deadline mechanism.

The server prepares empty search forms before listening when `BROWSER_PREWARM=true`. While a view is idle it also imports the public widget modules that company pages otherwise load on first use (static script files through CIPA's own import map; no company data is requested). Hybrid entity reads retain loaded rendering components between requests; the next read replaces the old view with a freshly fetched one. Search forms are reset when needed, with old UI callbacks drained before switching views. Ordinary browser mode resets used idle views after lookups. This does not prefetch companies. If another lookup arrives during a reset, it waits for that context; the wait counts toward latency. Setting `BROWSER_PREWARM=false` disables background preparation. Browser asset caching, batched read-only disclosures and larger filing pages reduce repeated work. Lazy data checks remain enabled. Cold startup, CIPA response times and first-use widget loading still affect latency; a five-second full-live-response guarantee has not been established.

The separate routing cache stores at most 2,000 observed public start URLs (company and business-name views), expiring `ROUTE_CACHE_TTL_MS` after successful validation (12 hours by default; `0` disables reuse). It never stores names, statuses, field values or opaque session-view URLs. Identity is read from each fresh header; the two observed company types are normalized to the search card's sentence case. Failed openings evict the route, and denials/timeouts are not retried. This routing cache remains useful with `CACHE_TTL_MS=0`; response caching is independent.

Latest end-to-end HTTP verification, 3 October 2026: `CACHE_TTL_MS=0`, every section, historical disclosures and complete pagination, ten companies, three rounds, on a laptop whose load average was 6–12 from unrelated work. All 30 responses were cache misses with `complete: true`, each company's three responses were identical, and health reported zero fallbacks. “Before” is the 12 September build measured the same day (two rounds); it returned different Directors counts between rounds for two companies and stopped after the first Directors page for two more.

| Full fresh response, seconds | Before: first / repeat | Now: first / repeats | Directors records |
|---|---:|---:|---:|
| A small private company | 6.6 / 3.6 | 3.9 / 2.6, 3.5 | 1 |
| Sefalana Cash & Carry | 4.8 / 2.7 | 4.3 / 2.7, 2.7 | 3 |
| Mascom Wireless | 5.2 / 5.0 | 5.1 / 4.4, 4.2 | 15 |
| Kgalagadi Breweries | 6.2 / 4.9 | 5.9 / 4.3, 4.5 | 15 → 17 |
| Choppies Enterprises | 11.3 / 5.9 | 6.8 / 5.0, 5.0 | 9 |
| Botswana Telecommunications | 10.4 / 5.9 | 5.6 / 5.1, 4.5 | 20 → 23 |
| Debswana Diamond Company | 7.2 / 13.9 | 7.0 / 5.1, 5.2 | 23 or 38 → 38 |
| Engen Botswana | 7.0 / 9.0 | 7.3 / 5.0, 5.8 | 12 |
| First National Bank of Botswana | 8.7 / 7.1 | 7.9 / 6.2, 6.8 | 21 |
| Letshego Africa Holdings | 10.0 / 8.7 | 8.6 / 7.3, 6.6 | 27 or 20 → 27 |

Repeat-read median fell from 5.9 s to about 5.0 s and the slowest repeat from 13.9 s to 6.8 s; six of ten companies were under five seconds on the warmed path, against three before. Large companies remain above five seconds: each of the four views pays CIPA's own response time to open the company (0.8–2.9 s), every tab is a round trip, and CIPA shows at most 20 filings per page. Selected sections are faster: `include=general` took 1.9 s and four sections of the largest company 4.8 s. The compiled build was verified as well (20 full reads, 14 reads of other entity types, all complete).

Search listings run on their own lane. With hybrid navigation a name search is one batched command set; the ordinary form sends the field update, the Search click and a follow-up notification as separate round trips. A live comparison on 12 September 2026 returned identical results for eight queries through both paths:

| Search, warmed browser | Ordinary form | Batched |
|---|---:|---:|
| Choppies, 20 per page | 2.04 s | 1.37 s |
| A single-match name search | 1.03 s | 0.44 s |
| Bank of Botswana | 2.05 s | 1.06 s |
| Botswana, 50 per page | 3.28 s | 2.73 s |
| Botswana, page 2 | 3.04 s | 2.30 s |

One query of eight was slower through the batched path in that sample; these are single measurements including the reset between consecutive searches, not an SLA.

These are local samples on one machine, not an SLA. See `docs/research.md` for the phase profile behind these numbers, earlier measurements and rejected shortcuts.

Documents have a **separate endpoint, browser, queue and deadline**, so a PDF generation request does not occupy the data queue. `DOCUMENT_TIMEOUT_MS` defaults to 180 seconds. This worker starts on demand. It can take longer than five seconds, as requested. Both endpoints retain the same cache metadata and explicit completeness reporting.

The browser process and healthy sessions are reused. Identical in-flight requests share one lookup. Successful results are cached for 5 minutes by default; no-match searches for at most 30 seconds. Partial results and errors are not cached. The cache has count and byte limits; no registry database is written to disk by the API.

One concurrent data request is the default, configurable up to four. Searches have their own lane with separate browser views and queue (`SEARCH_CONCURRENCY`, default 1), so a search never waits behind an entity read. A separate document worker handles one document request at a time. Each queue holds at most 20 pending distinct requests. Queue and operation deadlines are separate; operation timeout aborts and closes the affected browser pages. A timed-out task retains its slot until browser cleanup completes. An upstream rate limit or denial causes a 60-second service cooldown. Failed pages are discarded; healthy pages and their public asset cache can be reused.

Error responses are `{ error: { code, message, retryable, requestId } }`. Typical codes: `INVALID_REQUEST` (400), `UNAUTHORIZED` (401), `HOST_NOT_ALLOWED` / `CROSS_SITE_REQUEST` (403), `ENTITY_NOT_FOUND` (404), `ENTITY_AMBIGUOUS` (409), `RATE_LIMITED` (429), `UPSTREAM_LAYOUT_CHANGED` (502), `QUEUE_FULL` / `QUEUE_TIMEOUT` / `UPSTREAM_COOLDOWN` (503), and `UPSTREAM_TIMEOUT` / `OPERATION_TIMEOUT` (504). Do not automatically retry non-retryable errors; honour `Retry-After` when returned. No automatic retry storm is built into the adapter.

## Access and deployment

The server binds to loopback by default. Set `API_KEY` before using a non-loopback `HOST`, and send `Authorization: Bearer <key>` to `/v1/` routes. Use TLS at your reverse proxy. CORS is not enabled.

A server without an API key is local-only: it answers requests whose `Host` is `localhost`, `127.0.0.1` or `[::1]`, plus any names listed in `ALLOWED_HOSTS`, and refuses the rest with `HOST_NOT_ALLOWED`. This stops a web page elsewhere from reaching it by pointing its own hostname at your machine. Lookups requested by a web page on another site are refused with `CROSS_SITE_REQUEST` whether or not a key is set. If you put a proxy in front of a keyless server, either set `API_KEY` or list the public hostname in `ALLOWED_HOSTS`. Logs contain route templates, status and duration, not company queries, returned personal data, or browser cookies.

```sh
docker build -t cipaget .
docker run --rm --init -p 3000:3000 -e API_KEY="your-own-secret" cipaget
```

The Docker image uses bundled Chromium. Environment options and limits are documented in `.env.example`. This prototype's cache, cooldown and queue are per process; keep a single instance unless you add shared coordination.

## Validation and research

```sh
npm test                 # offline parser, queue, cache, API and error tests
npm run typecheck
npm run test:live -- basic
npm run test:live -- full
npm run test:live -- deep
npm run test:live -- pagination
npm run benchmark -- local 2 --prewarm # Real full lookups; bypasses result cache
```

Live tests perform real CIPA requests; run them deliberately rather than on every commit. Their local, gitignored captures are under `output/playwright/`. Fixtures in the offline tests are synthetic.

The benchmark writes private local measurements and response captures under `output/performance/`. Startup time is recorded separately. Result-cache hits are faster still, but are not counted as live-browser speedups.

See [docs/research.md](docs/research.md) for observed data, source links, design decisions, and test limitations, and [docs/free-options.md](docs/free-options.md) for the free alternatives investigated. Browser automation is still automated data extraction; this project makes no claim of copyright or data-protection clearance.

## Contributing

Bug reports, fixes for CIPA layout changes and documentation improvements are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first: it covers setup, the checks a change must pass, and the kinds of change this project will not take (bulk collection, enumeration, or anything that goes around CIPA's access controls). Report security problems privately as described in [SECURITY.md](SECURITY.md).

## Licence

Copyright 2026 Rudisang Morake.

CIPAget is released under the [PolyForm Noncommercial License 1.0.0](LICENSE.md). You may use, study, change and share it for non-commercial purposes, such as personal projects, research, education, and use by charities and public bodies. **Commercial use is not permitted.**

The licence covers this software only. It gives no rights over the register data the software reads; that data remains subject to CIPA's terms and to Botswana law.
