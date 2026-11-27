import { APIResponse, Browser, BrowserContext, Page, PlaywrightTestOptions, Response } from '@playwright/test';
import { test, expect, tags, requirePage, requireAccount, Hooks } from '../../lib/fixtures';
import { cacheStatusOf } from '../../lib/http';
import { VarnishConfig } from '../../lib/config';
import { Account, accountRoles, isLoggedInViaSection, loginViaBrowser } from '../../lib/magento';

/*
 * Private content.
 *
 * Everything personal (customer name, cart) is loaded through customer/section/load, which must
 * never be cached: two customers must each see their own section data, and a guest's cart must not
 * leak into the shared product page object or into another guest's section data.
 */

type Credentials = PlaywrightTestOptions['httpCredentials'];

interface SectionData {
    customer?: { firstname?: string };
    cart?: { summary_count?: number };
}

async function newVisitor(
    browser: Browser, baseURL: string | undefined, httpCredentials: Credentials
): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext({ baseURL, httpCredentials, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    return { context, page };
}

async function login(page: Page, cfg: VarnishConfig, hooks: Hooks, account: Account): Promise<void> {
        await loginViaBrowser(page, cfg, account, hooks);
    expect(await isLoggedInViaSection(page, cfg), `login as ${account.key} failed`).toBe(true);
}

async function loadSections(
    page: Page, cfg: VarnishConfig, sections: string
): Promise<{ response: APIResponse; data: SectionData }> {
    const response = await page.request.get(
        `${cfg.paths.sectionLoad}?sections=${sections}&force_new_section_timestamp=true`,
        { headers: { 'X-Requested-With': 'XMLHttpRequest' } }
    );
    expect(response.status(), `section load ${sections} failed`).toBe(200);
    return { response, data: (await response.json()) as SectionData };
}

function expectPrivate(response: APIResponse, who: string): void {
    const headers = response.headers();
    const status = cacheStatusOf(headers);
    expect(
        ['HIT', 'HIT-GRACE'],
        `customer/section/load for ${who} was served from cache (${status}): private data shared`
    ).not.toContain(status);
    const cacheControl = (headers['cache-control'] ?? '').toLowerCase();
    expect(
        /no-store|no-cache/.test(cacheControl),
        `customer/section/load for ${who} is missing no-store/no-cache (cache-control: "${cacheControl}"): ` +
            'browsers may cache it'
    ).toBe(true);
}

test.describe('private content', () => {
    test('V01 section load is private per customer', { tag: [tags.fixtures] }, async (
        { browser, baseURL, httpCredentials, page, cfg, hooks, accounts, store },
        testInfo
    ) => {
        const roles = accountRoles(accounts, store);
        const a = requireAccount(roles.a, 'customer A');
        const b = requireAccount(roles.b ?? roles.other, 'a second customer');

        await login(page, cfg, hooks, a);
        const visitorB = await newVisitor(browser, baseURL, httpCredentials);
        try {
            await login(visitorB.page, cfg, hooks, b);

            const sectionA = await loadSections(page, cfg, 'customer,cart');
            const sectionB = await loadSections(visitorB.page, cfg, 'customer,cart');
            expectPrivate(sectionA.response, a.key);
            expectPrivate(sectionB.response, b.key);

            const nameA = sectionA.data.customer?.firstname ?? '';
            const nameB = sectionB.data.customer?.firstname ?? '';
            testInfo.annotations.push({ type: 'section', description: `${a.key}=${nameA} ${b.key}=${nameB}` });
            expect(nameA, `no customer.firstname in section data for ${a.key}`).not.toBe('');
            expect(nameB, `no customer.firstname in section data for ${b.key}`).not.toBe('');
            if (a.firstname) {
                expect(nameA, `${a.key} received someone else's customer section`).toBe(a.firstname);
            }
            if (b.firstname) {
                expect(nameB, `${b.key} received someone else's customer section`).toBe(b.firstname);
            }
            if (a.firstname && b.firstname && a.firstname !== b.firstname) {
                expect(
                    nameA !== nameB,
                    'both customers received the same customer section: section load is shared'
                ).toBe(true);
            }
        } finally {
            await visitorB.context.close();
        }
    });

    test('V02 a guest cart does not leak into the shared product object', { tag: [tags.smoke] }, async (
        { browser, baseURL, httpCredentials, page, cfg, pages, cache },
        testInfo
    ) => {
        const product = requirePage(pages, 'product');
        test.skip(!cfg.selectors.addToCart, 'selectors.addToCart is not configured');
        const url = cache.withBuster(product);

        const first = await page.goto(url);
        expect(first, 'no document response for the product page').not.toBeNull();
        const firstStatus = cacheStatusOf(await (first as Response).allHeaders());
        testInfo.annotations.push({ type: 'cache', description: `guest 1 product: ${firstStatus}` });
        expect(['MISS', 'HIT', 'HIT-GRACE'], `product page is ${firstStatus} for a guest: not cacheable`)
            .toContain(firstStatus);

        const button = page.locator(cfg.selectors.addToCart).first();
        const present = (await button.count()) > 0;
        test.skip(!present, `add-to-cart button "${cfg.selectors.addToCart}" not found on the product page`);
        test.skip(!(await button.isEnabled()), 'add-to-cart button is disabled (out of stock or required options)');

        const sectionAfterAdd = page
            .waitForResponse((r) => r.url().includes(cfg.paths.sectionLoad), { timeout: cfg.timeouts.sectionLoadMs })
            .catch(() => null);
        await button.click();
        await sectionAfterAdd;
        await page.waitForLoadState('load');

        const cartA = await loadSections(page, cfg, 'cart');
        expectPrivate(cartA.response, 'guest 1');
        const countA = cartA.data.cart?.summary_count ?? 0;
        expect(
            countA,
            'guest 1 cart is empty after add-to-cart: product needs options, or the cart section is served stale/cached'
        ).toBeGreaterThanOrEqual(1);

        const guest2 = await newVisitor(browser, baseURL, httpCredentials);
        try {
            const doc = await guest2.page.goto(url);
            const status = cacheStatusOf(await (doc as Response).allHeaders());
            expect(
                ['HIT', 'HIT-GRACE'],
                `guest 2 got ${status}: the product page object was invalidated or bypassed by guest 1's add-to-cart`
            ).toContain(status);
            const cartB = await loadSections(guest2.page, cfg, 'cart');
            expectPrivate(cartB.response, 'guest 2');
            const countB = cartB.data.cart?.summary_count ?? 0;
            expect(countB, 'guest 2 sees items in its cart: cart section shared between guests').toBe(0);
        } finally {
            await guest2.context.close();
        }
    });
});
