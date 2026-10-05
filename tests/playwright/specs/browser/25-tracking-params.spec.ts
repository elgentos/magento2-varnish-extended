import { Response } from '@playwright/test';
import { test, expect, tags } from '../../lib/fixtures';
import { cacheStatusOf, expectCacheStatus } from '../../lib/http';

/*
 * Tracking parameters and tracking cookies.
 *
 * The VCL strips marketing parameters (gclid, utm_*, ...) from the URL before hashing, so a
 * campaign visitor hits the object that organic visitors warmed, while the browser keeps the
 * original URL for the analytics scripts. Analytics cookies must not make a request bypass the
 * cache either.
 */

test.describe('tracking parameters', () => {
    test('T01 campaign parameters hit the organic object and stay in the browser URL', { tag: [tags.smoke] }, async (
        { page, cfg, pages, cache },
        testInfo
    ) => {
        const params = cfg.trackingParamsToAssert.length > 0 ? cfg.trackingParamsToAssert : ['gclid'];
        const url = cache.withBuster(pages.home);
        const warmed = await cache.warm(url);
        expectCacheStatus(warmed.hot, ['HIT', 'HIT-GRACE'], 'home page could not be warmed for a guest');

        const query = params.map((p, i) => `${p}=${i === 0 ? 'test123' : '1'}`).join('&');
        const response = await page.goto(`${url}&${query}`);
        expect(response, 'no document response').not.toBeNull();
        const status = cacheStatusOf(await (response as Response).allHeaders());
        testInfo.annotations.push({ type: 'cache', description: `${query}: ${status}` });
        expect(
            ['HIT', 'HIT-GRACE'],
            `request with ${params.join(', ')} is ${status}: tracking parameters are not stripped before hashing`
        ).toContain(status);

        const search = await page.evaluate(() => location.search);
        expect(search, 'browser URL lost the tracking parameter: Varnish or Magento redirected to a cleaned URL')
            .toContain(`${params[0]}=test123`);
    });

    test('T02 analytics cookies do not bypass the cache', { tag: [tags.readonly] }, async (
        { page, context, cfg, pages, cache, baseURL },
        testInfo
    ) => {
        const cookies = [
            { name: '_ga', value: 'GA1.1.1' },
            { name: '_gid', value: '1' },
            { name: 'cookieconsent', value: '1' },
        ];
        const header = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
        test.skip(
            cfg.flags.passOnCookieRegexes.some((pattern) => new RegExp(pattern).test(header)),
            'a passOnCookieRegexes entry matches these cookies on purpose'
        );

        const url = cache.withBuster(pages.home);
        const warmed = await cache.warm(url);
        expectCacheStatus(warmed.hot, ['HIT', 'HIT-GRACE'], 'home page could not be warmed for a guest');

        await context.addCookies(cookies.map((c) => ({ ...c, url: baseURL as string })));
        const response = await page.goto(url);
        expect(response, 'no document response').not.toBeNull();
        const status = cacheStatusOf(await (response as Response).allHeaders());
        testInfo.annotations.push({ type: 'cache', description: `with ${header}: ${status}` });
        expect(
            ['HIT', 'HIT-GRACE'],
            `request with analytics cookies is ${status}: a cookie rule passes requests that carry tracking cookies`
        ).toContain(status);
    });
});
