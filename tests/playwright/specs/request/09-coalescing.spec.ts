import { test, expect, tags } from '../../lib/fixtures';
import { describeResponse, normalizeHtml } from '../../lib/http';

/*
 * Request coalescing: parallel requests for one cold object must result in a single backend fetch.
 * More than one MISS means the object is hit-for-miss (uncacheable) or the waiting list is disabled.
 */

const readonly = { tag: [tags.readonly] };

test('R01 parallel requests on a cold object are coalesced', readonly, async ({ cache, cfg, pages }) => {
    const count = Math.max(2, cfg.coalescing.parallelRequests);
    const url = cache.withBuster(pages.home);

    const responses = await Promise.all(Array.from({ length: count }, () => cache.get(url)));
    const summary = responses.map(describeResponse).join('\n');

    for (const res of responses) {
        expect(res.status, `every parallel request must answer 200\n${summary}`).toBe(200);
    }
    const misses = responses.filter((r) => r.cacheStatus === 'MISS' || r.cacheStatus === 'MISS-FORCED');
    const hits = responses.filter((r) => r.cacheStatus === 'HIT' || r.cacheStatus === 'HIT-GRACE');
    expect(
        misses.length,
        `request coalescing broken or hit-for-miss: ${misses.length} of ${count} were a MISS\n${summary}`
    ).toBe(1);
    expect(
        hits.length,
        `request coalescing broken or hit-for-miss: only ${hits.length} of ${count} were a HIT\n${summary}`
    ).toBe(count - 1);

    const bodies = new Set(responses.map((r) => normalizeHtml(r.body, cfg.normalize)));
    expect(bodies.size, 'coalesced responses must carry the same body').toBe(1);
});
