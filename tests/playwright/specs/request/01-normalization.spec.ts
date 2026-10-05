import { test, expect, tags, requirePage } from '../../lib/fixtures';
import { expectCacheStatus, expectNotHit } from '../../lib/http';

/*
 * URL normalization in vcl_recv / vcl_hash:
 *   - a trailing "?" is removed
 *   - the port is removed from the Host header
 *   - query parameters are sorted (only when there is more than one)
 *   - tracking parameters are stripped
 *   - a trailing "/" is ignored in the hash (only at the very end of req.url)
 * Every cold-path test owns its cache object through a unique "unknown" parameter (the buster).
 */

const smoke = { tag: [tags.smoke] };
const readonly = { tag: [tags.readonly] };
const randomValue = (): string => Math.random().toString(36).slice(2, 10);

test('N01 home page with a fresh buster: MISS then HIT', smoke, async ({ cache, pages }) => {
    const url = cache.withBuster(pages.home);
    const { cold, hot } = await cache.warm(url);

    expect(cold.status, 'home page must answer 200').toBe(200);
    expect(hot.status, 'home page must answer 200 from cache').toBe(200);
    expectCacheStatus(
        cold,
        'MISS',
        'first request on a unique URL must be a MISS (Varnish not in front, or a stale debug header)'
    );
    expectCacheStatus(hot, 'HIT', 'second request on the same URL must be a HIT: the home page is not cacheable');
});

test('N02 trailing "?" is stripped and does not create a second object', smoke, async ({ cache, pages }) => {
    const plain = await cache.get(`${pages.home}?`);
    expect(plain.status, 'GET home with a bare trailing "?" must answer 200').toBe(200);
    expectCacheStatus(
        plain,
        ['HIT', 'HIT-GRACE', 'MISS'],
        'a bare "?" must be removed in vcl_recv so the request maps onto the plain home object'
    );

    // The warmed buster is still a HIT when requested again unchanged (the trailing "&" case is E05).
    const url = cache.withBuster(pages.home);
    const { cold, hot } = await cache.warm(url);
    expectCacheStatus(cold, 'MISS');
    expectCacheStatus(hot, 'HIT');
});

test('N03 query parameters are sorted before hashing', smoke, async ({ cache, pages }) => {
    const buster = cache.buster();
    const warmUrl = cache.withQuery(pages.home, `a=1&b=2&${buster}`);
    const { cold, hot } = await cache.warm(warmUrl);
    expectCacheStatus(cold, 'MISS');
    expectCacheStatus(hot, 'HIT');

    const reordered = await cache.get(cache.withQuery(pages.home, `b=2&${buster}&a=1`));
    expect(reordered.status).toBe(200);
    expectCacheStatus(
        reordered,
        ['HIT', 'HIT-GRACE'],
        'the same parameters in another order must hit the same object (std.querysort missing or not applied)'
    );
});

test('N04 trailing slash on a product path maps onto the same object', smoke, async ({ cache, pages }) => {
    const product = requirePage(pages, 'product');
    test.skip(product.includes('?'), 'product path has a query string; the trailing slash with a query is E04');
    const bare = product.replace(/\/+$/, '');
    test.skip(bare === '', 'product path is the root');

    // Real URL without a buster: the cache may already be warm, so only the second response is asserted.
    const warm = await cache.warm(bare);
    expect(warm.cold.status, 'product page must answer 200').toBe(200);
    expectCacheStatus(warm.hot, ['HIT', 'HIT-GRACE'], 'product page must be cacheable');

    const slashed = await cache.get(`${bare}/`);
    expectCacheStatus(
        slashed,
        ['HIT', 'HIT-GRACE'],
        'vcl_hash strips the trailing slash, so "/p/" must be served from the "/p" object'
    );
    expect(slashed.status, 'the trailing-slash variant must serve the same (200) object').toBe(warm.hot.status);
});

test('N05 tracking parameters are stripped from the cache key', smoke, async ({ cache, cfg, pages }) => {
    test.skip(cfg.trackingParamsToAssert.length === 0, 'trackingParamsToAssert is empty');
    const url = cache.withBuster(pages.home);
    const { cold, hot } = await cache.warm(url);
    expectCacheStatus(cold, 'MISS');
    expectCacheStatus(hot, 'HIT');

    for (const param of cfg.trackingParamsToAssert) {
        const res = await cache.get(`${url}&${param}=abc123`);
        expect(res.status).toBe(200);
        expectCacheStatus(
            res,
            ['HIT', 'HIT-GRACE'],
            `"${param}" is not in the generated tracking parameter list: every ad click creates a new cache object`
        );
    }

    const all = cfg.trackingParamsToAssert.map((p) => `${p}=abc123`).join('&');
    const combined = await cache.get(`${url}&${all}`);
    expect(combined.status).toBe(200);
    expectCacheStatus(
        combined,
        ['HIT', 'HIT-GRACE'],
        'all tracking parameters at once must collapse onto the warmed object (regsuball + trailing "&" cleanup)'
    );
});

test('N06 an unknown parameter creates a separate object', smoke, async ({ cache, cfg, pages }) => {
    const url = cache.withBuster(pages.home);
    const { cold, hot } = await cache.warm(url);
    expectCacheStatus(cold, 'MISS');
    expectCacheStatus(hot, 'HIT');

    const other = await cache.get(`${url}&${cfg.unknownParam}2=${randomValue()}`);
    expect(other.status).toBe(200);
    expectCacheStatus(
        other,
        'MISS',
        'an unknown query parameter must not be stripped: Varnish ignores the query string, ' +
            'which breaks filters and pagination'
    );
});

test('N07 HEAD fills the cache and a following GET is served with a body', readonly, async ({ cache, pages }) => {
    const url = cache.withBuster(pages.home);
    const head = await cache.head(url);
    expect(head.status).toBe(200);
    expectCacheStatus(head, 'MISS', 'HEAD on a unique URL must be a MISS');

    const get = await cache.get(url);
    expect(get.status).toBe(200);
    expectCacheStatus(
        get,
        ['HIT', 'HIT-GRACE'],
        'GET after HEAD must hit the object fetched for the HEAD (Varnish fetches with GET)'
    );
    expect(
        get.body.length,
        'the GET after a HEAD must carry a body; an empty body means a bodiless object was stored'
    ).toBeGreaterThan(0);
});

test('N08 a port in the Host header is ignored', readonly, async ({ cache, pages }) => {
    const url = cache.withBuster(pages.home);
    const plain = await cache.get(url);
    const withPort = await cache.get(url, { headers: { Host: `${cache.host.replace(/:\d+$/, '')}:443` } });

    expect(
        withPort.status,
        `Host with ":443" answered ${withPort.status} while the plain request answered ${plain.status}: ` +
            'the port must be removed from the Host header before hashing and before Magento resolves the store'
    ).toBe(plain.status);
    expect([400, 404], 'a Host header with a port must not be rejected').not.toContain(withPort.status);
});

test('N09 an upper-cased path is not served as the lower-cased page', readonly, async ({ cache, pages }) => {
    const product = requirePage(pages, 'product');
    const upper = product.replace(/^[^?]*/, (p) => p.toUpperCase());
    test.skip(upper === product, 'product path has no letters to upper-case');

    const res = await cache.get(cache.withBuster(upper));
    expectNotHit(res, 'an upper-cased path with a fresh buster can never be a HIT');
    expect(
        [301, 302, 404],
        `GET ${res.url} answered ${res.status}: Magento URLs are case sensitive, a 200 means the lower-cased ` +
            'page was served for the upper-cased path (Varnish or Magento is lower-casing the URL)'
    ).toContain(res.status);
});
