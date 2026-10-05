import { test, expect, tags } from '../../lib/fixtures';
import { CacheResponse, cookieHeader, describeResponse, expectCacheStatus } from '../../lib/http';

/*
 * Request cookies: ordinary cookies must neither bypass nor fragment the cache, X-Magento-Vary
 * is part of the hash, and the configured pass_on_cookie_presence regexes force a pass.
 */

const smoke = { tag: [tags.smoke] };
const readonly = { tag: [tags.readonly] };
const edge = { tag: [tags.edge] };

const matchesAnyRegex = (value: string, regexes: string[]): boolean =>
    regexes.some((source) => {
        try {
            return new RegExp(source).test(value);
        } catch {
            return false;
        }
    });

/** Best-effort cookie name that satisfies a pass_on_cookie_presence regex. */
const cookieNameFor = (source: string): string | null => {
    const stripped = source
        .replace(/^\^/, '')
        .replace(/\$$/, '')
        .replace(/\\b/g, '')
        .replace(/\.\*|\.\+/g, '')
        .replace(/=.*$/, '')
        .replace(/\\/g, '');
    for (const name of [stripped, source]) {
        if (!/^[A-Za-z0-9_-]+$/.test(name)) {
            continue;
        }
        try {
            if (new RegExp(source).test(`${name}=1`)) {
                return name;
            }
        } catch {
            return null;
        }
    }
    return null;
};

test('C01 ordinary cookies do not bypass or fragment the cache', smoke, async ({ cache, cfg, pages }) => {
    const all: Record<string, string> = {
        _ga: 'GA1.1.1',
        foo: 'bar',
        PHPSESSID: 'abc123',
        form_key: 'xyz',
        'mage-messages': '[]',
    };
    const passRegexes = cfg.flags.passOnCookieRegexes;
    const cookies = Object.fromEntries(
        Object.entries(all).filter(([name, value]) => !matchesAnyRegex(`${name}=${value}`, passRegexes))
    );
    test.skip(Object.keys(cookies).length === 0, 'every test cookie matches a pass_on_cookie_presence regex');

    const url = cache.withBuster(pages.home);
    const { cold, hot } = await cache.warm(url);
    expectCacheStatus(cold, 'MISS');
    expectCacheStatus(hot, 'HIT');

    const withCookies = await cache.get(url, { cookies });
    expect(withCookies.status).toBe(200);
    expectCacheStatus(
        withCookies,
        ['HIT', 'HIT-GRACE'],
        `request with cookies "${cookieHeader(cookies)}" was not served from the warmed object: a cookie is ` +
            'either hashed (fragmentation) or triggers a pass (PHPSESSID/form_key must not bypass the cache)'
    );
});

test('C02 a foreign X-Magento-Vary cookie never reaches or replaces the guest object', smoke, async ({ cache, pages }) => {
    const url = cache.withBuster(pages.home);
    const plain = await cache.warm(url);
    expectCacheStatus(plain.cold, 'MISS');
    expectCacheStatus(plain.hot, 'HIT');

    // Varnish hashes the cookie, so this request cannot hit the guest object. Magento then sees a vary value
    // that does not match the guest context, answers uncacheable and deletes the cookie (self-healing).
    const varied = await cache.get(url, { cookies: { 'X-Magento-Vary': 'deadbeef' } });
    expect(varied.status).toBe(200);
    expect(
        ['HIT', 'HIT-GRACE'],
        'a request with an unknown X-Magento-Vary value was served the guest object: the vary cookie is not part ' +
            `of the hash, so logged-in/currency/group variants leak between visitors\n${describeResponse(varied)}`
    ).not.toContain(varied.cacheStatus);
    const deletesCookie = varied.setCookies.some(
        (c) => /^X-Magento-Vary=/i.test(c) && /(=deleted|expires=Thu, 01 Jan 1970|max-age=0)/i.test(c)
    );
    expect(
        deletesCookie || varied.cacheStatus === 'UNCACHEABLE',
        `Magento neither refused to cache nor deleted the mismatching vary cookie\n${describeResponse(varied)}`
    ).toBe(true);

    const again = await cache.get(url);
    expectCacheStatus(
        again,
        ['HIT', 'HIT-GRACE'],
        'the guest object was replaced or evicted by the request that carried a foreign vary cookie'
    );
});

test('C03 cookies matching pass_on_cookie_presence force a pass', readonly, async ({ cache, cfg, pages }, testInfo) => {
    test.skip(cfg.flags.passOnCookieRegexes.length === 0, 'pass_on_cookie_presence is empty');

    let checked = 0;
    for (const source of cfg.flags.passOnCookieRegexes) {
        const name = cookieNameFor(source);
        if (!name) {
            testInfo.annotations.push({
                type: 'skipped-regex',
                description: `no cookie name derivable from "${source}"`,
            });
            continue;
        }
        checked++;
        const res = await cache.get(cache.withBuster(pages.home), { cookies: { [name]: '1' } });
        expectCacheStatus(
            res,
            'UNCACHEABLE',
            `cookie "${name}" matches pass_on_cookie_presence "${source}" but the request was not passed ` +
                '(VCL not regenerated after the config change?)'
        );
    }
    test.skip(checked === 0, 'no pass_on_cookie_presence regex could be turned into a cookie name');
});

test('C04 a very large Cookie header does not cause a 5xx', edge, async ({ cache, pages }, testInfo) => {
    const cookies: Record<string, string> = {};
    for (let i = 0; i < 60; i++) {
        cookies[`big${i}`] = 'x'.repeat(200);
    }
    const url = cache.withBuster(pages.home);

    let first: CacheResponse;
    let second: CacheResponse;
    try {
        first = await cache.get(url, { cookies });
        second = await cache.get(url, { cookies });
    } catch (error) {
        testInfo.annotations.push({
            type: 'note',
            description: `connection dropped on a ~12KB Cookie header: ${(error as Error).message}`,
        });
        return;
    }

    for (const res of [first, second]) {
        expect(
            res.status,
            `a 12KB Cookie header produced ${res.status}; Varnish must answer 200 or reject with 400/431`
        ).toBeLessThan(500);
        expect([200, 400, 413, 431], 'unexpected status for an oversized Cookie header').toContain(res.status);
    }
    if (second.status === 200) {
        expect(
            second.cacheStatus,
            'a large but harmless Cookie header must not create a new object on every request'
        ).not.toBe('MISS');
    }
});
