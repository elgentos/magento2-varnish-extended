import { test, tags } from '../../lib/fixtures';
import { expectCacheStatus } from '../../lib/http';
import { clientInPurgeAcl } from './helpers';

/*
 * Forced refresh: the VCL honors `Cache-Control: no-cache` (Ctrl-Shift-R) only for
 * IPs in the purge ACL, by setting req.hash_always_miss. For every other client the
 * header must be ignored, otherwise anyone can bypass the cache at will.
 */
test.describe.configure({ mode: 'serial' });

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-cache', Pragma: 'no-cache' };

test.describe('forced refresh', { tag: tags.destructive }, () => {
    test('D08 Cache-Control: no-cache forces a miss only for the purge ACL', async ({ env, pages, cache }) => {
        test.skip(env === 'production', 'destructive tests never run on production');
        const home = pages.home;

        const warm = await cache.warm(home);
        expectCacheStatus(warm.hot, 'HIT', 'home page must be cached before a forced refresh can be observed');

        const forced = await cache.get(home, { headers: NO_CACHE_HEADERS });

        if (clientInPurgeAcl()) {
            expectCacheStatus(
                forced,
                'MISS-FORCED',
                'a client in the purge ACL must get MISS-FORCED for Cache-Control: no-cache (hash_always_miss)',
            );
            const after = await cache.get(home);
            expectCacheStatus(
                after,
                'HIT',
                'the forced fetch must replace the cached object, so the next plain request is a HIT',
            );
            return;
        }

        expectCacheStatus(
            forced,
            'HIT',
            'any client can force cache misses: DoS vector. ' +
                'Cache-Control: no-cache must only be honored for the purge ACL',
        );
    });
});
