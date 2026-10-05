# Varnish integration tests (Playwright)

## 1. What this is

This directory holds an integration test suite for a Magento 2 shop that runs behind the VCL shipped in `etc/varnish6.vcl`. It sits next to the `varnishtest` unit tests in `tests/varnish`. Those tests prove that the VCL template does what it says against a fake backend. This suite proves that the real shop, the real Varnish and the real Magento configuration work together.

It sends plain HTTP requests and drives a real browser against a running store. It proves that:

- cacheable pages are served from cache and that the cache key is normalized the way the VCL promises,
- private pages, private endpoints and logged in content never land in a shared cache object,
- no personal data of one visitor is served to another visitor,
- Magento purges, soft purges, grace and the purge ACL behave as configured.

The suite never creates fixtures and never runs destructive tests on production. When `VARNISH_ENV=production`, the Playwright configuration does not register the `fixtures` and `destructive` projects at all. On production, every destructive test also skips itself.

## 2. Install in a project

The suite lives in the composer package. A project adds a small overlay directory that holds its configuration, hooks and project specific specs. The suite itself is copied into that directory as `base/` and is never edited in place.

Any directory works. The convention is to put it next to the elgentos Playwright suite of the theme, for example:

```
app/design/frontend/<Vendor>/<theme>/web/varnish/
    package.json
    varnish.config.json
    hooks.ts             (optional)
    specs/               (optional project specs)
    base/                (synced copy, gitignored)
    node_modules -> ../playwright/node_modules
```

Steps:

1. Create the directory and a `package.json` (example below).
2. Make sure that `@playwright/test` is resolvable from the overlay. Either symlink `node_modules` to `../playwright/node_modules`, or run `npm i -D @playwright/test` inside the overlay. If the sibling directory exists, the sync script creates the symlink by itself.
3. Run `npm run sync`. This calls `node vendor/elgentos/magento2-varnish-extended/tests/playwright/bin/sync.mjs` and copies the suite into `base/`. Run it again after every composer update of the package.
4. Add `base/`, `test-results/`, `playwright-report/` and `node_modules` to the `.gitignore` of the overlay.
5. Write `varnish.config.json` (see section 3) and export the environment variables (see section 4).

Example `package.json`:

```json
{
    "name": "varnish-tests",
    "private": true,
    "scripts": {
        "sync": "node ../../../../../../../vendor/elgentos/magento2-varnish-extended/tests/playwright/bin/sync.mjs",
        "test": "playwright test -c base/playwright.config.ts",
        "smoke": "playwright test -c base/playwright.config.ts --grep @smoke",
        "request": "VARNISH_SKIP_BROWSER=1 playwright test -c base/playwright.config.ts",
        "report": "playwright show-report playwright-report"
    }
}
```

The relative path in `sync` counts from the overlay to the project root. For an overlay in another location, adjust the path.

Example `.env` for the overlay (load it with `set -a; source .env; set +a` or a tool such as `dotenv-cli`, Playwright does not load it by itself):

```
VARNISH_BASE_URL=https://user:pass@shop.test/
VARNISH_ENV=local
MAGENTO_CLI=php bin/magento
MAGENTO_ROOT=/data/web/magento2
VARNISH_PURGE_CLIENT_IN_ACL=1
```

Run everything with `npm test`. Run from the overlay directory, because the suite reads `varnish.config.json` and `hooks.ts` from the current working directory unless `VARNISH_PROJECT_DIR` says otherwise.

## 3. Configuration

`varnish.config.json` in the overlay is deep merged over `base/config/defaults.json`. Objects merge key by key. Arrays and scalars from the overlay replace the default. Unknown top level keys fail fast with a message that lists the known keys, so a typo never silently disables a test.

Two substitutions run over every string value: `${VARNISH_BASE_URL}` becomes the base URL from the environment, and `${random}` becomes a fresh 8 character token per run (used for the 404 path).

Top level keys:

