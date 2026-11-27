import { test, expect, tags } from '../../lib/fixtures';
import { CacheClient, expectCacheStatus, expectNoSetCookie, normalizeHtml } from '../../lib/http';

/*
 * Objects must be separated per store (Host is part of the hash), and the site-wide text files
 * robots.txt and sitemap.xml must be cacheable without cookies.
 */

const smoke = { tag: [tags.smoke] };
const readonly = { tag: [tags.readonly] };
const htmlLang = (body: string): string | null => body.match(/<html[^>]*\blang=["']([^"']+)["']/i)?.[1] ?? null;

test('M01 the same path on another store is a separate object', smoke, async ({ cache, cfg, store, pages }) => {
    test.skip(cfg.stores.length < 2, 'only one store configured');
    const otherStore = cfg.stores.find((s) => s.code !== store.code) as (typeof cfg.stores)[number];
    const other = new CacheClient(otherStore, cfg);

    const path = pages.product ?? pages.home;
    const url = cache.withBuster(path);
    test.skip(cache.url(url) === other.url(url), `stores "${store.code}" and "${otherStore.code}" share host and path`);

    const { cold, hot } = await cache.warm(url);
    expectCacheStatus(cold, 'MISS');
    expectCacheStatus(hot, 'HIT');

    const foreign = await other.get(url);
    expectCacheStatus(
        foreign,
        'MISS',
        `the object warmed on ${cache.host} was served for ${other.host}: the Host header is not part of the hash`
    );
    if (foreign.status !== 200) {
        return;
    }
    const currencyDiffers =
        store.currency !== null && otherStore.currency !== null && store.currency !== otherStore.currency;
    const differs =
        htmlLang(hot.body) !== htmlLang(foreign.body) ||
        currencyDiffers ||
        normalizeHtml(hot.body, cfg.normalize) !== normalizeHtml(foreign.body, cfg.normalize);
    expect(
        differs,
        `stores "${store.code}" and "${otherStore.code}" render an identical page: are they really different stores?`
    ).toBe(true);
});

test('M02 robots.txt is cached without cookies', readonly, async ({ cache }) => {
    const { cold, hot } = await cache.warm('/robots.txt');
    expect(hot.status, 'robots.txt must answer 200').toBe(200);
    expectNoSetCookie(cold, 'robots.txt must not set cookies');
    expectNoSetCookie(hot, 'robots.txt must not set cookies');
    expect(
        hot.cacheStatus,
        'robots.txt is UNCACHEABLE: Magento sends no-cache or a cookie for a public text file'
    ).not.toBe('UNCACHEABLE');
    expectCacheStatus(hot, ['HIT', 'HIT-GRACE'], 'robots.txt is requested by every crawler and must be cached');
});

test('M03 sitemap.xml answers without cookies', readonly, async ({ cache }) => {
    const res = await cache.get('/sitemap.xml');
    expect([200, 404], 'sitemap.xml must answer 200 or 404').toContain(res.status);
    if (res.status === 200 || res.cacheStatus === 'HIT' || res.cacheStatus === 'HIT-GRACE') {
        expectNoSetCookie(res, 'sitemap.xml must not set cookies');
    }
});
