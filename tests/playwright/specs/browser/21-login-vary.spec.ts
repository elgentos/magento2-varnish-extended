import { Browser, BrowserContext, Page, PlaywrightTestOptions, Response } from '@playwright/test';
import { test, expect, tags, requirePage, requireAccount, Hooks } from '../../lib/fixtures';
import { CacheStatus, cacheStatusOf, normalizeHtml } from '../../lib/http';
import { Pages, StoreConfig, VarnishConfig } from '../../lib/config';
import { Account, accountRoles, isLoggedInViaSection, loginViaBrowser, loginViaRequest } from '../../lib/magento';

/*
 * Login and the X-Magento-Vary cookie.
 *
 * Varnish hashes the X-Magento-Vary cookie value into the object key. Customers in the same
 * context (group, currency, store) share one object, guests another. Without the cookie a
 * logged-in customer is served the guest object and vice versa.
 *
 * Browser HTTP cache: cacheable pages carry "must-revalidate, max-age=60", so the second fetch
 * of a URL in one context is done with page.reload(), which always goes to the network.
 */

type Credentials = PlaywrightTestOptions['httpCredentials'];

async function newVisitor(
    browser: Browser, baseURL: string | undefined, httpCredentials: Credentials
): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext({ baseURL, httpCredentials, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    return { context, page };
}

async function statusOf(response: Response | null): Promise<CacheStatus> {
    expect(response, 'navigation produced no document response').not.toBeNull();
    return cacheStatusOf(await (response as Response).allHeaders());
}

async function varyCookie(context: BrowserContext): Promise<string | null> {
    return (await context.cookies()).find((c) => c.name === 'X-Magento-Vary')?.value ?? null;
}

async function login(page: Page, cfg: VarnishConfig, hooks: Hooks, account: Account): Promise<void> {
        await loginViaBrowser(page, cfg, account, hooks);
    expect(
        await isLoggedInViaSection(page, cfg),
        `login as ${account.key} did not produce a customer section: wrong credentials, captcha or account not approved`
    ).toBe(true);
}

function resolvePagePath(pages: Pages, key: string): string | null {
    if (key.startsWith('/')) {
        return key;
    }
    return pages[key as keyof Pages] ?? null;
}

function priceAssertionsFor(cfg: VarnishConfig, store: StoreConfig): VarnishConfig['priceAssertions'] {
    return cfg.priceAssertions.filter((p) => !p.store || p.store === store.code);
}

async function readPrice(page: Page, cfg: VarnishConfig, selector?: string): Promise<string> {
    const text = await page.locator(selector ?? cfg.selectors.price).first().innerText({ timeout: 10000 });
    return text.trim();
}

const noVaryMessage =
    'login did not set X-Magento-Vary: consent manager or cookie filter blocks it, ' +
    'logged-in users will receive guest cache objects';

test.describe('login and X-Magento-Vary', () => {
    test('L01 login sets X-Magento-Vary and the customer gets a cacheable object', { tag: [tags.fixtures] }, async (
        { page, context, cfg, hooks, accounts, store, pages, cache },
        testInfo
    ) => {
        const product = requirePage(pages, 'product');
        const a = requireAccount(accountRoles(accounts, store).a, 'a logged-in customer');

        await login(page, cfg, hooks, a);
        const vary = await varyCookie(context);
        expect(vary, noVaryMessage).not.toBeNull();
        testInfo.annotations.push({ type: 'vary', description: `X-Magento-Vary=${vary}` });

        const url = cache.withBuster(product);
        const first = await statusOf(await page.goto(url));
        expect(first, 'first logged-in request must be a MISS on a fresh buster').toBe('MISS');
        const second = await statusOf(await page.reload());
        expect(
            ['HIT', 'HIT-GRACE'],
            `reload as logged-in customer is ${second}: logged-in pages are not cached ` +
                '(session cookie passes, no-cache header?)'
        ).toContain(second);
    });

    test('L02 two customers in the same group share one cache object', { tag: [tags.fixtures] }, async (
        { browser, baseURL, httpCredentials, page, context, cfg, hooks, accounts, store, pages, cache },
        testInfo
    ) => {
        const product = requirePage(pages, 'product');
        const roles = accountRoles(accounts, store);
        const a = requireAccount(roles.a, 'customer A');
        const b = requireAccount(roles.b, 'customer B in the same group as A');

        await login(page, cfg, hooks, a);
        const varyA = await varyCookie(context);
        expect(varyA, noVaryMessage).not.toBeNull();
        const url = cache.withBuster(product);
        const docA = await page.goto(url);
        expect(await statusOf(docA)).toBe('MISS');
        const bodyA = await (docA as Response).text();

        const visitorB = await newVisitor(browser, baseURL, httpCredentials);
        try {
            await login(visitorB.page, cfg, hooks, b);
            const varyB = await varyCookie(visitorB.context);
            expect(varyB, noVaryMessage).not.toBeNull();
            testInfo.annotations.push({ type: 'vary', description: `A=${varyA} B=${varyB}` });
            test.skip(
                varyA !== varyB,
                'A and B carry different X-Magento-Vary values: this project varies per customer, not per group'
            );

            const docB = await visitorB.page.goto(url);
            const statusB = await statusOf(docB);
            expect(
                ['HIT', 'HIT-GRACE'],
                `customer B got ${statusB} on the object customer A warmed: ` +
                    'same vary cookie but no shared object (hash data?)'
            ).toContain(statusB);
            expect(
                normalizeHtml(await (docB as Response).text(), cfg.normalize) === normalizeHtml(bodyA, cfg.normalize),
                'A and B received different bodies from the same cache object'
            ).toBe(true);
        } finally {
            await visitorB.context.close();
        }
    });

    test('L03 a guest gets its own object and its own prices', { tag: [tags.fixtures] }, async (
        { browser, baseURL, httpCredentials, page, context, cfg, hooks, accounts, store, pages, cache },
        testInfo
    ) => {
        const product = requirePage(pages, 'product');
        const a = requireAccount(accountRoles(accounts, store).a, 'a logged-in customer');

        await login(page, cfg, hooks, a);
        expect(await varyCookie(context), noVaryMessage).not.toBeNull();
        const url = cache.withBuster(product);
        const docA = await page.goto(url);
        expect(await statusOf(docA)).toBe('MISS');
        const bodyA = await (docA as Response).text();

        const guest = await newVisitor(browser, baseURL, httpCredentials);
        try {
            const docG = await guest.page.goto(url);
            const statusG = await statusOf(docG);
            expect(
                ['MISS', 'HIT', 'HIT-GRACE'],
                `guest request is ${statusG}: product page not cacheable for guests`
            ).toContain(statusG);
            expect(
                statusG,
                'guest was served the logged-in customer\'s object: X-Magento-Vary is not part of the hash'
            ).toBe('MISS');
            const bodyG = await (docG as Response).text();

            const assertions = priceAssertionsFor(cfg, store);
            const productAssertion = assertions.find(
                (p) => resolvePagePath(pages, p.page) === product && p.expect.guest && p.expect[a.key]
                    && p.expect.guest !== p.expect[a.key]
            );
            if (productAssertion) {
                expect(
                    normalizeHtml(bodyG, cfg.normalize) !== normalizeHtml(bodyA, cfg.normalize),
                    'guest and logged-in product bodies are identical although priceAssertions expect different ' +
                        'prices: customer group pricing is not rendered or the wrong object is served'
                ).toBe(true);
            }

            for (const assertion of assertions) {
                const path = resolvePagePath(pages, assertion.page);
                if (!path) {
                    continue;
                }
                const target = cache.withBuster(path);
                if (assertion.expect.guest) {
                    await guest.page.goto(target);
                    const price = await readPrice(guest.page, cfg, assertion.selector);
                    testInfo.annotations.push({ type: 'price', description: `${assertion.page} guest: ${price}` });
                    expect(price, `guest price on ${assertion.page} is not the configured guest price`)
                        .toContain(assertion.expect.guest);
                }
                if (assertion.expect[a.key]) {
                    await page.goto(target);
                    const price = await readPrice(page, cfg, assertion.selector);
                    testInfo.annotations.push({ type: 'price', description: `${assertion.page} ${a.key}: ${price}` });
                    expect(
                        price,
                        `price for ${a.key} on ${assertion.page} is not the configured price: ` +
                            'customer served the guest object?'
                    ).toContain(assertion.expect[a.key]);
                }
            }
        } finally {
            await guest.context.close();
        }
    });

    test('L04 logout returns the browser to the guest variant', { tag: [tags.fixtures] }, async (
        { browser, baseURL, httpCredentials, page, context, cfg, hooks, accounts, store, pages, cache },
        testInfo
    ) => {
        const product = requirePage(pages, 'product');
        const a = requireAccount(accountRoles(accounts, store).a, 'a logged-in customer');

        await login(page, cfg, hooks, a);
        const varyBefore = await varyCookie(context);
        expect(varyBefore, noVaryMessage).not.toBeNull();

        await page.goto(cfg.paths.logout, { waitUntil: 'load' });
        await page.waitForURL((u) => !u.pathname.endsWith(cfg.paths.logout.replace(/\/$/, '')), { timeout: 30000 });
        const stillLoggedIn = await isLoggedInViaSection(page, cfg);
        expect(stillLoggedIn, 'customer section still reports a customer after logout').toBe(false);

        const varyAfter = await varyCookie(context);
        testInfo.annotations.push({ type: 'vary', description: `before=${varyBefore} after=${varyAfter ?? '(none)'}` });
        expect(
            varyAfter === null || varyAfter !== varyBefore,
            'X-Magento-Vary unchanged after logout: the logged-out browser keeps receiving the customer cache objects'
        ).toBe(true);

        const url = cache.withBuster(product);
        expect(await statusOf(await page.goto(url)), 'logged-out browser must warm a fresh object').toBe('MISS');

        const guest = await newVisitor(browser, baseURL, httpCredentials);
        try {
            // Settle guest cookies first (a project may hand guests a vary cookie through section load).
            const settled = guest.page
                .waitForResponse((r) => r.url().includes(cfg.paths.sectionLoad), {
                    timeout: cfg.timeouts.sectionLoadMs,
                })
                .catch(() => null);
            await guest.page.goto(pages.home);
            await settled;
            const statusG = await statusOf(await guest.page.goto(url));
            expect(
                ['HIT', 'HIT-GRACE'],
                `fresh guest got ${statusG} on the object the logged-out browser warmed: ` +
                    'logout leaves a non-guest vary cookie'
            ).toContain(statusG);
        } finally {
            await guest.context.close();
        }
    });

    test('L05 logged-in markers render correctly on a cache HIT', { tag: [tags.fixtures] }, async (
        { page, context, cfg, hooks, accounts, store, pages, cache }
    ) => {
        const markers = cfg.loggedInMarkers.filter((m) => !m.store || m.store === store.code);
        test.skip(markers.length === 0, 'no loggedInMarkers configured for this store');
        const a = requireAccount(accountRoles(accounts, store).a, 'a logged-in customer');

        await login(page, cfg, hooks, a);
        expect(await varyCookie(context), noVaryMessage).not.toBeNull();

        const byPage = new Map<string, typeof markers>();
        for (const marker of markers) {
            byPage.set(marker.page, [...(byPage.get(marker.page) ?? []), marker]);
        }

        for (const [pageKey, pageMarkers] of byPage) {
            const path = resolvePagePath(pages, pageKey);
            if (!path) {
                continue;
            }
            const url = cache.withBuster(path);
            expect(await statusOf(await page.goto(url)), `${pageKey}: first request must be a MISS`).toBe('MISS');
            const second = await statusOf(await page.reload());
            expect(['HIT', 'HIT-GRACE'], `${pageKey}: reload is ${second}, cannot verify markers on a HIT`)
                .toContain(second);
            expect(await isLoggedInViaSection(page, cfg), 'session lost between requests').toBe(true);

            for (const marker of pageMarkers) {
                const locator = page.locator(marker.selector).first();
                const expected = marker.visibleWhenLoggedIn ? 'visible' : 'hidden';
                const message =
                    `${pageKey} "${marker.selector}" should be ${expected} for a logged-in customer: ` +
                    'server-side session check on a cached page: logged-in users see guest UI';
                if (marker.visibleWhenLoggedIn) {
                    await expect(locator, message).toBeVisible();
                } else {
                    await expect(locator, message).toBeHidden();
                }
            }
        }
    });

    test('L06 loginPost sets X-Magento-Vary in its own response', { tag: [tags.fixtures] }, async (
        { cfg, cache, accounts, store },
        testInfo
    ) => {
        const a = requireAccount(accountRoles(accounts, store).a, 'a logged-in customer');
        const session = await loginViaRequest(cache, cfg, a);
        try {
            const location = session.response.headers['location'] ?? '';
            testInfo.annotations.push({
                type: 'login',
                description: `${session.response.status} -> ${location}; ` +
                    `set-cookie: ${session.response.setCookies.length}`,
            });
            expect(session.response.status, 'loginPost did not redirect: login failed or form key rejected').toBe(302);
            expect(
                location.includes('/customer/account/login'),
                `loginPost bounced back to the login page (${location})`
            ).toBe(false);
            const varyHeader = session.response.setCookies.find((c) => c.startsWith('X-Magento-Vary='));
            expect(
                varyHeader ?? session.varyCookie,
                'loginPost response carries no X-Magento-Vary Set-Cookie: ' +
                    'the vary plugin is disabled or a filter strips it'
            ).toBeTruthy();
        } finally {
            await session.context.dispose();
        }
    });
});