| Key | Purpose |
| --- | --- |
| `stores` | One entry per store view to test: `code`, `baseUrl`, `websiteId`, `currency` and `pages`. `stores[].pages` overrides the global `pages` for that store, so each store can point at its own category or product. The request, browser and project projects run once per store. |
| `pages` | Paths of the standard pages: `home`, `category`, `product`, `cms`, `search`, `notFound`. A `null` page skips the tests that need it. |
| `pageSet` | Which page keys count as "the cacheable pages" for tests that loop over pages. |
| `uncacheablePaths` | Paths that must never be served from cache (cart, checkout, account, section load, health check). |
| `adminPath` | Path of the admin frontname. |
| `privateUrls` | Extra paths that must never be a HIT, for example customer specific feeds. |
| `conditionalUrls` | Paths visible to one customer group only: `url`, `visibleTo` (account key), `guestStatus`, optional `store`. Proves that a cached 404 for a guest does not reach an entitled customer. |
| `trackingParamsToAssert` | Tracking parameters that must be stripped from the cache key. Keep it in sync with the admin setting. |
| `unknownParam` | A query parameter that is not stripped. The suite uses it as a cache buster so a test owns its own object. |
| `allowedVaryHeaders` | Allowed values of the `Vary` response header. Anything else fragments or kills the cache. |
| `strippedResponseHeaders` | Response headers the VCL must remove before the response reaches the client. |
| `flags` | Behavior switches of the VCL: `bfcache`, `cache404`, `mediaCache`, `staticCache`, `xkey`, `softpurge`, `gracePeriod`, `designExceptions`, `cookieDomain`, `passOnCookieRegexes`. With `autodetect: true` the preflight reads them from Magento and overrides the file. |
| `purgeMode` | `auto`, `ban`, `xkey` or `xkey-softpurge`. `auto` derives the mode from the flags. The mode decides what a purge must look like from the outside. |
| `fixtures` | `mode` is `cli`, `provided` or `none`. `customers` lists the accounts to create with `key`, `groupId`, `websiteId` or `website`, `storeCode` and `attributes`. `extraAttributes` applies to every customer. `purgeProductSku` and `purgeCategoryId` feed the purge tests. |
| `pii` | Which strings count as personal data: fixture emails, names and tokens (`fromFixtures`), `extraMarkers`, and the `checkEncodings` to search for (`raw`, `html`, `json`, `url`). |
| `normalize` | `stripRegexes` and `stripSelectors` applied to HTML before two guest responses are compared byte by byte (nonces, timestamps, form keys). |
| `loggedInMarkers` | CSS selectors per page that are visible in one login state only. They prove that cached pages do not leak the wrong state. |
| `priceAssertions` | Expected price strings per account key on a page, used to prove that group prices are not shared across groups. |
| `selectors` | Login form, logout link, add to cart, mini cart count and price selectors for the browser tests. |
| `paths` | Login, logout, section load, GraphQL, currency switch and health check paths. |
| `timeouts` | `purgePropagationMs` is the time allowed for a purge to show. `sectionLoadMs` is the time allowed for a section load. |
| `coalescing` | `parallelRequests` for the request coalescing test. |

## 4. Environment variables

| Variable | Purpose |
| --- | --- |
| `VARNISH_BASE_URL` | Store front URL. Falls back to `PLAYWRIGHT_BASE_URL`. Basic auth in the URL (`https://user:pass@host/`) is split off and sent as HTTP credentials. |
| `VARNISH_CONFIG` | Path of the overlay configuration file. Default: `varnish.config.json` in the project directory. |
| `VARNISH_PROJECT_DIR` | The overlay directory. Default: the current working directory. |
| `VARNISH_ENV` | `local` (default), `staging` or `production`. Production never registers fixtures or destructive tests and forces fixture mode `provided`. |
| `MAGENTO_CLI` | Command that runs the Magento CLI, for example `php bin/magento`, `magerun2` or `ssh app@host php /data/web/magento2/bin/magento`. An empty value disables the CLI. |
| `MAGENTO_ROOT` | Magento root directory. Default: the first parent of the project directory that contains `bin/magento`. |
| `VARNISH_FIXTURE_MODE` | Overrides `fixtures.mode`: `cli`, `provided` or `none`. |
| `VARNISH_ACCOUNT_<KEY>_EMAIL`, `_PASSWORD`, `_FIRSTNAME`, `_LASTNAME` | Accounts for `provided` mode. `<KEY>` is the upper cased customer key from `fixtures.customers` (`a1` becomes `A1`). |
| `VARNISH_KEEP_FIXTURES` | `1` keeps the created customers after the run. |
| `VARNISH_PURGE_CLIENT_IN_ACL` | Set to `1` on a test machine that is in the Varnish purge ACL. Switches the PURGE and forced refresh tests between the "allowed" and "refused" expectations. |
| `VARNISH_WORKERS` | Number of Playwright workers. Default: 4. |
| `VARNISH_SKIP_BROWSER` | `1` runs the request specs only. |
| `VARNISH_SKIP_DESTRUCTIVE` | `1` skips the destructive project on any environment. |
| `VARNISH_INCLUDE_EDGE` | `1` also runs the `@edge` tests that document known VCL quirks with `test.fail`. |

