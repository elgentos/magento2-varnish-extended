import { Request, Response } from '@playwright/test';
import { test, expect, tags, requirePage } from '../../lib/fixtures';
import { cacheStatusOf } from '../../lib/http';

/*
 * Back/forward cache.
 *
 * With flags.bfcache the VCL sends "must-revalidate, max-age=60", so a back navigation may be
 * restored from the browser's bfcache (no request), served from the browser HTTP cache (no
 * request) or refetched (which must then be a Varnish HIT). Without the flag the VCL adds
 * no-store, so going back always refetches and must still be a HIT.
 *
 * Headless Chromium under Playwright usually runs with bfcache disabled, so "restored from
 * bfcache" is reported through annotations instead of being required.
 */

declare global {
    interface Window {
        __varnishPersisted?: boolean;
    }
}

test.describe('bfcache', () => {
    test('F01 going back to a category is restored or served as a HIT', { tag: [tags.readonly] }, async (
        { page, cfg, pages, cache, baseURL },
        testInfo
    ) => {
        const category = requirePage(pages, 'category');
        const product = requirePage(pages, 'product');
        const categoryUrl = new URL(cache.withBuster(category).replace(/^\//, ''), baseURL).toString();
        const productUrl = cache.withBuster(product);

        await page.addInitScript(() => {
            window.addEventListener('pageshow', (event) => {
                window.__varnishPersisted = (event as PageTransitionEvent).persisted;
            });
        });

        const categoryRequests: Request[] = [];
        const categoryResponses: Response[] = [];
        page.on('request', (request) => {
            if (request.resourceType() === 'document' && request.url() === categoryUrl) {
                categoryRequests.push(request);
            }
        });
        page.on('response', (response) => {
            if (response.request().resourceType() === 'document' && response.url() === categoryUrl) {
                categoryResponses.push(response);
            }
        });

        const first = await page.goto(categoryUrl, { waitUntil: 'load' });
        expect(first, 'no document response for the category').not.toBeNull();
        const firstStatus = cacheStatusOf(await (first as Response).allHeaders());
        expect(['MISS', 'HIT', 'HIT-GRACE'], `category is ${firstStatus}: not cacheable, bfcache test meaningless`)
            .toContain(firstStatus);
        const cacheControl = ((await (first as Response).allHeaders())['cache-control'] ?? '').toLowerCase();
        testInfo.annotations.push({ type: 'cache-control', description: cacheControl || '(none)' });

        await page.goto(productUrl, { waitUntil: 'load' });

        const requestsBefore = categoryRequests.length;
        const responsesBefore = categoryResponses.length;
        await page.goBack({ waitUntil: 'load' });
        await page.waitForURL(categoryUrl, { timeout: 30000 });

        const persisted = await page.evaluate(() => window.__varnishPersisted === true);
        const navigationType = await page.evaluate(() => {
            const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
            return entry?.type ?? 'unknown';
        });
        const newRequests = categoryRequests.length - requestsBefore;
        const newResponses = categoryResponses.slice(responsesBefore);
        testInfo.annotations.push({
            type: 'back',
            description: `persisted=${persisted} navigation=${navigationType} documentRequests=${newRequests}`,
        });

        if (newResponses.length === 0) {
            if (!cfg.flags.bfcache) {
                expect(
                    newRequests,
                    'bfcache flag is off (no-store expected) but going back made no document request: ' +
                        `the browser restored the page anyway (cache-control: "${cacheControl}")`
                ).toBeGreaterThan(0);
            }
            testInfo.annotations.push({
                type: 'back',
                description: persisted ? 'restored from bfcache' : 'served from the browser HTTP cache (max-age=60)',
            });
            return;
        }

        const back = newResponses[newResponses.length - 1];
        const backHeaders = await back.allHeaders();
        const backStatus = cacheStatusOf(backHeaders);
        const firstDate = (await (first as Response).allHeaders())['date'];
        if (backHeaders['date'] && backHeaders['date'] === firstDate) {
            // Chromium replayed the first response from its HTTP cache (max-age=60), headers included.
            testInfo.annotations.push({ type: 'back', description: 'served from the browser HTTP cache (same Date header)' });
        } else {
            expect(
                ['HIT', 'HIT-GRACE'],
                `the back navigation refetched the category and got ${backStatus}: ` +
                    'the object was lost between two page views'
            ).toContain(backStatus);
        }

        // A reload revalidates with Varnish: the object stored on the first view must still be there.
        const reload = await page.reload({ waitUntil: 'load' });
        const reloadStatus = cacheStatusOf(await (reload as Response).allHeaders());
        expect(
            ['HIT', 'HIT-GRACE'],
            `reloading the category after going back got ${reloadStatus}: the object was lost between two page views`
        ).toContain(reloadStatus);
    });
});
