import { BrowserContext, Page, Response } from '@playwright/test';
import { test, expect, tags, requirePage, requireAccount, requireHook, Hooks } from '../../lib/fixtures';
import { CacheStatus, cacheStatusOf } from '../../lib/http';
import { Pages, StoreConfig, VarnishConfig } from '../../lib/config';
import { Account, accountRoles, isLoggedInViaSection, loginViaBrowser } from '../../lib/magento';

/*
 * Cookie consent.
 *
 * X-Magento-Vary is a functional cookie. A consent manager that blocks it after the visitor
 * declines optional cookies (or that removes it with "accept all") silently sends logged-in
 * customers to the guest cache objects: guest prices, guest UI. The project implements the
 * consent interaction in hooks.ts; without the hooks these tests are skipped.
 */

type ConsentHook = NonNullable<Hooks['declineOptionalCookies']>;

async function statusOf(response: Response | null): Promise<CacheStatus> {
    expect(response, 'navigation produced no document response').not.toBeNull();
    return cacheStatusOf(await (response as Response).allHeaders());
}

async function varyCookie(context: BrowserContext): Promise<string | null> {
    return (await context.cookies()).find((c) => c.name === 'X-Magento-Vary')?.value ?? null;
}

function resolvePagePath(pages: Pages, key: string): string | null {
    if (key.startsWith('/')) {
        return key;
    }
    return pages[key as keyof Pages] ?? null;
}

interface ConsentScenario {
    page: Page;
    context: BrowserContext;
    cfg: VarnishConfig;
    store: StoreConfig;
    pages: Pages;
    busterUrl: string;
    account: Account;
    consent: ConsentHook;
    label: string;
    annotate: (type: string, description: string) => void;
}

/** Consent choice first, then login through the real form, then a cached product page as this customer. */
async function runConsentScenario(scenario: ConsentScenario): Promise<void> {
    const { page, context, cfg, store, pages, busterUrl, account, consent, label, annotate } = scenario;

    await page.goto(pages.home, { waitUntil: 'load' });
    await consent(page);
    // beforeLogin is skipped on purpose: it may dismiss the consent bar and override the choice under test.
    await loginViaBrowser(page, cfg, account);
    expect(await isLoggedInViaSection(page, cfg), `login as ${account.key} failed after "${label}"`).toBe(true);

    const vary = await varyCookie(context);
    annotate('vary', `${label}: X-Magento-Vary=${vary ?? '(none)'}`);
    expect(
        vary,
        `consent manager blocks the X-Magento-Vary cookie after "${label}": logged-in customers get guest cache objects`
    ).not.toBeNull();

    expect(await statusOf(await page.goto(busterUrl)), 'fresh buster must be a MISS').toBe('MISS');
    const second = await statusOf(await page.reload());
    expect(['HIT', 'HIT-GRACE'], `reload after "${label}" is ${second}: logged-in pages are not cached`)
        .toContain(second);

    const productPath = pages.product;
    const assertion = cfg.priceAssertions.find(
        (p) => (!p.store || p.store === store.code)
            && resolvePagePath(pages, p.page) === productPath
            && Boolean(p.expect[account.key])
    );
    if (assertion) {
        const locator = page.locator(assertion.selector ?? cfg.selectors.price).first();
        const price = (await locator.innerText({ timeout: 10000 })).trim();
        annotate('price', `${label}: ${account.key} sees ${price}`);
        expect(
            price,
            `HIT page after "${label}" shows the wrong price for ${account.key}: customer served the guest object`
        ).toContain(assertion.expect[account.key]);
    }
}

test.describe('cookie consent', () => {
    test('K01 declining optional cookies keeps X-Magento-Vary', { tag: [tags.fixtures] }, async (
        { page, context, cfg, store, pages, cache, hooks, accounts },
        testInfo
    ) => {
        const consent = requireHook(hooks, 'declineOptionalCookies');
        const product = requirePage(pages, 'product');
        const account = requireAccount(accountRoles(accounts, store).a, 'a logged-in customer');
        await runConsentScenario({
            page, context, cfg, store, pages, account, consent,
            busterUrl: cache.withBuster(product),
            label: 'decline optional cookies',
            annotate: (type, description) => testInfo.annotations.push({ type, description }),
        });
    });

    test('K02 accepting all cookies keeps X-Magento-Vary', { tag: [tags.fixtures] }, async (
        { page, context, cfg, store, pages, cache, hooks, accounts },
        testInfo
    ) => {
        const consent = requireHook(hooks, 'acceptAllCookies');
        const product = requirePage(pages, 'product');
        const account = requireAccount(accountRoles(accounts, store).a, 'a logged-in customer');
        await runConsentScenario({
            page, context, cfg, store, pages, account, consent,
            busterUrl: cache.withBuster(product),
            label: 'accept all cookies',
            annotate: (type, description) => testInfo.annotations.push({ type, description }),
        });
    });
});