## 5. Projects and order

```
preflight -> fixtures -> request:<store> / browser:<store> / project:<store> -> destructive -> fixtures-teardown
```

- `preflight` makes sure that Varnish answers in front of Magento, that `caching_application` is 2 and that `remember_pagination` is off. It records the effective flags in `test-results/varnish-flags.json`.
- `fixtures` creates the disposable customers through the CLI and makes sure that they can log in on every store. It registers `fixtures-teardown` that removes them at the end.
- `request:<store>` runs the HTTP level specs for one store. `browser:<store>` runs the browser specs. `project:<store>` runs the overlay specs. All three run per configured store and in parallel.
- `destructive` runs once, on the first store, after every per store project finished. It purges, flushes and, with hooks, takes the backend down. When one of those projects has a failed test, Playwright skips it. To run it on its own, set `VARNISH_ONLY_DESTRUCTIVE=1` and pass `--project destructive`. It then depends on preflight and fixtures only.

Gates: `VARNISH_ENV=production` removes fixtures and destructive. `VARNISH_SKIP_DESTRUCTIVE=1` removes destructive. `VARNISH_SKIP_BROWSER=1` removes the browser projects. `@edge` tests only run with `VARNISH_INCLUDE_EDGE=1`. `VARNISH_ONLY_DESTRUCTIVE=1` detaches destructive from the per store projects.

Tags:

- `@smoke`: a fast subset that proves the setup works.
- `@readonly`: no side effects, safe on production.
- `@fixtures`: needs the fixture accounts.
- `@destructive`: changes cache or data.
- `@edge`: known quirks.
- `@project`: overlay specs.

Examples:

```
npx playwright test -c base/playwright.config.ts --grep @smoke
npx playwright test -c base/playwright.config.ts --project request:nl
npx playwright test -c base/playwright.config.ts --grep @readonly --project request:default
VARNISH_INCLUDE_EDGE=1 npx playwright test -c base/playwright.config.ts --grep @edge
```

## 6. Fixtures

The package ships `bin/magento varnish:test:fixtures` with three actions:

- `create --spec=<json> --output=<state.json>` creates the customers described in the spec file. Without `--spec`, the simple options `--website`, `--group`, `--count` and `--attribute key=value` build the spec.
- `cleanup --output=<state.json>` removes the customers from the state file. `cleanup --all` removes every customer that matches the fixture email pattern.
- `touch --sku=<sku>` and `touch --category=<id>` re-save a catalog entity without changing it, so Magento emits its tag purge.

Emails follow the pattern `varnish-test+w<website>-g<group>-<n>@example.com`. First and last names carry a random token (`Vtf<token>`, `Vtl<token>`). The PII scan of shared cache objects uses those emails, names and the customer token as markers.

On production like environments without CLI access, set `VARNISH_FIXTURE_MODE=provided` and pass existing accounts through `VARNISH_ACCOUNT_<KEY>_EMAIL` and `_PASSWORD`. Add `_FIRSTNAME` and `_LASTNAME` so the PII scan knows what to look for.

## 7. Hooks

`hooks.ts` in the overlay exports a default object that implements any of:

```ts
import type { Hooks } from './base/lib/fixtures';

const hooks: Hooks = {
    async beforeLogin(page) {},
    async declineOptionalCookies(page) {},
    async acceptAllCookies(page) {},
    async switchCurrency(page, code) {},
    async backendDown() {},
    async backendUp() {},
};

export default hooks;
```

