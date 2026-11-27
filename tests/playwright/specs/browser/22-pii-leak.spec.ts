import { Browser, BrowserContext, Page, PlaywrightTestOptions, Response } from '@playwright/test';
import { test, expect, tags, requireAccount, Hooks } from '../../lib/fixtures';
import { CacheClient, cacheStatusOf, findPii } from '../../lib/http';
import { Pages, VarnishConfig } from '../../lib/config';
import { Account, accountRoles, isLoggedInViaSection, loginViaBrowser, piiMarkers } from '../../lib/magento';

/*
 * PII leaks.
 *
 * Every document that Varnish stores is shared with everybody who hashes to the same object,
 * so a customer's email, name or token must never be part of it: not on the MISS that fills the
 * object, not on the HIT, and certainly not in what a guest receives afterwards.
 *
 * For the logged-in visitor only the raw document is checked: after load, Hyva/Luma render the
 * customer's name client side from customer/section/load, so the rendered DOM legitimately contains
 * it. For the guest both the raw document and the rendered DOM are checked.
 */

type Credentials = PlaywrightTestOptions['httpCredentials'];

interface ScanDeps {
    browser: Browser;
    baseURL: string | undefined;
    httpCredentials: Credentials;
    page: Page;
    cfg: VarnishConfig;
    cache: CacheClient;
    pageSet: Array<{ key: keyof Pages; path: string }>;
    annotate: (type: string, description: string) => void;
}

async function newVisitor(
    browser: Browser, baseURL: string | undefined, httpCredentials: Credentials
): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext({ baseURL, httpCredentials, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    return { context, page };
}

async function login(page: Page, cfg: VarnishConfig, hooks: Hooks, account: Account): Promise<void> {
        await loginViaBrowser(page, cfg, account, hooks);
    expect(await isLoggedInViaSection(page, cfg), `login as ${account.key} failed`).toBe(true);
}

function ownMarkers(account: Account): string[] {
    const values = [account.email, account.firstname, account.lastname, account.token];
    return [...values, ...Object.values(account.attributes ?? {})].filter((v): v is string => Boolean(v));
}

/** Visits every page in the set as the logged-in visitor (MISS, HIT) and as a guest, returning leak descriptions. */
async function collectLeaks(deps: ScanDeps, markers: string[]): Promise<string[]> {
    const { browser, baseURL, httpCredentials, page, cfg, cache, pageSet, annotate } = deps;
    const leaks: string[] = [];
    const check = (pageKey: string, visitor: string, source: string, body: string): void => {
        for (const hit of findPii(body, markers, cfg.pii.checkEncodings)) {
            leaks.push(`${pageKey} / ${visitor} / ${source}: ${hit}`);
        }
    };
    const statusOf = async (response: Response | null): Promise<string> =>
        response ? cacheStatusOf(await response.allHeaders()) : 'no response';

    for (const { key, path } of pageSet) {
        const url = cache.withBuster(path);

        const miss = await page.goto(url);
        expect(miss, `${key}: no document response`).not.toBeNull();
        annotate('cache', `${key} customer first: ${await statusOf(miss)}`);
        check(key, 'customer (first request)', 'document', await (miss as Response).text());

        const hit = await page.reload();
        annotate('cache', `${key} customer reload: ${await statusOf(hit)}`);
        check(key, 'customer (reload)', 'document', await (hit as Response).text());

        const guest = await newVisitor(browser, baseURL, httpCredentials);
        try {
            const settled = guest.page
                .waitForResponse((r) => r.url().includes(cfg.paths.sectionLoad), {
                    timeout: cfg.timeouts.sectionLoadMs,
                })
                .catch(() => null);
            const doc = await guest.page.goto(url);
            annotate('cache', `${key} guest: ${await statusOf(doc)}`);
            check(key, 'guest', 'document', await (doc as Response).text());
            await settled;
            check(key, 'guest', 'rendered DOM', await guest.page.content());
        } finally {
            await guest.context.close();
        }
    }
    return leaks;
}

test.describe('PII in shared cache objects', () => {
    test('I01 fixture account data never appears in cached pages', { tag: [tags.fixtures] }, async (
        { browser, baseURL, httpCredentials, page, cfg, cache, pageSet, hooks, accounts, store },
        testInfo
    ) => {
        test.skip(pageSet.length === 0, 'pageSet is empty for this store');
        const a = requireAccount(accountRoles(accounts, store).a, 'a logged-in customer');
        const own = ownMarkers(a);
        const markers = piiMarkers(cfg, accounts).filter((m) => own.includes(m) || cfg.pii.extraMarkers.includes(m));
        test.skip(markers.length === 0, 'no PII markers for this account (pii.fromFixtures off and no extraMarkers)');
        testInfo.annotations.push({ type: 'markers', description: `${markers.length} marker(s) for ${a.key}` });

        await login(page, cfg, hooks, a);
        const leaks = await collectLeaks(
            {
                browser, baseURL, httpCredentials, page, cfg, cache, pageSet,
                annotate: (type, description) => testInfo.annotations.push({ type, description }),
            },
            markers
        );
        expect(
            leaks,
            'customer data found in a shared cache object (page / visitor / source: marker (encoding)): ' +
                'a block renders session data into cacheable output'
        ).toEqual([]);
    });

    test('I02 project PII markers never appear in cached pages', { tag: [tags.fixtures] }, async (
        { browser, baseURL, httpCredentials, page, cfg, cache, pageSet, hooks, accounts, store },
        testInfo
    ) => {
        test.skip(pageSet.length === 0, 'pageSet is empty for this store');
        test.skip(cfg.pii.extraMarkers.length === 0, 'pii.extraMarkers is empty');
        const a = requireAccount(accountRoles(accounts, store).a, 'a logged-in customer');

        await login(page, cfg, hooks, a);
        const leaks = await collectLeaks(
            {
                browser, baseURL, httpCredentials, page, cfg, cache, pageSet,
                annotate: (type, description) => testInfo.annotations.push({ type, description }),
            },
            cfg.pii.extraMarkers
        );
        expect(
            leaks,
            'project marker found in a shared cache object (page / visitor / source: marker (encoding))'
        ).toEqual([]);
    });
});
