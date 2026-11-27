import { BrowserContext, Page, Response } from '@playwright/test';
import { test, expect, tags, requireAccount } from '../../lib/fixtures';
import { CacheStatus, cacheStatusOf, expectCacheStatus, expectNotHit, findPii, splitCredentials } from '../../lib/http';
import { StoreConfig, VarnishConfig, pagesFor } from '../../lib/config';
import { accountRoles, isLoggedInViaSection, loginViaBrowser } from '../../lib/magento';

/*
 * Store and currency switchers.
 *
 * A currency switch changes the X-Magento-Vary cookie, so the browser moves to another set of
 * cache objects while the objects it visited before stay untouched. Switching store by URL must
 * land on the other store (the Host header is part of the hash) without bouncing back.
 */

async function statusOf(response: Response | null): Promise<CacheStatus> {
    expect(response, 'navigation produced no document response').not.toBeNull();
    return cacheStatusOf(await (response as Response).allHeaders());
}

async function varyCookie(context: BrowserContext): Promise<string | null> {
    return (await context.cookies()).find((c) => c.name === 'X-Magento-Vary')?.value ?? null;
}

async function readPrice(page: Page, cfg: VarnishConfig): Promise<string | null> {
    try {
        return (await page.locator(cfg.selectors.price).first().innerText({ timeout: 10000 })).trim();
    } catch {
        return null;
    }
}

function otherStore(cfg: VarnishConfig, store: StoreConfig): StoreConfig | null {
    return cfg.stores.find((s) => s.code !== store.code) ?? null;
}