`beforeLogin` runs before the browser login (close a consent bar, dismiss a popup). `declineOptionalCookies` and `acceptAllCookies` drive the consent banner for the consent tests. `switchCurrency` drives the currency switcher of the theme. `backendDown` and `backendUp` stop and start the backend (for example `magebox stop php` or a `docker stop`) for the grace test. A test that needs a hook the project did not implement skips itself with a message that names the hook.

## 8. Project specs

Put project specific specs in `specs/*.spec.ts` inside the overlay. They import the fixtures from the synced copy:

```ts
import { test, expect, tags } from '../base/lib/fixtures';
```

They run in the `project:<store>` project, once per store. They get the same fixtures as the built in specs: `cfg`, `store`, `pages`, `cache`, `magento`, `accounts` and `hooks`. Tag them `@project`.

## 9. Local prerequisites

- `system/full_page_cache/caching_application` is 2 (Varnish). The preflight fails otherwise.
- `http_cache_hosts` is set in `app/etc/env.php`, for example `bin/magento setup:config:set --http-cache-hosts=127.0.0.1:6081`. Without it, Magento purges never reach Varnish and the purge tests fail.
- The generated VCL is loaded: `bin/magento varnish:vcl:generate --export-version=6 --input-file=vendor/elgentos/magento2-varnish-extended/etc/varnish6.vcl --output-file=/path/varnish6.vcl`, then `varnishadm vcl.load` and `vcl.use`.
- `catalog/frontend/remember_pagination` is 0. The preflight fails otherwise, because the toolbar then stores state in the session.
- The purge ACL (admin: Stores, System, Full Page Cache, Access list) contains the IP that Magento purges from. When the test machine is in that list too, set `VARNISH_PURGE_CLIENT_IN_ACL=1`. When it is not, leave the variable unset. The suite then proves that PURGE and forced refresh are refused.

## 10. Test catalog

