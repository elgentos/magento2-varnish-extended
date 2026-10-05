import { test, expect, tags, requireCli } from '../../lib/fixtures';
import { describeResponse, expectCacheStatus, expectNotHit } from '../../lib/http';
import {
    clientInPurgeAcl,
    describePoll,
    effectivePurgeMode,
    invalidationExpectation,
    isInvalidated,
    pollUntil,
} from './helpers';

/*
 * Full flushes and the purge ACL.
 * `cache:clean full_page` makes Magento send PURGE with X-Magento-Tags-Pattern: .*
 * to every host in http_cache_hosts. Varnish answers 405 to any PURGE from an IP
 * outside the purge ACL, and JSON {"invalidated": N} for an accepted purge.
 */
test.describe.configure({ mode: 'serial' });

test.describe('full purge and ACL', { tag: tags.destructive }, () => {
    test('D03 cache:clean full_page empties every cached page', async ({ cfg, env, pageSet, cache, magento }) => {
        test.skip(env === 'production', 'destructive tests never run on production');
        requireCli(magento);
        test.skip(!cfg.flags.purgeReachable, 'http_cache_hosts missing');
        const mode = effectivePurgeMode(cfg);

        for (const page of pageSet) {
            const warm = await cache.warm(page.path);
            expectCacheStatus(warm.hot, 'HIT', `pages.${page.key} must be cacheable before a full purge is observed`);
        }

        magento.cacheClean(['full_page']);

        const results = await Promise.all(
            pageSet.map(async (page) => ({
                page,
                poll: await pollUntil(
                    () => cache.get(page.path),
                    (res) => isInvalidated(res, mode),
                    cfg.timeouts.purgePropagationMs,
                ),
            })),
        );
        const stillCached = results.filter((r) => !r.poll.satisfied);
        expect(
            stillCached.map((r) => `pages.${r.page.key} ${describePoll(r.poll)}`),
            'cache:clean full_page did not reach Varnish (http_cache_hosts / purge ACL): ' +
                `these pages still served the old object (purge mode ${mode}, ` +
                `expected ${invalidationExpectation(mode)})`,
        ).toEqual([]);
    });

    test('D04 PURGE from a client outside the ACL is refused with 405', async ({ env, cache }) => {
        test.skip(env === 'production', 'destructive tests never run on production');
        test.skip(clientInPurgeAcl(), 'VARNISH_PURGE_CLIENT_IN_ACL=1: this client is allowed to purge');

        const res = await cache.request('PURGE', '/');
        expect(
            res.status,
            `purge ACL allows this client; verify the access list\n${describeResponse(res)}`,
        ).not.toBe(200);
        expect(
            res.status,
            'expected 405 from vcl_recv for a PURGE outside the ACL. Another status means a proxy ' +
                `in front of Varnish answered, or the VCL is not the elgentos one\n${describeResponse(res)}`,
        ).toBe(405);
    });

    test('D05 PURGE with a tag pattern from an allowed client flushes the cache', async ({ env, cache }) => {
        test.skip(env === 'production', 'destructive tests never run on production');
        test.skip(!clientInPurgeAcl(), 'set VARNISH_PURGE_CLIENT_IN_ACL=1 when this machine is in the purge ACL');

        const warm = await cache.warm('/');
        expectCacheStatus(warm.hot, 'HIT', 'home page must be cacheable before a purge can be observed');

        const purge = await cache.request('PURGE', '/', { headers: { 'X-Magento-Tags-Pattern': '.*' } });
        expect(
            purge.status,
            'PURGE was refused although VARNISH_PURGE_CLIENT_IN_ACL=1: ' +
                `this client IP is not in the ACL\n${describeResponse(purge)}`,
        ).toBe(200);
        expect(
            purge.headers['content-type'] ?? '',
            `purge response must be JSON\n${describeResponse(purge)}`,
        ).toContain('application/json');

        let parsed: { invalidated?: unknown } = {};
        try {
            parsed = JSON.parse(purge.body) as { invalidated?: unknown };
        } catch {
            parsed = {};
        }
        expect(
            typeof parsed.invalidated,
            `purge body must be {"invalidated": N}, got: ${purge.body.slice(0, 200)}`,
        ).toBe('number');

        const after = await cache.get('/');
        expectNotHit(after, 'home page still served from cache after an accepted full purge');
    });
});