function absoluteUrl(store: StoreConfig, path: string): string {
    return new URL(path.replace(/^\//, ''), splitCredentials(store.baseUrl).baseUrl).toString();
}

test.describe('switchers', () => {
    test('W01 currency switch moves the browser to new objects, old ones untouched', { tag: [tags.readonly] }, async (
        { page, context, cfg, store, pages, cache, hooks },
        testInfo
    ) => {
        test.skip(!store.currency, 'stores[].currency is not configured for this store');
        const target = cfg.stores
            .find((s) => s.code !== store.code && s.currency && s.currency !== store.currency)?.currency ?? null;
        test.skip(!target, 'no other store with a different currency to switch to');
        const code = target as string;
        const path = pages.product ?? pages.home;

        const beforeUrl = cache.withBuster(path);
        const warmed = await cache.warm(beforeUrl);
        expectCacheStatus(warmed.hot, ['HIT', 'HIT-GRACE'], 'pre-switch object could not be warmed');
        await page.goto(beforeUrl);
        const priceBefore = pages.product ? await readPrice(page, cfg) : null;

        if (hooks.switchCurrency) {
            await hooks.switchCurrency(page, code);
        } else {
            const switched = await page.goto(cfg.paths.currencySwitch.replace('{code}', code));
            expect(switched, 'currency switch produced no response').not.toBeNull();
            expect(
                (switched as Response).request().redirectedFrom(),
                `currency switch did not redirect: switcher disabled or paths.currencySwitch does not match (${code})`
            ).not.toBeNull();
        }

        const vary = await varyCookie(context);
        testInfo.annotations.push({
            type: 'vary',
            description: vary
                ? `X-Magento-Vary=${vary}`
                : 'no X-Magento-Vary after currency switch: currency is not in the HTTP context, ' +
                    'switched visitors share objects with the default currency',
        });

        const afterUrl = cache.withBuster(path);
        expect(await statusOf(await page.goto(afterUrl)), 'fresh buster after switch must be a MISS').toBe('MISS');
        const second = await statusOf(await page.reload());
        expect(['HIT', 'HIT-GRACE'], `reload after currency switch is ${second}: switched visitors are not cached`)
            .toContain(second);

        if (pages.product && priceBefore) {
            const priceAfter = await readPrice(page, cfg);
            testInfo.annotations.push({ type: 'price', description: `before=${priceBefore} after=${priceAfter}` });
            expect(
                priceAfter,
                `price text unchanged after switching to ${code}: switch had no effect or the old object is served`
            ).not.toBe(priceBefore);
        }

        const untouched = await cache.get(beforeUrl);
        expectCacheStatus(
            untouched,
            ['HIT', 'HIT-GRACE'],
            'the pre-switch object was evicted or replaced by the currency switch'
        );
    });

    test('W02 another store can be opened directly without bouncing back', { tag: [tags.readonly] }, async (
        { page, cfg, store, cache },
        testInfo
    ) => {
        const other = otherStore(cfg, store);
        test.skip(!other, 'only one store configured');
        const otherPages = pagesFor(cfg, other as StoreConfig);
        const url = absoluteUrl(other as StoreConfig, cache.withBuster(otherPages.product ?? otherPages.home));
        const expectedHost = new URL(splitCredentials((other as StoreConfig).baseUrl).baseUrl).host;

        const first = await page.goto(url);
        expect(first, 'no document response from the other store').not.toBeNull();
        expect((first as Response).status(), `other store ${url} did not answer 200`).toBe(200);
        expect(
            new URL(page.url()).host,
            `browser was bounced from ${expectedHost} to ${new URL(page.url()).host}: store cookie or website redirect`
        ).toBe(expectedHost);
        testInfo.annotations.push({ type: 'cache', description: `first: ${await statusOf(first)}` });

        const second = await statusOf(await page.reload());
        expect(['HIT', 'HIT-GRACE'], `second load on the other store is ${second}: page not cached there`)
            .toContain(second);
    });

    test('W03 ___store parameter creates a separate object', { tag: [tags.edge] }, async (
        { cfg, store, pages, cache },
        testInfo
    ) => {
        const other = otherStore(cfg, store);
        test.skip(!other, 'only one store configured');
        const path = pages.product ?? pages.home;
        const buster = cache.buster();
        const plainUrl = cache.withBuster(path, buster);

        const withStore = await cache.get(cache.withQuery(plainUrl, `___store=${(other as StoreConfig).code}`));
        testInfo.annotations.push({
            type: 'cache',
            description: `___store request: ${withStore.status} ${withStore.cacheStatus}`,
        });
        expectNotHit(withStore, 'the ___store request was served from an existing object');

        const plain = await cache.get(plainUrl);
        expectCacheStatus(plain, 'MISS', 'the plain URL was warmed by the ___store request: must be separate objects');
    });

    test('W04 shared cookie domain does not leak customer data into another store', { tag: [tags.fixtures] }, async (
        { page, context, cfg, store, cache, hooks, accounts },
        testInfo
    ) => {
        test.skip(!cfg.flags.cookieDomain, 'flags.cookieDomain is not set');
        const other = otherStore(cfg, store);
        test.skip(!other, 'only one store configured');
        const a = requireAccount(accountRoles(accounts, store).a, 'a logged-in customer');

                await loginViaBrowser(page, cfg, a, hooks);
        expect(await isLoggedInViaSection(page, cfg), `login as ${a.key} failed`).toBe(true);

        const otherPages = pagesFor(cfg, other as StoreConfig);
        const otherBase = splitCredentials((other as StoreConfig).baseUrl).baseUrl;
        const url = absoluteUrl(other as StoreConfig, cache.withBuster(otherPages.product ?? otherPages.home));
        const doc = await page.goto(url);
        expect(doc, 'no document response from the other store').not.toBeNull();
        const headers = await (doc as Response).allHeaders();
        testInfo.annotations.push({
            type: 'cache',
            description: `other store: ${(doc as Response).status()} ${cacheStatusOf(headers)}`,
        });

        const markers = [a.email, a.firstname, a.lastname, a.token].filter((v): v is string => Boolean(v));
        const hits = findPii(await (doc as Response).text(), markers, cfg.pii.checkEncodings);
        expect(
            hits,
            'customer data from this store rendered into the other store\'s shared object (shared cookie domain)'
        ).toEqual([]);

        const shared = await context.cookies(otherBase);
        const names = shared.map((c) => c.name).join(', ') || 'none';
        testInfo.annotations.push({
            type: 'cookies',
            description: `cookies sent to ${new URL(otherBase).host}: ${names}`,
        });
    });
});
