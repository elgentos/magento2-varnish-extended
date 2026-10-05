import { createHash } from 'crypto';
import { test, expect, tags } from '../../lib/fixtures';
import { CacheClient, CacheResponse, expectCacheStatus, expectNotHit } from '../../lib/http';

/*
 * GraphQL: GET queries are cacheable per X-Magento-Cache-Id + Store + Content-Currency, authenticated
 * requests without a cache id are passed, and POSTs are never cached. Magento only lets Varnish store a
 * response when the request's X-Magento-Cache-Id equals the one Magento computes, so the tests first
 * learn that id from a probe request and fall back to a synthetic one when Magento does not send it.
 */

const smoke = { tag: [tags.smoke] };
const readonly = { tag: [tags.readonly] };
const STORE_CODE_QUERY = '{storeConfig{store_code}}';
const STORE_LOCALE_QUERY = '{storeConfig{store_code,locale}}';
const FALLBACK_CACHE_ID = createHash('sha256').update('varnish-test').digest('hex');

const graphqlUrl = (cache: CacheClient, path: string, query: string): string =>
    cache.withBuster(`${path}?query=${encodeURIComponent(query)}`);

const cacheIdFor = async (cache: CacheClient, path: string, query: string, storeCode: string): Promise<string> => {
    const probe = await cache.get(graphqlUrl(cache, path, query), { headers: { Store: storeCode } });
    return probe.headers['x-magento-cache-id'] || FALLBACK_CACHE_ID;
};

const storeCodeIn = (res: CacheResponse): string | null => {
    try {
        const parsed = JSON.parse(res.body) as { data?: { storeConfig?: { store_code?: string } } };
        return parsed.data?.storeConfig?.store_code ?? null;
    } catch {
        return null;
    }
};

test('G01 a GraphQL GET with a cache id is cached', smoke, async ({ cache, cfg, store }) => {
    const cacheId = await cacheIdFor(cache, cfg.paths.graphql, STORE_CODE_QUERY, store.code);
    const url = graphqlUrl(cache, cfg.paths.graphql, STORE_CODE_QUERY);
    const headers = { 'X-Magento-Cache-Id': cacheId, Store: store.code };
    const { cold, hot } = await cache.warm(url, { headers });

    test.skip(
        cold.status !== 200 || cold.cacheStatus === 'UNCACHEABLE',
        `GraphQL GET answered ${cold.status} [${cold.cacheStatus}]: GraphQL is disabled or the response is uncacheable`
    );
    expect(hot.status).toBe(200);
    expectCacheStatus(cold, 'MISS');
    expectCacheStatus(hot, ['HIT', 'HIT-GRACE'], 'a GraphQL GET with a matching X-Magento-Cache-Id must be cached');
    expect(storeCodeIn(hot), 'the cached GraphQL body must carry the requested store code').toBe(store.code);
});

test('G02 an authenticated GraphQL GET without a cache id is passed', smoke, async ({ cache, cfg, store }) => {
    const url = graphqlUrl(cache, cfg.paths.graphql, STORE_CODE_QUERY);
    const headers = { Authorization: 'Bearer invalidtoken', Store: store.code };
    const { cold, hot } = await cache.warm(url, { headers });
    expectNotHit(cold, 'Authorization: Bearer without X-Magento-Cache-Id must be passed to the backend');
    expectNotHit(
        hot,
        'an authenticated GraphQL request was served from cache: a customer-specific result is shared across tokens'
    );
});

test('G03 a GraphQL POST is never cached', smoke, async ({ cache, cfg, store }) => {
    const options = {
        headers: { 'Content-Type': 'application/json', Store: store.code },
        data: { query: STORE_CODE_QUERY },
    };
    const first = await cache.post(cfg.paths.graphql, options);
    const second = await cache.post(cfg.paths.graphql, options);
    expectNotHit(first, 'a GraphQL POST must be passed');
    expectNotHit(second, 'a GraphQL POST was served from cache');
});

test('G04 the Store header separates GraphQL objects', readonly, async ({ cache, cfg, store }, testInfo) => {
    test.skip(cfg.stores.length < 2, 'only one store configured');
    const other = cfg.stores.find((s) => s.code !== store.code) as (typeof cfg.stores)[number];

    const currentId = await cacheIdFor(cache, cfg.paths.graphql, STORE_LOCALE_QUERY, store.code);
    const otherId = await cacheIdFor(cache, cfg.paths.graphql, STORE_LOCALE_QUERY, other.code);
    const url = graphqlUrl(cache, cfg.paths.graphql, STORE_LOCALE_QUERY);
    const otherHeaders = { 'X-Magento-Cache-Id': otherId, Store: other.code };

    const current = await cache.get(url, { headers: { 'X-Magento-Cache-Id': currentId, Store: store.code } });
    const foreign = await cache.get(url, { headers: otherHeaders });
    if (foreign.status !== 200 || storeCodeIn(foreign) === null) {
        testInfo.annotations.push({
            type: 'note',
            description: `store "${other.code}" is not reachable through this host (${foreign.status})`,
        });
        test.skip(true, `store "${other.code}" cannot be requested through ${cache.host}`);
    }

    expectNotHit(current, 'first request for the current store must be its own object');
    expectNotHit(foreign, 'first request for the other store must be its own object (Store header not hashed)');
    expect(storeCodeIn(current), 'current store body must carry the current store code').toBe(store.code);
    expect(storeCodeIn(foreign), 'the other store body must carry the other store code').toBe(other.code);

    const foreignAgain = await cache.get(url, { headers: otherHeaders });
    if (foreignAgain.cacheStatus === 'HIT' || foreignAgain.cacheStatus === 'HIT-GRACE') {
        expect(
            storeCodeIn(foreignAgain),
            'the cached object for the other store must still carry its store code'
        ).toBe(other.code);
    }
});
