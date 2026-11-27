import { test, expect, tags, requireAccount } from '../../lib/fixtures';
import { expectNotHit, findPii, normalizeHtml } from '../../lib/http';
import { accountRoles, loginViaRequest } from '../../lib/magento';

/*
 * Project-specific per-user endpoints (cfg.privateUrls): JSON endpoints, wishlist counters,
 * quote lists and the like. They must never be stored in the shared cache.
 */

const smoke = { tag: [tags.smoke] };
const fixtures = { tag: [tags.fixtures] };
const PRIVATE_CACHE_CONTROL = /no-store|no-cache|private/i;

test('P01 private URLs are never a HIT for guests', smoke, async ({ cache, cfg }) => {
    test.skip(cfg.privateUrls.length === 0, 'privateUrls is empty');

    for (const url of cfg.privateUrls) {
        const { cold, hot } = await cache.warm(url);
        expectNotHit(cold, `${url} must never be served from cache`);
        expectNotHit(hot, `${url} was served from cache on the second request`);
        if (hot.status === 200) {
            expect(
                PRIVATE_CACHE_CONTROL.test(hot.headers['cache-control'] ?? ''),
                `${url}: per-user endpoint without Cache-Control is cached for Varnish default_ttl\n` +
                    `  cache-control: ${hot.headers['cache-control']}`
            ).toBe(true);
        }
    }
});

test('P02 private URLs do not leak one customer to another', fixtures, async ({ cache, cfg, store, accounts }) => {
    test.skip(cfg.privateUrls.length === 0, 'privateUrls is empty');
    const roles = accountRoles(accounts, store);
    const accountA = requireAccount(roles.a, 'a logged-in customer');
    const accountB = requireAccount(roles.b ?? roles.other, 'a second customer');

    const sessionA = await loginViaRequest(cache, cfg, accountA);
    const sessionB = await loginViaRequest(cache, cfg, accountB);
    try {
        const markersA = [accountA.firstname, accountA.lastname, accountA.email].filter(Boolean);
        for (const url of cfg.privateUrls) {
            const first = await cache.get(url, { context: sessionA.context });
            const second = await cache.get(url, { context: sessionA.context });
            expectNotHit(first, `${url} must never be a HIT for a logged-in customer`);
            expectNotHit(second, `${url} was served from cache for a logged-in customer`);

            const asB = await cache.get(url, { context: sessionB.context });
            expectNotHit(asB, `${url} was served from cache to customer B`);
            if (second.status !== 200 || asB.status !== 200) {
                continue;
            }
            const sameBody = normalizeHtml(second.body, cfg.normalize) === normalizeHtml(asB.body, cfg.normalize);
            const leaked = findPii(asB.body, markersA, cfg.pii.checkEncodings);
            expect(
                !sameBody || leaked.length === 0,
                `${url}: customer B received the same body as customer A including A's data (${leaked.join(', ')})`
            ).toBe(true);
            expect(leaked, `${url}: customer A's data found in customer B's response`).toEqual([]);
        }
    } finally {
        await sessionA.context.dispose();
        await sessionB.context.dispose();
    }
});
