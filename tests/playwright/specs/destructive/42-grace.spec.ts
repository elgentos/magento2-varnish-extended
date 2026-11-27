import { test, expect, tags, requireHook } from '../../lib/fixtures';
import { describeResponse, expectCacheStatus } from '../../lib/http';
import { SOFT_PURGE_HEADER, clientInPurgeAcl, describePoll, effectivePurgeMode, isFresh, pollUntil } from './helpers';

/*
 * Grace: stale objects served while Varnish refreshes them or while the backend is down.
 * The VCL keeps every object for 1 day of grace, reduced to the configured grace period
 * while the backend probe reports healthy. A soft purge sets ttl to 0 and keeps grace,
 * so the next request is HIT-GRACE and triggers a background fetch.
 */
test.describe.configure({ mode: 'serial' });

/** The backend probe needs several healthy checks (window 10, threshold 5, interval 5s). */
const BACKEND_RECOVERY_MS = 90000;

test.describe('grace', { tag: tags.destructive }, () => {
    test('D06 soft purge serves stale content while a fresh object is fetched', async ({ cfg, env, pages, cache }) => {
        test.skip(env === 'production', 'destructive tests never run on production');
        test.skip(
            effectivePurgeMode(cfg) !== 'xkey-softpurge',
            'soft purging is not enabled (use_xkey_vmod + use_soft_purging)',
        );
        test.skip(!clientInPurgeAcl(), 'set VARNISH_PURGE_CLIENT_IN_ACL=1 when this machine is in the purge ACL');
        test.skip(cfg.flags.gracePeriod <= 0, 'grace_period is 0: a soft purge behaves like a hard purge');
        const target = pages.product ?? pages.home;

        const warm = await cache.warm(target);
        expectCacheStatus(warm.hot, 'HIT', 'page must be cacheable before a soft purge can be observed');

        const purge = await cache.request('PURGE', target, {
            headers: { 'X-Magento-Tags-Pattern': '.*', [SOFT_PURGE_HEADER]: '1' },
        });
        expect(
            purge.status,
            `soft PURGE was refused: client IP not in the purge ACL\n${describeResponse(purge)}`,
        ).toBe(200);

        const stale = await cache.get(target);
        expectCacheStatus(
            stale,
            'HIT-GRACE',
            'first request after a soft purge must be served stale (HIT-GRACE). ' +
                'A MISS means xkey.softpurge was not used or the object had no grace left',
        );

        const refreshed = await pollUntil(() => cache.get(target), isFresh, cfg.timeouts.purgePropagationMs);
        expect(
            refreshed.satisfied,
            'no fresh object arrived after the soft purge: ' +
                `the background fetch failed or the backend is slow ${describePoll(refreshed)}`,
        ).toBe(true);
    });

    test('D07 cached pages survive a backend outage', async ({ env, pages, cache, hooks }, testInfo) => {
        test.skip(env === 'production', 'destructive tests never run on production');
        const down = requireHook(hooks, 'backendDown');
        const up = requireHook(hooks, 'backendUp');
        const home = pages.home;

        const warm = await cache.warm(home);
        expectCacheStatus(warm.hot, 'HIT', 'home page must be cached before the backend goes down');

        await down();
        try {
            const uncached = await cache.get(cache.withBuster(home));
            testInfo.annotations.push({
                type: 'info',
                description: `uncached request during outage: ${uncached.status} ${uncached.cacheStatus}`,
            });
            expect(
                uncached.status,
                'an uncached request still returned 200 while the backendDown hook ran: the hook did not ' +
                    `stop the backend, so grace serving was not exercised\n${describeResponse(uncached)}`,
            ).not.toBe(200);

            const served = await cache.get(home);
            expect(
                served.status,
                `cached home page was not served during the outage\n${describeResponse(served)}`,
            ).toBe(200);
            expectCacheStatus(
                served,
                ['HIT', 'HIT-GRACE'],
                'home page must come from cache (HIT inside ttl, HIT-GRACE after it) while the backend is down',
            );
        } finally {
            await up();
            const recovered = await pollUntil(
                () => cache.get(cache.withBuster(home)),
                (res) => res.status === 200,
                BACKEND_RECOVERY_MS,
                2000,
            );
            expect(
                recovered.satisfied,
                'backend did not come back after the backendUp hook ' +
                    `(the probe needs several healthy checks) ${describePoll(recovered)}`,
            ).toBe(true);
        }
    });
});
