import { test, expect, tags, requirePage, requireCli } from '../../lib/fixtures';
import { describeResponse, expectCacheStatus } from '../../lib/http';
import {
    describePoll,
    effectivePurgeMode,
    invalidationExpectation,
    isFresh,
    isInvalidated,
    pollUntil,
} from './helpers';

/*
 * Tag purges that Magento emits when a catalog entity is saved.
 * A product page carries cat_p_<id>; saving a product also emits cat_c_p_<categoryId>,
 * which invalidates listing pages. The home page only carries those tags when it
 * shows the product (widget, bestsellers block), so its status is annotated, not asserted.
 *
 * These tests act on the real URLs, because purges target real tags.
 */
test.describe.configure({ mode: 'serial' });

test.describe('tag purges', { tag: tags.destructive }, () => {
    test('D01 saving a product invalidates its page and leaves unrelated objects alone', async ({
        cfg,
        env,
        pages,
        cache,
        magento,
    }, testInfo) => {
        test.skip(env === 'production', 'destructive tests never run on production');
        requireCli(magento);
        test.skip(!cfg.flags.purgeReachable, 'http_cache_hosts missing');
        const sku = cfg.fixtures.purgeProductSku;
        test.skip(!sku, 'fixtures.purgeProductSku is not configured');
        const product = requirePage(pages, 'product');
        const home = pages.home;
        const mode = effectivePurgeMode(cfg);

        const productWarm = await cache.warm(product);
        expectCacheStatus(productWarm.hot, 'HIT', 'product page must be cacheable before a purge can be observed');
        const homeWarm = await cache.warm(home);
        expectCacheStatus(homeWarm.hot, 'HIT', 'home page must be cacheable before a purge can be observed');

        magento.touch({ sku });

        const purged = await pollUntil(
            () => cache.get(product),
            (res) => isInvalidated(res, mode),
            cfg.timeouts.purgePropagationMs,
        );
        expect(
            purged.satisfied,
            `product page still served the old object after saving SKU ${sku} ` +
                `(purge mode ${mode}, expected ${invalidationExpectation(mode)}): ` +
                'the purge did not reach Varnish (http_cache_hosts, purge ACL) ' +
                `or the page does not carry its cat_p tag ${describePoll(purged)}`,
        ).toBe(true);

        if (mode === 'xkey-softpurge') {
            const refreshed = await pollUntil(() => cache.get(product), isFresh, cfg.timeouts.purgePropagationMs);
            expect(
                refreshed.satisfied,
                'soft purge served stale content but no fresh object arrived: ' +
                    `the background fetch failed ${describePoll(refreshed)}`,
            ).toBe(true);
        }

        // Indexers and queued events emit further purges for the same tags shortly after the save,
        // so allow a few misses before the page settles into a HIT again.
        const settled = await pollUntil(
            () => cache.get(product),
            (res) => res.cacheStatus === 'HIT' || res.cacheStatus === 'HIT-GRACE',
            cfg.timeouts.purgePropagationMs,
        );
        expect(
            settled.satisfied,
            `product page did not become cacheable again after the purge ${describePoll(settled)}`,
        ).toBe(true);

        const homeAfter = await cache.get(home);
        if (homeAfter.cacheStatus !== 'HIT') {
            testInfo.annotations.push({
                type: 'warning',
                description:
                    `home page was invalidated by the product save (${homeAfter.cacheStatus}). ` +
                    'If the home shows this product (widget, bestsellers) that is correct, ' +
                    'otherwise the purge was too broad.\n' +
                    describeResponse(homeAfter),
            });
        } else {
            testInfo.annotations.push({
                type: 'info',
                description: 'home page kept its cache object: purge was scoped to the product tags',
            });
        }
    });

    test('D02 saving a category invalidates its category page', async ({
        cfg,
        env,
        pages,
        cache,
        magento,
    }, testInfo) => {
        test.skip(env === 'production', 'destructive tests never run on production');
        requireCli(magento);
        test.skip(!cfg.flags.purgeReachable, 'http_cache_hosts missing');
        const categoryId = cfg.fixtures.purgeCategoryId;
        test.skip(!categoryId, 'fixtures.purgeCategoryId is not configured');
        const category = requirePage(pages, 'category');
        const product = pages.product;
        const mode = effectivePurgeMode(cfg);

        const categoryWarm = await cache.warm(category);
        expectCacheStatus(categoryWarm.hot, 'HIT', 'category page must be cacheable before a purge can be observed');
        if (product) {
            const productWarm = await cache.warm(product);
            expectCacheStatus(productWarm.hot, 'HIT', 'product page must be cacheable before a purge can be observed');
        }

        magento.touch({ categoryId });

        const purged = await pollUntil(
            () => cache.get(category),
            (res) => isInvalidated(res, mode),
            cfg.timeouts.purgePropagationMs,
        );
        expect(
            purged.satisfied,
            `category page still served the old object after saving category ${categoryId} ` +
                `(purge mode ${mode}, expected ${invalidationExpectation(mode)}): ` +
                'the purge did not reach Varnish (http_cache_hosts, purge ACL) ' +
                `or the page does not carry its cat_c tag ${describePoll(purged)}`,
        ).toBe(true);

        if (mode === 'xkey-softpurge') {
            const refreshed = await pollUntil(() => cache.get(category), isFresh, cfg.timeouts.purgePropagationMs);
            expect(
                refreshed.satisfied,
                'soft purge served stale content but no fresh object arrived: ' +
                    `the background fetch failed ${describePoll(refreshed)}`,
            ).toBe(true);
        }

        const categorySettled = await pollUntil(
            () => cache.get(category),
            (res) => res.cacheStatus === 'HIT' || res.cacheStatus === 'HIT-GRACE',
            cfg.timeouts.purgePropagationMs,
        );
        expect(
            categorySettled.satisfied,
            `category page did not become cacheable again after the purge ${describePoll(categorySettled)}`,
        ).toBe(true);

        if (product) {
            const productAfter = await cache.get(product);
            testInfo.annotations.push({
                type: productAfter.cacheStatus === 'HIT' ? 'info' : 'warning',
                description:
                    `product page after the category save: ${productAfter.cacheStatus}. ` +
                    'A product page carries cat_c_<id> tags for its categories (breadcrumbs, navigation), ' +
                    'so a MISS here can be correct.\n' +
                    describeResponse(productAfter),
            });
        }
    });
});
