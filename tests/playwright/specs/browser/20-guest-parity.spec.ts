import { Browser, BrowserContext, Page, PlaywrightTestOptions, Response } from '@playwright/test';
import { test, expect, tags } from '../../lib/fixtures';
import { cacheStatusOf, normalizeHtml } from '../../lib/http';

/*
 * Guest parity.
 *
 * Two anonymous visitors must be served the same cache object for the same URL, and that object
 * must not carry anything that belongs to one of them. Cookies (PHPSESSID, form_key, private
 * content) reach a guest through uncacheable requests such as customer/section/load, never through
 * the cached document itself: the VCL strips Set-Cookie from cacheable backend responses.
 *
 * Browser HTTP cache: cacheable pages carry "must-revalidate, max-age=60", so a second page.goto()
 * to the same URL inside one context may be answered by Chromium without a network round trip.
 * Second visitors therefore always get their own BrowserContext.
 */

type Credentials = PlaywrightTestOptions['httpCredentials'];

interface Visitor {
    context: BrowserContext;
    page: Page;
}

interface Document {
    status: number;
    headers: Record<string, string>;
    body: string;
}

async function newVisitor(
    browser: Browser, baseURL: string | undefined, httpCredentials: Credentials
): Promise<Visitor> {
    const context = await browser.newContext({ baseURL, httpCredentials, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    return { context, page };
}

async function documentOf(response: Response | null, what: string): Promise<Document> {
    expect(response, `no document response for ${what}`).not.toBeNull();
    const headers = await (response as Response).allHeaders();
    return { status: (response as Response).status(), headers, body: await (response as Response).text() };
}

/** Register before page.goto(); await afterwards. Resolves to null when no section load happened in time. */
function sectionLoadSettled(page: Page, sectionLoad: string, timeout: number): Promise<Response | null> {
    return page.waitForResponse((r) => r.url().includes(sectionLoad), { timeout }).catch(() => null);
}

test.describe('guest parity', () => {
    test('B01 two guests share one cache object per page', { tag: [tags.smoke] }, async (
        { browser, baseURL, httpCredentials, cfg, cache, pageSet },
        testInfo
    ) => {
        test.skip(pageSet.length === 0, 'pageSet is empty for this store');
        test.setTimeout(Math.max(90000, 45000 * pageSet.length));

        for (const { key, path } of pageSet) {
            const url = cache.withBuster(path);
            const a = await newVisitor(browser, baseURL, httpCredentials);
            const b = await newVisitor(browser, baseURL, httpCredentials);
            try {
                const settledA = sectionLoadSettled(a.page, cfg.paths.sectionLoad, cfg.timeouts.sectionLoadMs);
                const docA = await documentOf(await a.page.goto(url), `${key} (visitor A)`);
                await settledA;
                const statusA = cacheStatusOf(docA.headers);
                expect(docA.status, `${key}: visitor A did not get a 200 for ${url}`).toBe(200);
                expect(
                    docA.headers['set-cookie'],
                    `${key}: the cached document sets a cookie for visitor A: ` +
                        'Varnish must strip Set-Cookie on cacheable responses'
                ).toBeUndefined();
                expect(
                    ['MISS', 'HIT', 'HIT-GRACE'],
                    `${key}: first guest request is ${statusA}: page is not cacheable for guests ` +
                        '(session cookie, no-cache header, pass rule?)'
                ).toContain(statusA);

                const settledB = sectionLoadSettled(b.page, cfg.paths.sectionLoad, cfg.timeouts.sectionLoadMs);
                const docB = await documentOf(await b.page.goto(url), `${key} (visitor B)`);
                await settledB;
                const statusB = cacheStatusOf(docB.headers);
                expect(
                    docB.headers['set-cookie'],
                    `${key}: the cached document sets a cookie for visitor B: ` +
                        'Varnish must strip Set-Cookie on cacheable responses'
                ).toBeUndefined();
                expect(
                    ['HIT', 'HIT-GRACE'],
                    `${key}: second guest got ${statusB} instead of HIT: guests do not share one cache object ` +
                        '(vary cookie, per-visitor hash data or uncacheable page)'
                ).toContain(statusB);

                const rawA = normalizeHtml(docA.body, cfg.normalize);
                const rawB = normalizeHtml(docB.body, cfg.normalize);
                if (rawA !== rawB) {
                    await testInfo.attach(`${key}-document-A.html`, { body: docA.body, contentType: 'text/html' });
                    await testInfo.attach(`${key}-document-B.html`, { body: docB.body, contentType: 'text/html' });
                }
                expect(
                    rawA === rawB,
                    `${key}: shared cache object differs between two guests: per-visitor data in page ` +
                        '(document bodies attached)'
                ).toBe(true);

                // The rendered DOM legitimately differs per visitor (section data, consent state, random ids).
                // It is attached for inspection only; the cache contract is the raw document compared above.
                const domA = normalizeHtml(await a.page.content(), cfg.normalize);
                const domB = normalizeHtml(await b.page.content(), cfg.normalize);
                if (domA !== domB) {
                    await testInfo.attach(`${key}-rendered-A.html`, { body: domA, contentType: 'text/html' });
                    await testInfo.attach(`${key}-rendered-B.html`, { body: domB, contentType: 'text/html' });
                    testInfo.annotations.push({
                        type: 'info',
                        description: `${key}: rendered DOM differs between the two guests after client-side scripts ran`,
                    });
                }
            } finally {
                await a.context.close();
                await b.context.close();
            }
        }
    });

    test('B02 guest cookies arrive through uncacheable requests with safe attributes', { tag: [tags.smoke] }, async (
        { page, context, cfg, pages, baseURL },
        testInfo
    ) => {
        const settled = sectionLoadSettled(page, cfg.paths.sectionLoad, cfg.timeouts.sectionLoadMs);
        const doc = await documentOf(await page.goto(pages.home), 'home');
        expect(
            doc.headers['set-cookie'],
            'the home document sets a cookie: cookies must come from uncacheable requests, not from the cached page'
        ).toBeUndefined();
        const sectionResponse = await settled;
        testInfo.annotations.push({
            type: 'section-load',
            description: sectionResponse
                ? `${sectionResponse.status()} ${sectionResponse.url()}`
                : 'no section load observed',
        });

        const cookies = await context.cookies();
        testInfo.annotations.push({ type: 'cookies', description: cookies.map((c) => c.name).join(', ') || 'none' });
        const https = (baseURL ?? '').startsWith('https:');

        const session = cookies.find((c) => c.name === 'PHPSESSID');
        if (session) {
            expect(session.httpOnly, 'PHPSESSID is not HttpOnly: session id readable by scripts').toBe(true);
            expect(session.path, 'PHPSESSID path is not "/": sessions fragment per path').toBe('/');
            if (https) {
                expect(session.secure, 'PHPSESSID is not Secure on an https store').toBe(true);
            }
        } else {
            testInfo.annotations.push({
                type: 'cookies',
                description: 'no PHPSESSID for a guest (sessionless guest browsing)',
            });
        }

        const formKey = cookies.find((c) => c.name === 'form_key');
        if (formKey) {
            expect(formKey.path, 'form_key path is not "/": forms on other paths will fail CSRF validation').toBe('/');
        }

        const vary = cookies.find((c) => c.name === 'X-Magento-Vary');
        if (vary) {
            testInfo.annotations.push({
                type: 'vary',
                description: 'guest received X-Magento-Vary: non-default context data (currency, store, custom ' +
                    'context) splits the guest cache per cookie value',
            });
        }

        const domainSuffix = cfg.flags.cookieDomain ? cfg.flags.cookieDomain.replace(/^\./, '') : null;
        if (domainSuffix) {
            const offenders = cookies
                .filter((c) => !c.domain.replace(/^\./, '').endsWith(domainSuffix))
                .map((c) => `${c.name}@${c.domain}`);
            expect(
                offenders,
                `cookies outside flags.cookieDomain "${cfg.flags.cookieDomain}": ` +
                    'sessions will not be shared between stores'
            ).toEqual([]);
        }
    });
});
