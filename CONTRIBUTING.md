# Contributing to CIPAget

Thank you for wanting to help. This guide says which changes fit the project, how to set it up, and what a pull request needs before it can be merged.

## What fits, and what does not

CIPAget reads Botswana's public CIPA register on demand: one search or one entity at a time, through the same public pages a person would use. Every change has to keep it that way.

Welcome:

- Fixes for when CIPA changes its site and a page is no longer read correctly
- Bug fixes, with a test that would have caught the bug
- Support for entity types or tabs that are read wrongly or not at all
- Speed-ups that send fewer requests to CIPA
- Clearer documentation

Not accepted:

- Bulk collection: crawling, listing or exporting the register, or following links from one entity to another
- Anything that goes around CIPA's access controls: logging in, solving challenges, rotating addresses, or disguising the browser
- Changes that put more load on CIPA, such as more parallel views, automatic retries or prefetching
- Buying documents, or using “Email PDF”
- Writing register data to disk

If you are not sure which side an idea falls on, open an issue and ask before you write code.

## Before you start

- Search the [existing issues](https://github.com/rudisang/cipaget/issues) to see whether it has come up.
- For anything larger than a small fix, open an issue first that describes the problem and how you plan to solve it. It saves you from building something that cannot be merged.
- Do not report security problems in a public issue. Follow [SECURITY.md](SECURITY.md).

## Set up

You need Node.js 20.19 or newer (22 is recommended).

```sh
git clone https://github.com/<your-username>/cipaget.git
cd cipaget
npm ci
npm run browser:install   # or set BROWSER_CHANNEL=chrome in .env to use an installed Chrome
cp .env.example .env
npm run dev
```

The server prepares its browser, then listens on `http://127.0.0.1:3000`. The documentation is at `/docs/`.

## Checks every change must pass

```sh
npm run typecheck
npm test
```

`npm test` is offline. It uses stand-in providers and made-up fixtures, never contacts CIPA, and finishes in a few seconds. Run it as often as you like.

### Live tests

These send real requests to CIPA's website:

```sh
npm run test:live -- basic
npm run test:live -- full
npm run test:live -- deep
npm run test:live -- pagination
```

Run them on purpose and sparingly: once to confirm a change to the browser or parsing code, not in a loop and never in automated pipelines. If CIPA starts refusing or slowing requests, stop and wait.

## Tests

- A bug fix comes with a test that fails before the fix and passes after it.
- Test behaviour where a caller would see it: an HTTP route, `CipaClient`, or what the parser returns for a given page. Avoid tests that only restate how the code is written.
- Fixtures must be made up. Do not commit captured register pages, real people's names or addresses, or downloaded PDFs. The `output/` folder is ignored by git for this reason.

## Code

- TypeScript in strict mode. Match the style of the file you are editing.
- Do not add a runtime dependency without agreeing it in an issue first. Dependencies are pinned to exact versions.
- When a page does not look as expected, fail with a clear error. Never guess a value or return something uncertain.
- Never log search queries, returned data, cookies or API keys.

## Documentation

When behaviour changes, update the documentation in the same pull request:

- `docs/index.html`, the page served at `/docs/`. Write in plain English: what the request does, its parameters, and its limits.
- The parameter descriptions in `src/app.ts`, which feed `/openapi.json`.
- `README.md`, if setup, settings or the response format changed.

## Commits and pull requests

- Branch from `main`. Keep each pull request to one topic, and keep it small.
- Write commit subjects in the imperative, 72 characters or fewer, and use the body to explain why:

  ```
  Wait for the pager indicator before reading the next page

  The list was re-read while page one was still showing, so long
  director lists stopped after the first page.
  ```

- In the pull request, say what changed, why, and how you tested it: which commands you ran, and whether you ran a live test and against what kind of entity.
- Keep your branch up to date with `main` and resolve conflicts before asking for review.
- Expect review comments. A change may be declined if it falls outside what the project does, even when the code is good.

## Licence of contributions

CIPAget is released under the [PolyForm Noncommercial License 1.0.0](LICENSE.md). By submitting a contribution you agree that it is licensed under the same terms, and you confirm that you have the right to submit it.

## Conduct

Be respectful and constructive. Harassment, personal attacks and discriminatory language are not tolerated. The maintainer may edit or remove such content and block people who repeat it.
