import * as fs from 'fs';
import * as path from 'path';
import { Flags, resultsDir } from '../lib/config';
import { test, expect } from '../lib/fixtures';

/**
 * Fails fast on a misconfigured environment and records the effective Varnish flags
 * (read from Magento config) for the other projects.
 */
test.describe.configure({ mode: 'serial' });

const truthy = (value: string | null, fallback: boolean): boolean => {
    if (value === null) {
        return fallback;
    }
    return ['1', 'true', 'yes'].includes(value.trim().toLowerCase());
};

test('preflight: Varnish answers in front of Magento', async ({ cache, cfg }) => {
    const res = await cache.get(cache.withBuster(cfg.pages.home));
    expect(res.status, `GET ${res.url} returned ${res.status}`).toBe(200);
    const hasDebug = res.headers['x-magento-cache-debug'] !== undefined;
    const hasAge = res.headers['age'] !== undefined;
    expect(
        hasDebug || hasAge,
        'Neither X-Magento-Cache-Debug nor Age is present: requests do not pass through Varnish, or the VCL is not the elgentos one'
    ).toBe(true);
});

test('preflight: Magento configuration and effective flags', async ({ magento, cfg, env }, testInfo) => {
    const flags: Partial<Flags> = { magentoCliAvailable: magento.available() };

    if (!magento.available()) {
        testInfo.annotations.push({
            type: 'warning',
            description: 'No Magento CLI: flags come from the config file, fixtures and purge tests are skipped',
        });
        fs.writeFileSync(path.join(resultsDir(), 'varnish-flags.json'), JSON.stringify(flags, null, 2));
        return;
    }

    const cachingApplication = magento.configShow('system/full_page_cache/caching_application');
    expect(cachingApplication, 'system/full_page_cache/caching_application must be 2 (Varnish)').toBe('2');

    const rememberPagination = magento.configShow('catalog/frontend/remember_pagination');
    expect(
        truthy(rememberPagination, false),
        'catalog/frontend/remember_pagination is enabled: the toolbar stores state in the session, which makes cached listing pages user dependent'
    ).toBe(false);

    const base = 'system/full_page_cache/varnish/';
    flags.bfcache = truthy(magento.configShow(base + 'enable_bfcache'), true);
    flags.cache404 = truthy(magento.configShow(base + 'enable_404_cache'), true);
    flags.mediaCache = truthy(magento.configShow(base + 'enable_media_cache'), false);
    flags.staticCache = truthy(magento.configShow(base + 'enable_static_cache'), false);
    flags.xkey = truthy(magento.configShow(base + 'use_xkey_vmod'), false);
    flags.softpurge = flags.xkey && truthy(magento.configShow(base + 'use_soft_purging'), false);
    flags.gracePeriod = Number(magento.configShow(base + 'grace_period') ?? 300);
    flags.designExceptions = (magento.configShow('design/theme/ua_regexp') ?? '').trim().length > 0;
    flags.cookieDomain = magento.configShow('web/cookie/cookie_domain');
    flags.passOnCookieRegexes = (magento.configShow(base + 'pass_on_cookie_presence') ?? '')
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean);

    const hosts = magento.envValue<Array<{ host: string; port?: string }>>('http_cache_hosts');
    flags.purgeReachable = magento.isLocal() ? Array.isArray(hosts) && hosts.length > 0 : true;
    if (!flags.purgeReachable) {
        testInfo.annotations.push({
            type: 'warning',
            description: 'app/etc/env.php has no http_cache_hosts: Magento purges never reach Varnish, purge tests will fail or skip',
        });
    }

    testInfo.annotations.push({ type: 'flags', description: JSON.stringify({ env, ...flags }) });
    fs.writeFileSync(path.join(resultsDir(), 'varnish-flags.json'), JSON.stringify(flags, null, 2));

    if (env !== 'production' && cfg.fixtures.mode === 'cli') {
        const probe = magento.run(['varnish:test:fixtures', '--help'], { allowFailure: true });
        expect(probe.status, 'varnish:test:fixtures command missing: update elgentos/magento2-varnish-extended').toBe(0);
    }
});