| ID | Purpose |
| --- | --- |
| N01 | Trailing slash is stripped from the cache key: `/path` and `/path/` share one object. |
| N02 | An empty query string (`/path?`) shares the object of `/path`. |
| N03 | Query parameters are sorted: `?b=2&a=1` shares the object of `?a=1&b=2`. |
| N04 | Every configured tracking parameter is stripped: the URL with the parameter shares the object of the bare URL. |
| N05 | An unknown parameter is kept and gets its own object. |
| N06 | A port in the Host header is removed before hashing. |
| N07 | The home page keeps `/` as its key and is not confused with an empty path. |
| N08 | A tracking parameter in the middle of the query string leaves no dangling `&` or `?`. |
| N09 | A tracking parameter combined with a real parameter keeps the real parameter. |
| H01 | `X-Magento-Cache-Debug` reports MISS then HIT for a cacheable page. |
| H02 | Browser `Cache-Control` is `must-revalidate, max-age=60`. With bfcache off it also carries `no-store`. |
| H03 | Headers listed in `strippedResponseHeaders` never reach the client. |
| H04 | `Vary` only carries values from `allowedVaryHeaders`. |
| H05 | `Age` grows between two hits on the same object. |
| H06 | Cacheable responses carry no `Set-Cookie`. |
| H07 | HEAD is served from the same object as GET. |
| C01 | An arbitrary cookie does not change the cache key. |
| C02 | A different `X-Magento-Vary` cookie value gets its own object. |
| C03 | A cookie that matches `pass_on_cookie_presence` makes the request pass (UNCACHEABLE). |
| C04 | Several `Cookie` headers are collapsed and parsed as one. |
| U01 | Every path in `uncacheablePaths` is never served from cache. |
| U02 | The admin path is never served from cache. |
| U03 | POST requests pass to the backend. |
| U04 | `health_check.php` bypasses the cache. |
| U05 | `customer/section/load` is private and never a HIT. |
| U06 | Redirect responses are not cached. |
| P01 | The cart section returns fresh data on every request. |
| P02 | Every path in `privateUrls` is never a HIT. |
| S01 | With `cache404` on, a 404 is cached. With it off, a 404 is uncacheable. |
| S02 | 301 and 302 responses are UNCACHEABLE. |
| S03 | 5xx responses are not stored. |
| S04 | The search result page is cacheable. |
| G01 | An anonymous GraphQL GET query is cached. |
| G02 | A `Bearer` token without `X-Magento-Cache-Id` passes. |
| G03 | `X-Magento-Cache-Id` is part of the key, so different ids get different objects. |
| G04 | `Store` and `Content-Currency` headers are part of the GraphQL key. |
| M01 | The Host header is part of the key: the same path on two stores gives two objects. |
| M02 | Each configured store serves its own content from cache. |
| M03 | A store switch sets `X-Magento-Vary` and separates the objects. |
| R01 | Parallel requests for a cold URL cause one backend fetch (request coalescing). |
| E01 | Known quirk: a tracking parameter value with characters outside the strip regex survives. |
| E02 | Known quirk: trailing slash normalization combined with a query string. |
| E03 | Known quirk: a lone `?` with following `&`. |
| E04 | Known quirk: Host header handling for IPv6 literals. |
| B01 | Two fresh guests receive identical normalized HTML (no per visitor data). |
| B02 | A guest visit sets no cookie that fragments the cache. |
| L01 | Login sets the `X-Magento-Vary` cookie. |
| L02 | A logged in customer gets a different object than a guest. |
| L03 | Two customers in the same group share an object. |
| L04 | A customer in another group gets a separate object. |
| L05 | Logout clears `X-Magento-Vary` and returns to the guest object. |
| L06 | `loggedInMarkers` show the correct state on cached pages. |
| I01 | After a customer browsed, guests see no personal data of that customer in any encoding. |
| I02 | Private sections are not shared between two customers. |
| V01 | `conditionalUrls`: the entitled customer gets 200, the guest gets `guestStatus`, and the guest answer is not served to the customer. |
| V02 | `priceAssertions`: each group sees its own prices. |
| W01 | The currency switch sets `X-Magento-Vary` and shows the switched currency. |
| W02 | A switched currency does not leak into the guest object. |
| W03 | The store switcher lands on the other store's object. |
| W04 | Switching back returns to the shared object. |
| T01 | A browser visit with tracking parameters lands on a cached object. |
| T02 | The tracking parameters stay visible to JavaScript in the browser. |
| F01 | With the bfcache flag on, back and forward navigation restores the page from bfcache. |
| K01 | Declining optional cookies keeps the page cacheable. |
| K02 | Accepting all cookies does not fragment the cache. |
| D01 | Saving a product invalidates its page. The home page status is annotated. |
| D02 | Saving a category invalidates its page. The product page status is annotated. |
| D03 | `cache:clean full_page` empties every page in `pageSet`. |
| D04 | PURGE from a client outside the ACL is refused with 405. |
| D05 | PURGE with `X-Magento-Tags-Pattern` from an allowed client returns `{"invalidated": N}` and empties the cache. |
| D06 | A soft purge serves HIT-GRACE and then a fresh object. |
| D07 | Cached pages are served while the backend is down (hooks `backendDown` and `backendUp`). |
| D08 | `Cache-Control: no-cache` gives MISS-FORCED for the purge ACL and is ignored for anyone else. |

## 11. Reading failures

Every assertion prints a request summary: method, URL, status, cache debug, `Age`, `Cache-Control`, `Set-Cookie`, `Vary`, `Content-Type` and `Location`. Read the summary before the stack trace.

Common findings:

- `Vary` cookie missing after login: a consent or cookie filter drops `X-Magento-Vary`, or the login did not set it because the customer context has no variations. Logged in content then shares the guest object.
- A private URL is a HIT: the response lacks `Cache-Control: private` or `no-cache`, so Varnish stored it.
- Guest parity mismatch: the page contains per visitor data that `normalize.stripRegexes` does not cover. Typical cases are a session id, a form key printed server side or a timestamp. A block can also render differently per visitor.
- A cached 404 reaches an entitled customer: the guest answer was stored without the customer context in the key. Make sure that the page sets the vary data or is private.
- A purge does not arrive: `http_cache_hosts` is missing from `env.php`, the Magento host is not in the purge ACL, or a proxy in front of Varnish swallows PURGE. D04 and D05 tell the two cases apart.
- MISS-FORCED for a stranger: the purge ACL is wider than intended. Any client can bypass the cache.
- HIT-GRACE missing after a soft purge: `use_xkey_vmod` or `use_soft_purging` is off, or the grace period is 0.
