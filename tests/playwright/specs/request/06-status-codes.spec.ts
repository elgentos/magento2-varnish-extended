import { test, expect, tags } from '../../lib/fixtures';
import { expectCacheStatus, expectNotHit } from '../../lib/http';
import { loginViaRequest } from '../../lib/magento';

/*
 * Non-200 responses: 404s are cached only when enable_404_cache is on, redirects are never cached,
 * and a cached guest 404 must never be served to a customer who is entitled to see the page.
 */

const smoke = { tag: [tags.smoke] };
const readonly = { tag: [tags.readonly] };
const fixtures = { tag: [tags.fixtures] };

test('S01 a 404 is cached only when enable_404_cache is on', smoke, async ({ cache, cfg, pages }) => {
    const url = cache.withBuster(pages.notFound);
    const { cold, hot } = await cache.warm(url);
    expect(cold.status, `${pages.notFound} must answer 404`).toBe(404);
    expect(hot.status, `${pages.notFound} must answer 404 on the second request`).toBe(404);

    if (cfg.flags.cache404) {
        expectCacheStatus(
            hot,
            ['HIT', 'HIT-GRACE'],
            'enable_404_cache is on but the second 404 was not a HIT ' +
                '(VCL not regenerated, or the 404 page sets cookies/no-cache)'
        );
    } else {
        expectNotHit(cold, 'enable_404_cache is off but a 404 was served from cache');
        expectNotHit(hot, 'enable_404_cache is off but a 404 was served from cache');
    }
});

test('S02 the account redirect for guests is not cached', smoke, async ({ cache }) => {
    const res = await cache.get('/customer/account/');
    expect([301, 302], 'guest GET /customer/account/ must redirect to the login page').toContain(res.status);
    expect(res.headers['location'], 'a redirect must carry a Location header').toBeDefined();
    expectNotHit(res, 'a redirect was served from cache: beresp.status != 200 must be uncacheable');
});

test('S03 a cached guest 404 is not served to an entitled customer', fixtures, async (
    { cache, cfg, store, accounts },
    testInfo
) => {
    const urls = cfg.conditionalUrls.filter((c) => !c.store || c.store === store.code);
    test.skip(urls.length === 0, 'conditionalUrls is empty for this store');

    let checked = 0;
    for (const conditional of urls) {
        const account = accounts[conditional.visibleTo];
        if (!account) {
            testInfo.annotations.push({
                type: 'skipped-url',
                description: `no fixture account "${conditional.visibleTo}" for ${conditional.url}`,
            });
            continue;
        }
        checked++;

        const { cold, hot } = await cache.warm(conditional.url);
        const guestMessage = `guest GET ${conditional.url} must answer ${conditional.guestStatus}`;
        expect(cold.status, guestMessage).toBe(conditional.guestStatus);
        expect(hot.status, guestMessage).toBe(conditional.guestStatus);

        const session = await loginViaRequest(cache, cfg, account);
        try {
            const res = await cache.get(conditional.url, { context: session.context });
            expect(
                res.status,
                `cached guest ${conditional.guestStatus} served to entitled user "${conditional.visibleTo}" on ` +
                    `${conditional.url}: the login must set X-Magento-Vary so the customer gets its own object`
            ).toBe(200);
        } finally {
            await session.context.dispose();
        }
    }
    test.skip(checked === 0, 'no fixture account matches any conditionalUrls[].visibleTo');
});

test('S04 tracking parameters on a 404 map onto the same object', readonly, async ({ cache, cfg, pages }) => {
    const url = cache.withBuster(pages.notFound);
    const { cold, hot } = await cache.warm(url);
    expect(cold.status).toBe(404);
    expect(hot.status).toBe(404);

    const tracked = await cache.get(`${url}&gclid=abc`);
    expect(tracked.status, 'the tracked 404 must still be a 404').toBe(404);
    if (cfg.flags.cache404) {
        expectCacheStatus(
            tracked,
            ['HIT', 'HIT-GRACE'],
            'gclid must be stripped on 404s too, otherwise every ad click stores a new 404 object'
        );
    } else {
        expectNotHit(tracked, 'enable_404_cache is off but a 404 was served from cache');
    }
});
