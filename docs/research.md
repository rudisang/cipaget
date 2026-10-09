# CIPA adapter research

Investigated 11 September 2026 using ordinary public browser searches. No account or payment was used.

## Entry and protocol

The supplied opaque `/master/ui/XP-…` link returned 404. The stable public entry on the [CIPA homepage](https://www.cipa.co.bw/) is [Search the Register](https://www.cipa.co.bw/master/ui/start/CIPARegisterSearch). It creates an opaque session-specific URL. Store UINs, not those URLs.

The site identifies Foster Moore in its footer. Normal searches submit JSON UI commands to the current `/ui/XP-…` URL. Responses are a graph of UI nodes, not an official company-data API. Nodes include generated IDs, semantic attributes, display values, children, and widget metadata. The adapter lets Playwright perform the UI interactions; it does not replay private endpoints. It passively enriches displayed fields from matching response nodes and reads the public visualiser's explicitly supplied BODS payload.

The top-level tabs use a `ui-tabsSelect` event whose node ID differs from the DOM tab ID; a naive ID-only response waiter times out. Search has a distinct button-click command. This matters because blur and scroll notifications also cause POST responses.

## Records inspected

| Record | UIN | Differences exercised |
|---|---|---|
| A small private company | not listed here | Private company; current and previous statuses/addresses; individual director and shareholder; corporate secretary; beneficial ownership; 100 shares; audit-exemption field with no auditor; 18 filing entries observed |
| Choppies Enterprises Limited | BW00001142508 | Public company; multiple directors and beneficial owners; individual and corporate shareholders; nominee-related fields; auditor; 16 share-allocation entries across pages; a longer filing history |

These values are observations at retrieval time, not fixtures that should be assumed permanently true. The wider data model includes foreign countries, long addresses, repeated names, missing values, and dates embedded in display strings. A role's listed address may be historical or personal; it is not necessarily the company's current office.

## Public data discovered

- General: name, entity type/subtype, UIN, old registration number, current status/effective date/reason, prior statuses, incorporation and re-registration dates, constitution metadata, annual return month and latest filing date.
- Addresses: registered office, postal address, principal business address, effective dates and previous addresses.
- People and organisations: names, nationalities/countries of registration, addresses and changes, appointments, alternate-director fields, company references, representative and nominee information where shown.
- Share allocations: shareholder names, quantities, percentages where supplied, aggregate share count, pagination.
- Beneficial ownership: names, nationalities, addresses, nature of interest, percentages and related public fields.
- Auditors: auditor details or explicit no-auditor text, and audit exemption where supplied.
- Filings: history item title, completion timestamp, paginated history and read-only filing detail dialogs. Those dialogs can include presenter details and fields changed by a filing. The initial prototype did not fetch documents; the later document endpoint described below now retrieves the two public PDFs.
- Visualisation: a `visualiser` widget supplies `widgetData.jsonData` containing **BODS 0.3** entity, person, and ownership/control statements. The diagram produced a JavaScript rendering error during browser research; the public data response itself was present. The adapter returns that structured payload when available without depending on SVG rendering. Default graph depth is 1.

## Edge cases that changed the implementation

1. A selected tab and its heading can appear before its data. Even network-idle can occur while `.cat-loading-component` placeholders remain. Wait for widget hydration before parsing.
2. Hidden DOM templates include alerts, old content, and even generic delete-confirmation controls on read-only pages. The adapter excludes hidden elements and only clicks explicitly recognised read-only disclosures, tab/pagination controls, and filing dialogs.
3. Search pagination displayed “Page 1 of 0” despite one real match. Trust the next-page control; return unknown totals as `null`.
4. The live no-match message is “No results found using the given search criteria”; framework responses also contain “Your search returned no results”. Recognise both explicitly; an arbitrary blank page is an error.
5. “No auditors added yet” can coexist with a meaningful audit-exemption value. Empty lists and empty sections are different.
6. Repeated labels and names occur. Keep fields as ordered arrays, group role records, and preserve per-page tables rather than overwriting values in a dictionary.
7. A company search result is not sufficient evidence for a detail lookup. Match the exact UIN and verify the opened detail heading.
8. The results-per-page menu mounts asynchronously. Selecting 50 must wait for the menu item, its server response, and the updated page-size control; otherwise the response may still contain 20 results.
9. An early live adapter test produced overlapping result sets when changing page size and advancing a mixed company/business-name search. This may reflect asynchronous UI state as well as source pagination; it does not establish a CIPA backend defect. Search now waits for the selected size and reads each source page before advancing, with defensive deduplication into logical API pages and a 20-source-page bound. A comparison of page 2 at size 20 against positions 21–40 of a size-50 query passed. Any overlaps detected are reported in warnings.
10. Cancelled business names may have no UIN or subtype. Their registration date occupies an earlier metadata position. Parse metadata by meaning rather than assuming four fixed positions.
11. Filing timeline components can retain a previous page's `aria-label` completion timestamp while their visible date changes. Prefer the visible date when they disagree and report a warning; do not attach the stale time to that filing. The original captures contained this problem. Performance comparisons therefore check filing names/order and the independently captured visible dates, rather than preserving erroneous old accessibility values.

## Validation results

The headless adapter retrieved all 10 available tabs for both sample companies. The small private company returned 51 labelled fields, 18 filing entries across 4 source pages, and 3 BODS statements; Choppies returned 188 labelled fields, 37 filings across 8 pages, 16 share allocations across 2 pages, and 5 BODS statements. Counts are observations of these requests, including fields repeated in historical sections.

Five of the small private company's filing dialogs were also opened and read, including a restoration, removal, share consideration, beneficial-ownership change, and annual return. A one-page filing limit was deliberately used to exercise `complete=false`. No document content was downloaded.

The live tests verify no-match handling, UIN detail identity, full-section traversal, logical search pagination, page-size selection, filing details, and explicit limits. HTTP testing additionally verified successful serialization of BODS statements and cache hits. The Docker recipe is provided but was not built during local validation.

## Performance investigation, 12 September 2026

The baseline was 26.6 seconds for the small private company and 33.1 seconds for Choppies with the result cache bypassed. Profiling found repeated asset loading (Playwright request routing disables Chromium's HTTP cache), sequential disclosure waits, and many filing-page round trips.

Removing request routing preserves the normal browser asset cache. Cosmetic animations are disabled; hydration checks remain. Read-only sibling disclosures are opened in a batch, with nested controls discovered after their content settles. Filing lists select the largest available size up to 100 for normal full retrieval. The observed filing pagination fell from 4 to 1 pages for the small private company and from 8 to 2 for Choppies, retaining all 18 and 37 rows respectively.

A prepared-browser run measured 15.1 seconds for the first read of the small private company, 13.7 seconds for Choppies, then 10.1 and 12.9 seconds on repeat live reads. Preparing the empty public search form took 8.9 seconds separately; no company result was prefetched or served from the API cache. The HTTP server now does this preparation at startup by default. A completely cold browser still costs about 25 seconds for the first full record if preparation is disabled.

The comparison checks every section's status, labelled fields, grouped records, non-filing tables/text, ownership statements, and filing name/date/order. Page-count and pagination UI text differences are intentional. Accessible timestamps that conflict with visible dates are corrected as described above. All sections remain requested; the benchmark does not substitute selected-section requests or cached company results. These are two-company local measurements, not a service-level guarantee.

After the timestamp correction, another direct run returned both complete records in 14.0 seconds each. The final HTTP verification returned the small private company in 13.8 seconds and Choppies in 13.1 seconds, both cache misses; every section payload matched those corrected direct captures exactly. HTTP server preparation took 7.4 seconds separately. All 18 offline tests and the TypeScript build passed.

## Supporting sources

- [Playwright network events](https://playwright.dev/docs/network): observing responses generated by normal UI actions.
- [Playwright browser contexts](https://playwright.dev/docs/browser-contexts): isolated sessions; no personal browser profile needed.
- [Playwright Page API](https://playwright.dev/docs/api/class-page): response waiting and browser lifecycle.
- [Fastify validation and serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/): request schemas and response contracts.
- [CIPA terms](https://www.cipa.co.bw/terms-and-conditions.html): no blanket automated-data reuse permission was established by this investigation.
- [Botswana Copyright and Neighbouring Rights Act](https://wipolex-res.wipo.int/edocs/lexdocs/laws/en/bw/bw005en.html): sections 4 and 6 distinguish original collections from mere data. This is context, not a legal clearance for a service.
- [BODS](https://standard.openownership.org/): standard linked from CIPA's visualisation. We preserve source statements instead of guessing relationship semantics.

## Scope limits

Public access today does not guarantee future access or reuse rights. The prototype extracts data supplied through the public pages requested by a caller, with no bulk crawl, authentication bypass, paid-document access, or recursive visits to linked entities. Personal data can be present in role and filing fields. Review the exact intended commercial use separately.

Live coverage centres on the two company types above. Other entity types, removed entities, CAPTCHA pages, and outages are not all reproducible on demand; fail clearly and add fixtures as those layouts are observed. Offline tests exercise null handling, schema changes, deadlines, queue overflow, cache eviction, authentication, and error envelopes without repeatedly querying CIPA.

## Public document downloads and separate endpoint, 12 September 2026

The observed **Certificates and Extracts** menu contains **Download certificate** and **View standard extract**. The certificate link downloads from `/companies/template/…`; its opaque URL should not be persisted. The standard-extract action navigates to a new public view, which offers **Download PDF** at `/companies/document/…`. There is also an Email PDF action; the adapter never uses it.

Downloaded and checked both PDFs for the small private company and Choppies. Their certificates identify the requested UINs; the standard extracts contain 3 and 12 pages respectively. The PDF responses preserve the original bytes, filename, byte count and SHA-256. Public standard extracts differ from the full detail tabs and do not substitute for them. No date override, email, login or purchase was used.

At the user's request, PDFs are returned by `/v1/entities/:uin/documents`, with a separate worker/queue and a 180-second default operation deadline. The main entity response contains registry data only. A Choppies standard-extract flow took about 12.5 seconds in one run; PDF generation therefore cannot be treated as a sub-five-second dependency.

The initial view data includes inactive company sections, but rendering those locally produced different fields from ordinary server-driven tab visits. That shortcut was rejected after the parity test failed. Bounded parallel traversal uses normal public UI visits instead; comparisons check every field (including typed values), record, table, ownership statement and filing date/name against the serial baseline. All requested tabs, including newly discovered ones, remain in scope.

Live HTTP checks of the separate endpoints passed for both companies. The small private company's data completed in 9.6 seconds while its document worker completed in 18.3 seconds from a cold start. Choppies data completed in 10.7 seconds while its documents completed in 8.2 seconds. Both data payloads matched the verified section captures exactly; all four PDFs decoded successfully with matching byte counts, SHA-256 hashes and UIN filenames. A repeated document request hit the cache. There are 23 passing offline tests, including queue separation, parallel failure cleanup, unknown tabs and PDF validation.

The under-five-second fresh full-data target remains unverified. See [free-options.md](free-options.md) for the researched next options; no paid services were introduced.

## Empty-form preparation and readiness experiments

Preparing only empty search forms between fresh uncached reads produced a 4,965 ms read of the small private company and an 8,121 ms Choppies read after earlier reads had populated the browser asset cache. First reads were 8,733 and 8,158 ms. This is a narrow observation, not a general five-second result. Captures are in `output/performance/ready-forms`; the complete field/record/table/BODS/filing parity check passed for both companies.

Production now resets idle contexts to the empty search page after the entire lookup finishes. It neither prefetches company results nor waits for the reset before returning a completed result. A following request arriving during preparation waits for an existing context rather than creating extra contexts. Reset failures discard their context, caller cancellation preserves a context still being prepared for others, and shutdown drains preparation. An upstream denial during reset reaches the next lookup so the client can apply its normal cooldown. `BROWSER_PREWARM=false` disables this behavior. Five new offline tests exercise those lifecycle cases; 28 tests pass.

The production back-to-back benchmark (`output/performance/idle-preparation`) includes reset waits: first reads 8,605 / 8,708 ms and repeat reads 7,059 / 9,214 ms for the small private company / Choppies. It passed the same full-data comparison. Background preparation helps when there is idle time but does not eliminate work under continuous load.

Globally accelerating Playwright visibility polling caused a search hydration failure: the Search Results heading appeared before the result cards. Production now explicitly waits for a result link or CIPA's observed no-results message, then checks lazy loading. The faster-polling experiment is not enabled. Limiting it to company-section headings preserved compared outputs but only produced repeat timings of 4,479 / 7,769 ms with prepared forms, insufficient to establish the target.

Hybrid initialization exposed another lazy-loading race: a section heading could appear before its child fields. Production again checks loading within each panel before extraction. A live nonexistent-company search returned a clean empty list with `hasMore=false` after the readiness changes.

## Hybrid transport measurements

`scripts/hybrid-navigation-experiment.ts` is a separate research adapter, not part of the API transport. It uses a rendered public card's observed node ID to open the company, follows same-origin company-view redirects, reads the returned initial view, and initializes CIPA's own rendering components. It continues to select all data tabs through ordinary UI actions. The extracted output is still limited to the displayed requested sections. Initial null view nodes are handled as in CIPA's bootstrap. No company URL is shared across sessions.

The Playwright HTTP-client variant passed full-data comparison for both companies and measured prepared-form repeat reads of 5,839 / 6,985 ms. The native browser-fetch variant measured 4,618 / 7,244 ms and also passed. Batching the two observed search-control commands and moving Shareholders and Visualisation to the primary branch measured 4,563 / 5,397 ms on repeat reads (first reads 7,260 / 6,530 ms). Both rounds passed comparisons including exact section coverage, table headings, all field values, records, BODS, and every filing name/date. These are research results; neither an API integration nor an under-five-second result for both companies is established.

Faster section-heading polling on that combined hybrid adapter measured 4,910 / 5,410 ms, and a second tab distribution measured 4,662 / 5,879 ms. Both rounds of both experiments passed the strengthened comparison. Neither change demonstrated a further gain. The production API retains the ordinary UI transport and existing tab distribution.

To reproduce the most promising research variant (empty search forms are prepared outside each measured company read):

```sh
node --env-file-if-exists=.env --import tsx scripts/benchmark-ready-forms.ts hybrid-check --hybrid-navigation --browser-fetch --batch-search --balanced-groups
node --import tsx scripts/compare-benchmarks.ts verified hybrid-check 0
node --import tsx scripts/compare-benchmarks.ts verified hybrid-check 1
```

The preparation duration is recorded separately. These commands deliberately bypass the result cache and query only the two sample companies. Browser initialization, failure recovery and other entity layouts need further coverage before adopting this transport in the API.

After building and restarting the production API with the pool and hydration fixes, `scripts/verify-http-data.ts` passed: both fresh responses contained all 10 sections and matched the baseline exactly, the document route remained in OpenAPI, health/docs returned 200, and a nonexistent-company search returned an empty list. End-to-end HTTP times were 8,755 ms for the small private company and 7,418 ms for Choppies. No hybrid code was enabled for that check. Next profiling should split hybrid company opening into the card action, public-view redirects, renderer initialization and heading readiness; the research harness now records those phases separately.

## Optional hybrid API integration

Subsequent phase profiling found first-use General Details heading waits around 790 ms, but warmed Choppies waits were only 13–28 ms. Accelerating that heading alone measured repeat reads of 4,804 / 5,508 ms and did not establish a five-second result for both companies. Browser-renderer initialization and CIPA's document/redirect responses also contribute substantial time; a heading-only optimization is not enough.

The validated hybrid navigation is now available in `src/hybrid.ts`, gated by `HYBRID_NAVIGATION=true`. The default configuration and `.env.example` keep it off; the setup used for these measurements enabled it for entity data. Search listings and the independent document worker keep ordinary UI controls. The adapter reads JSON bootstrap data without executing source scripts in Node, binds the action to its visible search card, verifies the requested UIN and public-view URLs, and renders through CIPA's own components. Unsupported layouts reset to an ordinary UI flow once. Denials, timeouts, identity mismatch and not-found errors do not trigger fallback. Health diagnostics report the transport and aggregate hybrid view/fallback counts.

With caching disabled in a separate local API instance, the first full-data HTTP reads measured 6,374 / 9,911 ms and repeat reads measured 4,902 / 6,471 ms for the small private company / Choppies. All four responses contained the exact same 10 section payloads as the verified baseline, and an empty search passed. These timings include browser preparation waits between consecutive HTTP requests. There are 34 passing offline tests, including hybrid parsing, redirect boundaries, fallback, denial handling, document separation and unknown-tab coverage under both transports. The five-second target remains incomplete.

The final main-server check passed after enabling hybrid navigation in `.env`: two fresh full-data HTTP responses measured 6,423 / 6,722 ms and matched all section payloads exactly. Health reported eight successful hybrid view openings, zero fallbacks, and ordinary browser transport for documents. The temporary server on port 3001 was stopped; the main API remains on port 3000.

The next promising optimization is preserving the renderer when resetting to the empty search form. Current resets perform full navigation, which clears the page's JavaScript module instances even though HTTP assets are cached. A same-session public-search bootstrap could avoid that repeated work, but must drain the old UI queue, verify an empty public search form, retain ordinary-navigation fallback, and pass the same full-data and lifecycle checks before adoption.

## Renderer-preserving reset and rejected tab batching

The fresh public search bootstrap identifies itself as service `CIPARegisterSearch`, mode `Search`, under app `master`. A reset experiment retained CIPA's loaded renderer, fetched that fresh bootstrap, drained old UI callbacks, then verified an empty Name or number field and no Search Results heading. Both rounds matched the complete baseline for both companies. Repeat reads were 5,267 / 5,992 ms; resets took about 620–650 ms after initial use.

That reset is now integrated into hybrid mode, with service-shape validation, ordinary-navigation fallback for unsupported layouts, and no fallback after denial. Untouched empty contexts are not reset again. Reset denials reach the normal client cooldown even when they originate from the helper rather than a response event. There are 39 passing offline tests. The integrated provider benchmark passed both rounds of full-data comparison, measuring repeat reads of 5,258 / 6,713 ms; this remains short of the target.

A separate experiment batched all public inner-tab selection events before rendering them locally. It failed the data comparison: the General Details fields lost labels and historical status details. It is explicitly rejected and is not used by the API. Reducing the loading-overlay minimum and directly activating enabled read-only controls did not establish a convincing additional speed gain and also remain research-only. The production workflow continues to visit each tab and wait for its data.

After restarting the main API, `scripts/verify-http-data.ts persistent-main 1` passed full section equality for both companies and an empty search. Health reported eight hybrid company views, eight renderer-preserving resets, and zero fallbacks of either kind. Documents remained on ordinary browser transport. Fresh HTTP times were 6,439 / 7,910 ms. These measurements still do not satisfy a five-second target.

## Full-state JSON probe

`scripts/research-json-view.ts` submitted an empty command list to each already-open public company view with `returnChangesOnly=false`. It returned the current root and full state: 527 nodes / 155,826 JSON bytes for the small private company, and 2,235 nodes / 476,373 bytes for Choppies. It did not return service metadata (`serviceState` or `responseData`), so it is not a complete replacement for the HTML bootstrap as currently implemented.

Using Playwright's separate HTTP client, JSON took 1,866 / 1,574 ms and subsequent HTML reads took 890 / 1,669 ms. The JSON responses reported server elapsed times of 34.22 / 78.321 ms. Connection setup, transfer, and client overhead therefore need to be separated before attributing the remainder to CIPA's data computation. This ordered, already-open-view probe does not establish a faster bootstrap; native browser-connection measurement would be the next useful comparison. No JSON-only transport was enabled.

The subsequent native-browser comparison used JSON, HTML, HTML, JSON ordering for each company. For the small private company, JSON took 469 / 260 ms versus HTML 256 / 265 ms; Choppies JSON took 331 / 323 ms versus HTML 294 / 298 ms. Choppies' compressed HTML was smaller than JSON (about 87 KB versus 101 KB). The JSON-only transport showed no useful advantage and was not adopted.

## Reusing public company-start links

Ordinary public search-card clicks returned `/companies/ui/start/entityView/<32-character company identifier>?dom=Company`. Unlike final opaque `/companies/ui/XP-...` view URLs, these public start links successfully opened fresh views in independent anonymous browser contexts. No register enumeration or invented company route was used.

The research adapter cached only these observed routing URLs. First reads, including route discovery, measured 6,965 / 8,366 ms; repeat fresh reads measured 3,866 / 5,412 ms for the small private company / Choppies. Fresh headers use `Private Company` / `Public Company`, while search cards use `Private company` / `Public company`; the production adapter explicitly normalizes only these two observed labels.

The integrated route cache is bounded to 500 URLs and expires entries 30 minutes after successful validation. Every branch still loads and verifies a new company bootstrap and reads the selected visible tabs. No names, status or company field values come from the routing cache. Hybrid entity renderers remain idle between reads without unnecessary empty-form fetches. Failed openings evict the route; unsupported layouts retain ordinary UI fallback, and denial, identity mismatch and timeout are never fallback triggers. The document worker retains ordinary browser navigation. Offline coverage is now 43 passing tests, including route expiry/eviction, fresh identity changes and cached-route denial handling.

The integrated provider benchmark (`public-links-production`) passed complete comparisons for both companies in both rounds. It measured first reads of 8,264 / 7,813 ms and repeats of 4,331 / 6,845 ms. Its instrumentation verified a distinct fresh view URL for every branch across all reads.

The final HTTP test (`public-links-http`) used a separate local API with `CACHE_TTL_MS=0` and three consecutive rounds. The small private company measured 6,937 / 3,873 / 3,473 ms; Choppies measured 6,649 / 6,118 / 4,701 ms. All six responses explicitly reported cache misses, complete data, exact identity/section equality, and no embedded document payload. Empty search, OpenAPI and docs checks passed. Health reported 24 hybrid views, 16 route-cache hits, five search resets and zero fallbacks; documents remained on ordinary browser transport.

This demonstrates full fresh HTTP responses below five seconds for both sampled companies on the warmed path. It does not establish five-second first-use latency, a percentile SLA or coverage of every entity layout. The route cache contains only public routing identifiers; the final benchmark did not reuse registry response data.

After installing the tested build on the main port 3000 server, first fresh reads measured 6,242 / 7,945 ms and again passed full metadata/section comparison. Empty search and transport diagnostics passed with zero fallbacks. The temporary port 3001 server was stopped. These cold main-server readings reinforce the distinction between the demonstrated warmed result and a universal five-second guarantee.

## Search lane and batched name search, 12 September 2026

A live probe of six `/v1/search`-equivalent provider calls on a warmed browser measured 0.8–3.5 s per search. A name search cost three CIPA round trips: the field update sent when focus leaves the box (0.25–1.2 s), the Search click (0.3–0.4 s), and a follow-up `view-node-set-key-value` notification (0.25–0.75 s) that the loading overlay kept on the critical path. The reset after each search (about 0.65 s in hybrid mode) also delayed an immediately following search. Separately, search and entity reads shared one queue with concurrency 1, so a search arriving during a full entity read waited for it, which is the largest single threat to a five-second search.

Two changes were made, with offline tests written first (51 pass):

1. **Separate search lane.** `CipaClient` now runs `/v1/search` on its own `WorkQueue` and its own `CipaBrowser` instance, sized by `SEARCH_CONCURRENCY` (default 1, at most 4), mirroring the document worker. Warm-up prepares both lanes; `/healthz` reports the lane under `search`. The library-level test proves a search completes while an entity read holds the only data slot.
2. **Batched name search.** `submitHybridSearch` no longer restricts the batched field-update-plus-click command set to UIN queries; `/v1/search` uses it whenever `HYBRID_NAVIGATION=true`. If the form shape is unrecognised, `submitSearch` falls back once to the ordinary field and button on a fresh view and counts `searchFallbacks`; denials and server-reported search errors are never retried.

Live parity, one warmed browser per transport, eight queries including a no-match query, an apostrophe-and-ampersand query, page size 50 and logical page 2: every batched response equalled the ordinary-form response exactly (items, `hasMore`, `total`, `sourcePagesFetched`, warnings). The batched path sent one POST per search where the form sent two or three:

| Query | Ordinary form | Batched |
|---|---:|---:|
| Choppies, 20 per page | 2,038 ms | 1,370 ms |
| A single-match name search | 1,027 ms | 442 ms |
| Sefalana | 1,025 ms | 527 ms |
| No match | 871 ms | 766 ms |
| Bank of Botswana | 2,049 ms | 1,062 ms |
| O'Reilly & Sons (Pty) Ltd, no match | 1,175 ms | 1,690 ms |
| Botswana, 50 per page | 3,276 ms | 2,730 ms |
| Botswana, page 2 of 20 | 3,043 ms | 2,304 ms |

These are single measurements that include the reset between consecutive searches. The live `basic` and `pagination` smoke runs passed on the batched path.

An HTTP verification on a temporary port 3001 server with `CACHE_TTL_MS=0` was attempted while the test machine reported a one-minute load average above 80 on 8 cores with heavy paging from unrelated applications. Under that load the entity read timed out after 67 s before opening any company view, the two concurrent searches took about 8 s, and the unchanged single-browser control benchmark (`scripts/benchmark.ts lane-control 1 --prewarm`) also timed out during warm-up. A retry with `DETAIL_CONCURRENCY=1` (two prepared views instead of five) while the one-minute load average was about 45 completed: the full ten-section entity read took 47.2 s and returned complete, while a search for Sefalana issued 0.4 s after it returned in 4.3 s and a search for Bank of Botswana returned in 5.2 s, both long before the entity read finished. Health reported one hybrid entity view, three search-lane resets and no fallbacks. Before the lane change those searches would have waited behind the entity read. Absolute timings on that overloaded machine are not representative; the warmed idle searches that followed took 3.5 s and 2.5 s. The second browser process adds one prepared view and its memory at start-up; on a memory-constrained host, consider `BROWSER_PREWARM=false` or a shared browser process as a future refinement.

Not adopted: skipping the reset between consecutive searches and a sticky pagination cursor. Both remain candidates if back-to-back or paged searches dominate the workload.

## Entity-type coverage, 3 October 2026

The public search form's own "Business entity types" filter lists exactly five types: business name, private company, public company, external company and close company; "Limited by Guarantee" is a company sub-type shown in General Details. Examples opened through ordinary card clicks: external companies BW00002470382 (registered) and BW00008108591 (removed), close companies BW00008204140 and BW00008119500 (every close-company result observed was removed), public company limited by guarantee BW00001178485, removed private company BW00008023444, and business names BN2019/11223 (registered) and BN2016/556363 (cancelled).

All company types bootstrap under `appCode=companies` with service codes `privateCompanyView`, `publicCompanyView`, `externalCompanyView` and `closeCompanyView`, and open through the same `/companies/ui/start/entityView/<id>?dom=Company` start link. New tabs: "Persons Authorised to Accept Service" (external), "Members" and "Accounting Officers" (close, guarantee). Fresh headers title-case the type ("External Company"); search cards use sentence case.

Business names open through `/businessnames/ui/start/businessNameView/<id>?dom=BusinessName` under `appCode=businessnames`, service `businessNameView`, with tabs "Business name details" (General details, Addresses, Proprietors) and Filings, and no visualisation. Their heading shows no number (`<span class="entity-number">` is empty) and no tab shows one; the registration number appears only as `Catalyst.businessIdentifier` in the view's own bootstrap. CIPA's "Name or number" box accepts that number (`BN2019/11223` returned exactly the Sefalana Hyper card), so the API accepts it as an entity identifier, requires exactly one business-name card for the number, and verifies the opened view's bootstrap identifier and heading name. Business-name certificates download from `/businessnames/template/` named after the business name; the standard extract page and PDF (`/businessnames/document/`) repeat the name, never the number. A cancelled business name showed no Certificates and Extracts menu.

Defects found and fixed: the hybrid card binding compared the viewtree label strictly, and "Botswana Ostrich Company" carries a double space in CIPA's label, so every branch fell back to ordinary navigation; empty notes such as "No new beneficial owners added", "No authorised agents added yet", "No accounting officers added yet" and "All current directors/members/proprietors have been removed" were reported as `available` sections with no data; ordinary-mode identity came from the search card ("Removed / Cancelled") while hybrid read the header ("Removed"), which could trip the cross-branch identity check after a fallback. Both transports now read identity from the opened header. BW00001178485's Directors still report "Pagination repeated the same content" (handled separately).

## Reliability, completeness and speed pass, 3 October 2026

A baseline of the 12 September build (ten companies, two rounds, cache off) showed searches at about 1 s, full reads at 2.7–13.9 s, and three kinds of inconsistency. Four parallel investigations followed, each in its own copy of the project with sequential, bounded live lookups; their changes were merged and re-verified together.

**Directors stopped after page one.** Debswana returned 23 directors in one round and 38 in the next; BTC and Kgalagadi Breweries were truncated in both. Cause: the pager control's id is `<node>-pageNext`, and the list's “Show previous directors” disclosure posts a `view-node-set-key-value` (`ui-expanded`) notification for the *same node id*. `remoteClick` accepted any POST whose command id prefixed the control id, so it returned on that in-flight notification before the click's own `pagination-update` had even been sent (CIPA's client queue serialises commands). No loading placeholder appears for pagination, so the panel was re-read with page one still showing and the identical content was reported as “Pagination repeated the same content”. Fix: `src/ui-commands.ts` maps each control to the command it must produce; only POSTs issued after the click is armed can satisfy the waiter; the client queue is drained; and `advancePage` waits for the pager's own indicator to change. Tabs post `view-node-fire-event` (`ui-tabsSelect`, or `ui-wizardSelect` in hybrid views) and the filings timeline pages with `ui-filing-page`. Nested people lists offer only 10 or 20 per page, so enlarging them saves nothing and was not adopted.

**Unlabelled and merged history.** Every `null` in the baseline (158 of 3,065 values) was a field CIPA displays as “Not specified”; none was a parse failure. The losses were elsewhere: previous statuses, addresses and names came back as `key: "value", label: null` with a duplicated aggregate string; records under “Previous Directors/Secretaries/Shareholders/Beneficial Owners/Auditors” were indistinguishable from current ones; the line under a corporate record's name and “Share register: …” appeared only in `text`; and search cards put previous names into `previousAddresses`. The parser now emits `group` on fields and records, `previous…` keys that inherit the adjacent label, record `summary`, and `previousNames` on search items. On identical captured HTML for six companies the count went from 1,971 to 1,957 values: 15 duplicate aggregate strings dropped, one value gained, none lost. Fastify's response schemas silently drop unknown properties, so each new property is declared in `src/schema.ts` and covered by an HTTP round-trip test.

**Other entity types.** The search form's own type list is business name, private, public, external and close company; “Limited by Guarantee” is a sub-type. External and close companies, removed entities and business names are now read correctly; see the entity-type notes above. Empty notes such as “No authorised agents added yet” are rendered as “NoteNo …”, which the old pattern never matched, so empty sections were reported as `available`.

**Where the time goes.** Per view, opening the company is a fetch of the public start link whose cost is almost entirely CIPA's time to first byte (0.8–0.9 s for small companies, 1.7–2.9 s for large ones when four views fetch together). Each tab click is 0.35–0.6 s of round trip (Visualisation 1.1–1.4 s) plus 0.3–0.5 s for the renderer to apply a 425–672 KB state response. First use of a widget type in a browser context triggers a dynamic-import waterfall of 0.2–0.3 s per dependency level. Every “More Details” or “Show previous” click queues a 0.3–0.4 s notification ahead of the next click. Filings offers page sizes of 5, 10 and 20 only. `visibleHtml` and parsing are cheap (2–30 ms and 30–90 ms).

Adopted: one in-page evaluate for `settle` and for the whole disclosure loop; a shared queue of sections that views take from as they become free (`SectionPool`), replacing fixed tab groups; a single shared search and link lookup per first read (six fewer CIPA requests); idle-time import of the public widget modules; and a configurable routing-cache lifetime (`ROUTE_CACHE_TTL_MS`, 12 hours by default). Sections are returned in a fixed order regardless of which view read them.

Not adopted: suppressing or batching the `ui-expanded` notifications (changes what the server sees and departs from normal browser behaviour); splitting filings pages across views (an extra view costs more than the pages it saves); requesting a filings page size the UI does not offer; prefetching company views; sharing one cookie session between views.

Merged-build verification: 79 offline tests; 30 of 30 full reads complete and identical across three rounds; every baseline value still present; seven other-entity examples complete in two rounds; search pagination, previous names, number search and no-match checks passed; zero hybrid, reset or search fallbacks across 164 views. Warmed median about 5.0 s (was 5.9 s), slowest warmed read 6.8 s (was 13.9 s). The remaining floor for large companies is CIPA's per-view open time plus the filings page chain; a five-second full read is not established for them.
