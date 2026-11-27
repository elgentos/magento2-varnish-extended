import { test, expect, tags } from '../../lib/fixtures';
import { assetUrls, expectCacheStatus, expectNoSetCookie, expectNotHit } from '../../lib/http';

/*
 * Paths that must never be served from the shared cache: cart, checkout, account, section loads,
 * admin, POSTs and the health check. Static and media assets follow their own flags.
 */

const smoke = { tag: [tags.smoke] };
const readonly = { tag: [tags.readonly] };
const hasNoStore = (cacheControl: string | undefined): boolean => /no-store|no-cache/i.test(cacheControl ?? '');

test('U01 configured uncacheable paths are never a HIT', smoke, async ({ cache, cfg }, testInfo) => {
    test.skip(cfg.uncacheablePaths.length === 0, 'uncacheablePaths is empty');

    for (const path of cfg.uncacheablePaths) {
        const { cold, hot } = await cache.warm(path);
        if (hot.status === 404) {
            testInfo.annotations.push({
                type: 'note',
                description: `${path} answers 404; it is not an uncacheable endpoint on this store`,
            });
            continue;
        }
        expectNotHit(cold, `${path} must never be served from cache`);
        expectNotHit(hot, `${path} was served from cache on the second request: a per-user page is shared`);
        if (hot.status === 200) {
            expect(
                hasNoStore(hot.headers['cache-control']) || hot.cacheStatus === 'UNCACHEABLE',
                `${path} answers 200 without no-store/no-cache and is not marked UNCACHEABLE; ` +
                    `Varnish stores it for default_ttl\n  cache-control: ${hot.headers['cache-control']}`
            ).toBe(true);
        }
    }
});

test('U02 customer section load is never cached', smoke, async ({ cache, cfg }) => {
    const path = `${cfg.paths.sectionLoad}?sections=cart`;
    const { cold, hot } = await cache.warm(path, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });

    expect(hot.status, 'section load must answer 200').toBe(200);
    expectNotHit(cold, 'customer/section/load must never be a HIT: it returns per-session cart and customer data');
    expectNotHit(hot, 'customer/section/load must never be a HIT: it returns per-session cart and customer data');
    expect(hot.headers['content-type'] ?? '', 'section load must answer JSON').toContain('json');
    expect(
        hasNoStore(hot.headers['cache-control']),
        `section load must send no-store or no-cache, got "${hot.headers['cache-control']}"`
    ).toBe(true);
});

test('U03 the admin path is never a HIT', smoke, async ({ cache, cfg }, testInfo) => {
    const { cold, hot } = await cache.warm(cfg.adminPath);
    if (cold.status === 404) {
        testInfo.annotations.push({
            type: 'info',
            description: `${cfg.adminPath} answers 404 on this store (admin is not served here); a cached 404 is acceptable`,
        });
        return;
    }
    expectNotHit(cold, 'admin must never be served from cache');
    expectNotHit(hot, 'admin was served from cache: the admin login page or a redirect is shared between users');
});

test('U04 a POST is never a HIT', smoke, async ({ cache, pages }) => {
    const res = await cache.post(pages.home, { form: { a: '1' } });
    expectCacheStatus(
        res,
        ['UNCACHEABLE', 'MISS', 'MISS-FORCED', 'UNKNOWN'],
        'a POST must be passed to the backend (vcl_recv must return pass for non GET/HEAD)'
    );
    expectNotHit(res, 'a POST was answered from cache');
});

test('U05 the health check is never a HIT', smoke, async ({ cache, cfg }) => {
    const { cold, hot } = await cache.warm(cfg.paths.healthCheck);
    expectNotHit(cold, 'health_check.php must bypass the cache');
    expectNotHit(hot, 'health_check.php was served from cache: an unhealthy backend would still look healthy');
});

test('U06 static and media assets follow their cache flags', readonly, async ({ cache, cfg, pages }, testInfo) => {
    const { hot } = await cache.warm(cache.withBuster(pages.home));
    const assets = assetUrls(hot.body, cache.baseUrl);
    test.skip(
        assets.static.length === 0 && assets.media.length === 0,
        'no same-origin static or media URLs found on the home page'
    );

    const groups: Array<{ kind: 'static' | 'media'; urls: string[]; cached: boolean }> = [
        { kind: 'static', urls: assets.static, cached: cfg.flags.staticCache },
        { kind: 'media', urls: assets.media, cached: cfg.flags.mediaCache },
    ];
    for (const group of groups) {
        for (const url of group.urls) {
            const { cold, hot: second } = await cache.warm(url);
            expectNoSetCookie(cold, `${group.kind} asset must not set cookies`);
            expectNoSetCookie(second, `${group.kind} asset must not set cookies`);
            if (second.status !== 200) {
                testInfo.annotations.push({ type: 'note', description: `${url} answers ${second.status}` });
                continue;
            }
            if (group.cached) {
                expectCacheStatus(
                    second,
                    ['HIT', 'HIT-GRACE'],
                    `${group.kind} cache is enabled but ${url} is not served from cache (VCL not regenerated?)`
                );
            } else {
                expectNotHit(cold, `${group.kind} cache is disabled but ${url} is served from cache`);
                expectNotHit(second, `${group.kind} cache is disabled but ${url} is served from cache`);
            }
        }
    }
});
