# Contributing to Lorecrew

Thank you for helping make self-hosted AI teams useful, understandable and dependable.

## Start a change

Use an issue to describe a bug with its expected behavior, actual behavior, package version and host OS. For a feature, explain the user workflow and why the current behavior is insufficient. Keep credentials, pairing secrets, transcripts, private paths and vault contents out of issues. Follow [SECURITY](SECURITY.md) for sensitive reports.

Keep pull requests focused. Preserve pinned dependencies, existing session/skill revisions, request identity, explicit ownership and recovery safeguards. An uncertain external effect must remain uncertain until its actual outcome is established. Do not turn a timeout into a success or silently replay non-idempotent work.

## Work locally

Use Node.js 24, npm 11 and Git:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm run check
npm test -- --maxWorkers=1
npm run test:e2e
```

Browser tests need Playwright Chromium. Install it deliberately with `npx playwright install chromium` if missing. Tests use disposable instances and scripted providers; do not substitute real credentials or a working vault. Process-heavy integration tests run most reliably with one file worker; concurrency inside each test remains exercised.

Use a private HOME/auth environment for any additional application smoke check. Never point a fixture at an existing instance or use real provider calls simply to make a test pass. Installed opt-ins require their explicit artifact/cache inputs; a skipped opt-in is not installed coverage.

## Documentation and website

Public guides live in `docs/`. The static site renders those same Markdown files:

```sh
npm run check:public
npm run build:site
npm run test:site
npm run test:site:browser
```

The browser check starts a temporary static preview; Python 3 and Playwright Chromium are required. Build the website before running that check. To keep a preview open, run:

```sh
node website/build.mjs --base /lorecrew/ --origin http://127.0.0.1:4321 --out website/dist/preview/lorecrew
python3 -m http.server 4321 --bind 127.0.0.1 --directory website/dist/preview
```

Open `http://127.0.0.1:4321/lorecrew/`. The production build defaults to `https://lorecrew.dev/` at the domain root. Override `--base` and `--origin` for other deployments. The `Public website` workflow reads the configured origin and base path from GitHub Pages before building, so custom domains and repository-prefixed sites use the correct links. It publishes `main`.

Keep public documentation focused on users and contributors. Do not commit planning notes, execution ledgers, review reports, test results, personal build identities, screenshots of private data or raw validation artifacts. Store internal development records outside the public repository. Test output belongs in ignored directories. The public guard checks the source boundary; package tests also inspect the actual npm file list.

The website uses existing dependencies at build time and plain HTML/CSS/JavaScript in the browser. Preserve keyboard navigation, readable no-JavaScript pages, reduced-motion behavior, valid nested links and the GitHub Pages repository prefix. Mark illustrative product content clearly and make only capabilities supported by the current application visible.

## Before opening a pull request

Describe the concrete user change and how you checked it. Include a regression test for meaningful behavior changes. For presentation-only changes, inspect desktop and mobile layouts. Update the relevant public guide when behavior changes. Keep generated output and private evidence out of the patch.

Contributions are made under the project's [MIT license](LICENSE).
