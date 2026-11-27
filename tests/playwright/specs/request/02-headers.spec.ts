import { test, expect, tags } from '../../lib/fixtures';
import {
    expectCacheControlFor,
    expectCacheStatus,
    expectNoSetCookie,
    expectStrippedHeaders,
    expectVaryAllowlist,
    extractFormKeyValues,
    hasLiteralEsi,
    normalizeHtml,
} from '../../lib/http';

/*
 * Response headers on cacheable pages: what vcl_deliver strips and rewrites, and what the
 * cached HTML must never contain (ESI tags, server-side form keys, private content versions).
 */

const smoke = { tag: [tags.smoke] };
const readonly = { tag: [tags.readonly] };
const KNOWN_DEBUG_VALUES = ['HIT', 'MISS', 'HIT-GRACE', 'MISS-FORCED', 'UNCACHEABLE'];

test('H01 cached pages carry none of the stripped headers', smoke, async ({ cache, cfg, pageSet }) => {
    for (const { key, path } of pageSet) {
        const { cold, hot } = await cache.warm(cache.withBuster(path));
        expect(hot.status, `${key} (${path}) must answer 200`).toBe(200);
        expectCacheStatus(hot, ['HIT', 'HIT-GRACE'], `${key} must be cacheable`);
        expectStrippedHeaders(hot, cfg.strippedResponseHeaders);
        expectStrippedHeaders(cold, cfg.strippedResponseHeaders);
        for (const res of [cold, hot]) {
            const debug = res.headers['x-magento-cache-debug'];
            if (debug !== undefined) {
                expect(
                    KNOWN_DEBUG_VALUES,
                    `${key}: X-Magento-Cache-Debug "${debug}" is not a value this VCL emits (another VCL or proxy)`
                ).toContain(debug.toUpperCase().trim());
            }
        }
    }
});

test('H02 Cache-Control on a HIT follows the bfcache setting', smoke, async ({ cache, cfg, pages }) => {
    const { hot } = await cache.warm(cache.withBuster(pages.home));
    expectCacheStatus(hot, ['HIT', 'HIT-GRACE']);
    expectCacheControlFor(hot, cfg.flags);
});

test('H03 Vary only carries allow-listed values', smoke, async ({ cache, cfg, pageSet }) => {
    for (const { key, path } of pageSet) {
        const { hot } = await cache.warm(cache.withBuster(path));
        expectCacheStatus(hot, ['HIT', 'HIT-GRACE'], `${key} must be cacheable`);
        expectVaryAllowlist(hot, cfg.allowedVaryHeaders);
    }
});

test('H04 Age is present and grows between two HITs', smoke, async ({ cache, pages }) => {
    const url = cache.withBuster(pages.home);
    const { cold, hot } = await cache.warm(url);
    expectCacheStatus(cold, 'MISS');
    expectCacheStatus(hot, 'HIT');
    const later = await cache.get(url);
    expectCacheStatus(later, ['HIT', 'HIT-GRACE']);

    for (const res of [hot, later]) {
        expect(
            res.headers['age'],
            'Age header missing on a HIT: a proxy in front strips it or the object is not cached'
        ).toBeDefined();
        expect(Number.isFinite(res.age as number), `Age "${res.headers['age']}" is not numeric`).toBe(true);
    }
    expect(
        later.age as number,
        'Age must not decrease between two HITs on the same object'
    ).toBeGreaterThanOrEqual(hot.age as number);
});

test('H05 cacheable pages never set cookies', smoke, async ({ cache, pageSet }) => {
    for (const { key, path } of pageSet) {
        const { cold, hot } = await cache.warm(cache.withBuster(path));
        expectNoSetCookie(cold, `${key}: Set-Cookie on the backend response must be removed by vcl_backend_response`);
        expectNoSetCookie(hot, `${key}: a HIT must never set cookies`);
    }
});

test('H06 cached HTML has no ESI tags, form keys or private content versions', smoke, async ({ cache, pageSet }) => {
    for (const { key, path } of pageSet) {
        const { hot } = await cache.warm(cache.withBuster(path));
        expectCacheStatus(hot, ['HIT', 'HIT-GRACE'], `${key} must be cacheable`);
        expect(
            hasLiteralEsi(hot.body),
            `${key}: literal <esi:include> in the body means do_esi is off for this content type`
        ).toBe(false);
        // Magento prints a form_key into cacheable HTML and rewrites it from the cookie in the browser
        // (Magento_PageCache form-key-provider, hyva.getFormKey). Without that script every visitor would post
        // the cached value and fail CSRF validation.
        const serverFormKeys = extractFormKeyValues(hot.body);
        const hasProvider = /input\[name=["']form_key["']\]|form-key-provider|getFormKey\(/.test(hot.body);
        expect(
            serverFormKeys.length === 0 || hasProvider,
            `${key}: a server-side form_key value (${serverFormKeys[0]}) is rendered into the shared HTML and no ` +
                'client-side form key provider rewrites it'
        ).toBe(true);
        // The bare name may appear in consent-manager cookie lists; only a name with a value is a leak.
        expect(
            /private_content_version\s*[=:]\s*["']?[0-9a-f]{16,}/i.test(hot.body),
            `${key}: a private_content_version value is rendered into the shared HTML, leaking a session value to everyone`
        ).toBe(false);
    }
});

test('H07 gzip, identity and br requests share one object', readonly, async ({ cache, cfg, pages }) => {
    const url = cache.withBuster(pages.home);
    const { cold, hot } = await cache.warm(url, { headers: { 'Accept-Encoding': 'gzip' } });
    expectCacheStatus(cold, 'MISS');
    expectCacheStatus(hot, 'HIT');

    const identity = await cache.get(url, { headers: { 'Accept-Encoding': 'identity' } });
    const brotli = await cache.get(url, { headers: { 'Accept-Encoding': 'br' } });
    expectCacheStatus(
        identity,
        ['HIT', 'HIT-GRACE'],
        'Accept-Encoding: identity must be served from the gzip object (Varnish gunzips on delivery)'
    );
    expectCacheStatus(
        brotli,
        ['HIT', 'HIT-GRACE'],
        'Accept-Encoding: br must be normalized to gzip or identity, not become a new object'
    );

    const reference = normalizeHtml(hot.body, cfg.normalize);
    expect(normalizeHtml(identity.body, cfg.normalize), 'identity body differs from the gzip body').toBe(reference);
    expect(normalizeHtml(brotli.body, cfg.normalize), 'br body differs from the gzip body').toBe(reference);
});
