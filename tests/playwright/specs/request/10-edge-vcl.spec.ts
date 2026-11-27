import { test, expect, tags, requirePage } from '../../lib/fixtures';
import { expectCacheStatus } from '../../lib/http';

/*
 * Documented VCL quirks. Each test asserts the intended behaviour and is marked with test.fail(),
 * so it is reported as "expected failure" today and as an unexpected pass once the VCL is fixed.
 * They only run with VARNISH_INCLUDE_EDGE=1.
 *
 * Relevant VCL (vcl_recv / vcl_hash):
 *   if (req.url ~ "\?.+&.+") { set req.url = std.querysort(req.url); }
 *   if (req.url ~ "(\?|&)(<tracking>)=") {
 *       set req.url = regsuball(req.url, "(<tracking>)=[-_A-z0-9+(){}%.]+&?", "");
 *       set req.url = regsub(req.url, "[?|&]+$", "");
 *   }
 *   hash_data(regsub(req.url, "\/$", ""));
 */

const edge = { tag: [tags.edge] };
const trackingParam = (params: string[], preferred: string): string =>
    params.includes(preferred) ? preferred : params[0];

test('E01 a tracking value with "~" is stripped completely', edge, async ({ cache, cfg, pages }) => {
    test.skip(cfg.trackingParamsToAssert.length === 0, 'trackingParamsToAssert is empty');
    test.fail(true, 'known VCL quirk: the value class [-_A-z0-9+(){}%.] lacks "~", so "a~b" leaves "~b" in the URL');
    const param = trackingParam(cfg.trackingParamsToAssert, 'utm_campaign');

    const url = cache.withBuster(pages.home);
    const { cold, hot } = await cache.warm(url);
    expectCacheStatus(cold, 'MISS');
    expectCacheStatus(hot, 'HIT');

    const res = await cache.get(`${url}&${param}=a~b`);
    expectCacheStatus(res, ['HIT', 'HIT-GRACE'], `${param}=a~b must be stripped entirely and hit the warmed object`);
});

test('E02 a parameter that merely ends in a tracking name is kept', edge, async ({ cache, cfg, pages }) => {
    test.skip(cfg.trackingParamsToAssert.length === 0, 'trackingParamsToAssert is empty');
    test.fail(
        true,
        'known VCL quirk: regsuball has no (\\?|&) anchor, so "xgclid=1" is mangled into "x" once a real ' +
            'tracking parameter triggers the strip'
    );
    const param = trackingParam(cfg.trackingParamsToAssert, 'gclid');

    const url = `${cache.withBuster(pages.home)}&x${param}=1`;
    const { cold, hot } = await cache.warm(url);
    expectCacheStatus(cold, 'MISS');
    expectCacheStatus(hot, 'HIT');

    const res = await cache.get(`${url}&${param}=2`);
    expectCacheStatus(
        res,
        ['HIT', 'HIT-GRACE'],
        `only ${param}=2 must be stripped; x${param}=1 must survive so the request maps onto the warmed object`
    );
});

test('E03 a tracking parameter with an empty value is stripped', edge, async ({ cache, cfg, pages }) => {
    test.skip(cfg.trackingParamsToAssert.length === 0, 'trackingParamsToAssert is empty');
    test.fail(true, 'known VCL quirk: the value class requires at least one character, so "gclid=" is not stripped');
    const param = trackingParam(cfg.trackingParamsToAssert, 'gclid');

    const url = cache.withBuster(pages.home);
    const { cold, hot } = await cache.warm(url);
    expectCacheStatus(cold, 'MISS');
    expectCacheStatus(hot, 'HIT');

    const res = await cache.get(`${url}&${param}=`);
    expectCacheStatus(res, ['HIT', 'HIT-GRACE'], `${param}= (empty value) must be stripped and hit the warmed object`);
});

test('E04 a trailing slash before the query string is normalized', edge, async ({ cache, pages }) => {
    const product = requirePage(pages, 'product');
    test.skip(product.includes('?'), 'product path already has a query string');
    const bare = product.replace(/\/+$/, '');
    test.skip(bare === '', 'product path is the root');
    test.fail(
        true,
        'known VCL quirk: vcl_hash only strips "/" at the very end of req.url, ' +
            'so "/p/?x" and "/p?x" are different objects'
    );

    const buster = cache.buster();
    const { cold, hot } = await cache.warm(`${bare}?${buster}`);
    expectCacheStatus(cold, 'MISS');
    expectCacheStatus(hot, 'HIT');

    const slashed = await cache.get(`${bare}/?${buster}`);
    expect(slashed.status).toBe(200);
    expectCacheStatus(slashed, ['HIT', 'HIT-GRACE'], '"/p/?x" must be served from the "/p?x" object');
});

test('E05 a trailing "&" is normalized', edge, async ({ cache, pages }) => {
    test.fail(
        true,
        'known VCL quirk: querysort only runs for "\\?.+&.+" and the trailing "&" cleanup ' +
            'only runs in the tracking branch'
    );

    const url = cache.withBuster(pages.home);
    const { cold, hot } = await cache.warm(url);
    expectCacheStatus(cold, 'MISS');
    expectCacheStatus(hot, 'HIT');

    const res = await cache.get(`${url}&`);
    expect(res.status).toBe(200);
    expectCacheStatus(res, ['HIT', 'HIT-GRACE'], '"?x&" must map onto the "?x" object');
});
