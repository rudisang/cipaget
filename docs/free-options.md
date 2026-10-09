# Free options researched, 12 September 2026

The current API runs locally with open-source dependencies. No paid browser host, proxy, CAPTCHA service, LLM API or Apify account is required. Hosted operation would still need a machine; no free-hosting guarantee is assumed.

| Option | Relevant capability | Fit for CIPAget |
|---|---|---|
| [Playwright APIRequestContext](https://playwright.dev/docs/api/class-apirequestcontext) | Its browser-associated HTTP client shares the browser context's cookie jar. | Tested in a separate research adapter following public company-card redirects. Both sample companies matched the browser output. The browser's native fetch was also tested; neither transport alone established a five-second result for both companies. |
| [Crawlee](https://github.com/apify/crawlee) | Apache-2.0; Node/TypeScript; browser pooling, session management and HTTP/browser crawlers. | Useful if this grows into a larger service. It can run locally; its [quick start](https://crawlee.dev/js/docs/quick-start) requires no paid cloud account. Adding it alone does not remove CIPA's round trips. |
| [Crawlee AdaptivePlaywrightCrawler](https://crawlee.dev/js/api/playwright-crawler/class/AdaptivePlaywrightCrawler) | Chooses HTTP parsing or browser rendering based on whether rendering is needed. | A useful design pattern, not a drop-in CIPA adapter. CIPA's visible tabs and initial view data differ, so every fast path needs complete-response comparison. |
| [Scrapling](https://github.com/D4Vinci/Scrapling) | BSD-3-Clause; Python; HTTP sessions, browser sessions and parsing. | A viable free alternative, but changing language/framework does not establish a speed gain for this register. No reason to migrate the working API just for a benchmark claim. |

[Crawlee's scaling guide](https://crawlee.dev/js/docs/guides/scaling-crawlers) is particularly relevant: concurrency should be bounded and measured; more concurrent browsers can make an overloaded machine slower. Our current implementation bounds data views to four and uses a separate single document worker.

## What the measurements establish

- Both public PDFs are available: incorporation certificate and standard extract. They have their own `/v1/entities/:uin/documents` endpoint, browser, queue and 180-second default deadline.
- Full data reads preserve all 10 observed sections. Comparisons include typed field values, historical disclosures, grouped records, tables, BODS and every filing name/date.
- The latest HTTP test with response caching disabled measured first reads of 6.94 / 6.65 seconds and final warmed repeats of 3.47 / 4.70 seconds for the small private company / Choppies. Both full fresh responses demonstrated the five-second target on the warmed path, but an earlier Choppies repeat took 6.12 seconds. This is not a latency guarantee. Cached responses are reported separately and do not count as that target.
- Directly rendering inactive initial-view data changed fields. Sharing contexts or reusing opaque company-view links across sessions produced timeouts. Those experiments were removed from the production path.
- A framework's parser benchmark is not evidence for CIPA end-to-end latency. Public UI state, session setup, pagination and CIPA's own document generation remain part of the work.

## Hybrid experiment and next steps

Keep Playwright and Cheerio. The research adapter in `scripts/hybrid-navigation-experiment.ts` now follows a current public search-card action within its session, reads its public-view redirects, initializes CIPA's renderer with the returned view, and visits the requested tabs normally. It does not reuse another session's opaque company URL. A second experiment batches only the observed search-field update and Search button commands. Both companies passed comparisons of their complete returned data.

Combining native browser fetch, batched search and balanced tab groups produced prepared-form repeat reads of 4.56 seconds for the small private company and 5.40 seconds for Choppies; first reads were 7.26 and 6.53 seconds. Those were research measurements.

The API supports this approach through `HYBRID_NAVIGATION=true`, disabled by default in `.env.example`. It now also retains observed public company-start links in a bounded routing cache. These create independent fresh views; opaque session URLs and company attributes are not cached by that layer. This produced the latest timings above. Unsupported layouts fall back to ordinary navigation once; denials, timeouts, not-found and identity errors do not. Tests cover bootstrap parsing, routing expiry, fresh identity, redirect boundaries, fallback and transport separation. Documents keep their own ordinary browser worker. Do not export arbitrary hidden UI state, replay write operations, or describe this as an official CIPA API.

This changes the transport strategy, not the reuse-rights analysis. Choosing an open-source library makes the software free to run; it does not grant rights over registry data.
