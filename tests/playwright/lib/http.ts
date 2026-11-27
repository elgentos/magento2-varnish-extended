import { expect, request as playwrightRequest, APIRequestContext } from '@playwright/test';
import { randomUUID } from 'crypto';
import { Flags, StoreConfig, VarnishConfig } from './config';

export type CacheStatus = 'HIT' | 'HIT-GRACE' | 'MISS' | 'MISS-FORCED' | 'UNCACHEABLE' | 'UNKNOWN';

export interface CacheResponse {
    url: string;
    method: string;
    status: number;
    /** Lower-cased header names; repeated headers are joined with ", ". */
    headers: Record<string, string>;
    headersArray: Array<{ name: string; value: string }>;
    body: string;
    cacheStatus: CacheStatus;
    age: number | null;
    setCookies: string[];
}

export interface RequestOptions {
    headers?: Record<string, string>;
    cookies?: Record<string, string>;
    data?: string | Record<string, unknown>;
    form?: Record<string, string>;
    maxRedirects?: number;
    /** Use an existing context (keeps its cookie jar) instead of a fresh one. */
    context?: APIRequestContext;
    timeout?: number;
}

/** Splits basic-auth credentials out of a URL, the way the elgentos Playwright suite does. */
export function splitCredentials(baseUrl: string): { baseUrl: string; httpCredentials?: { username: string; password: string } } {
    const url = new URL(baseUrl);
    if (!url.username) {
        return { baseUrl };
    }
    const httpCredentials = { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
    url.username = '';
    url.password = '';
    return { baseUrl: url.toString(), httpCredentials };
}

export function cacheStatusOf(headers: Record<string, string>): CacheStatus {
    const debug = (headers['x-magento-cache-debug'] || '').toUpperCase().trim();
    if (['HIT', 'HIT-GRACE', 'MISS', 'MISS-FORCED', 'UNCACHEABLE'].includes(debug)) {
        return debug as CacheStatus;
    }
    // Fallback when the debug header is not exposed: a positive Age means the object came from cache.
    const age = headers['age'];
    if (age !== undefined && Number(age) > 0) {
        return 'HIT';
    }
    return 'UNKNOWN';
}

export function cookieHeader(cookies: Record<string, string>): string {
    return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * HTTP client for cache assertions. Every request uses a fresh APIRequestContext,
 * so no cookie jar builds up between requests unless a context is passed in.
 */
export class CacheClient {
    private readonly origin: string;
    private readonly httpCredentials?: { username: string; password: string };

    constructor(
        public readonly store: StoreConfig,
        private readonly config: VarnishConfig,
    ) {
        const split = splitCredentials(store.baseUrl);
        this.origin = split.baseUrl;
        this.httpCredentials = split.httpCredentials;
    }

    get baseUrl(): string {
        return this.origin;
    }

    get host(): string {
        return new URL(this.origin).host;
    }

    url(pathOrUrl: string): string {
        if (/^https?:\/\//.test(pathOrUrl)) {
            return pathOrUrl;
        }
        return new URL(pathOrUrl.replace(/^\//, ''), this.origin).toString();
    }

    /** A unique, non-tracking query parameter so a test owns its own cache object. */
    buster(): string {
        return `${this.config.unknownParam}=${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    }

    withQuery(path: string, query: string): string {
        if (!query) {
            return path;
        }
        return path.includes('?') ? `${path}&${query}` : `${path}?${query}`;
    }

    withBuster(path: string, buster: string = this.buster()): string {
        return this.withQuery(path, buster);
    }

    async newContext(extra: { storageState?: string; extraHTTPHeaders?: Record<string, string> } = {}): Promise<APIRequestContext> {
        return playwrightRequest.newContext({
            baseURL: this.origin,
            ignoreHTTPSErrors: true,
            httpCredentials: this.httpCredentials,
            ...extra,
        });
    }

    async request(method: string, path: string, options: RequestOptions = {}): Promise<CacheResponse> {
        const ownContext = !options.context;
        const context = options.context ?? (await this.newContext());
        const headers: Record<string, string> = { ...(options.headers ?? {}) };
        if (options.cookies && Object.keys(options.cookies).length > 0) {
            headers['cookie'] = cookieHeader(options.cookies);
        }

        try {
            const response = await context.fetch(this.url(path), {
                method,
                headers,
                data: options.form ? undefined : options.data,
                form: options.form,
                maxRedirects: options.maxRedirects ?? 0,
                timeout: options.timeout ?? 30000,
            });
            const headersArray = response.headersArray().map((h) => ({ name: h.name.toLowerCase(), value: h.value }));
            const merged: Record<string, string> = {};
            for (const h of headersArray) {
                merged[h.name] = merged[h.name] ? `${merged[h.name]}, ${h.value}` : h.value;
            }
            const body = method === 'HEAD' ? '' : await response.text();
            return {
                url: response.url(),
                method,
                status: response.status(),
                headers: merged,
                headersArray,
                body,
                cacheStatus: cacheStatusOf(merged),
                age: merged['age'] !== undefined ? Number(merged['age']) : null,
                setCookies: headersArray.filter((h) => h.name === 'set-cookie').map((h) => h.value),
            };
        } finally {
            if (ownContext) {
                await context.dispose();
            }
        }
    }

    get(path: string, options: RequestOptions = {}): Promise<CacheResponse> {
        return this.request('GET', path, options);
    }

    head(path: string, options: RequestOptions = {}): Promise<CacheResponse> {
        return this.request('HEAD', path, options);
    }

    post(path: string, options: RequestOptions = {}): Promise<CacheResponse> {
        return this.request('POST', path, options);
    }

    /** Requests the same URL twice: the first fills the cache, the second should be served from it. */
    async warm(path: string, options: RequestOptions = {}): Promise<{ cold: CacheResponse; hot: CacheResponse }> {
        const cold = await this.get(path, options);
        const hot = await this.get(path, options);
        return { cold, hot };
    }
}

export function describeResponse(res: CacheResponse): string {
    const interesting = ['x-magento-cache-debug', 'age', 'cache-control', 'set-cookie', 'vary', 'content-type', 'location'];
    const lines = interesting.filter((h) => res.headers[h] !== undefined).map((h) => `  ${h}: ${res.headers[h]}`);
    return `${res.method} ${res.url} -> ${res.status} [${res.cacheStatus}]\n${lines.join('\n')}`;
}

export function expectCacheStatus(res: CacheResponse, expected: CacheStatus | CacheStatus[], message?: string): void {
    const allowed = Array.isArray(expected) ? expected : [expected];
    expect(allowed, `${message ?? 'cache status'}\n${describeResponse(res)}`).toContain(res.cacheStatus);
}

export function expectNotHit(res: CacheResponse, message?: string): void {
    expect(['HIT', 'HIT-GRACE'], `${message ?? 'must not be served from cache'}\n${describeResponse(res)}`).not.toContain(res.cacheStatus);
}

export function expectNoSetCookie(res: CacheResponse, message?: string): void {
    expect(res.setCookies, `${message ?? 'cacheable response must not set cookies'}\n${describeResponse(res)}`).toEqual([]);
}

export function expectStrippedHeaders(res: CacheResponse, stripped: string[]): void {
    const present = stripped.map((h) => h.toLowerCase()).filter((h) => res.headers[h] !== undefined);
    expect(present, `headers that Varnish must strip are present\n${describeResponse(res)}`).toEqual([]);
}

export function expectVaryAllowlist(res: CacheResponse, allowed: string[]): void {
    const vary = (res.headers['vary'] || '')
        .split(',')
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean);
    const offenders = vary.filter((v) => !allowed.map((a) => a.toLowerCase()).includes(v));
    expect(offenders, `Vary header carries values that fragment or kill the cache\n${describeResponse(res)}`).toEqual([]);
}

/** Cache-Control the VCL sends to browsers for cacheable pages, depending on the bfcache flag. */
export function expectCacheControlFor(res: CacheResponse, flags: Flags): void {
    const cc = (res.headers['cache-control'] || '').toLowerCase();
    expect(cc, describeResponse(res)).toContain('must-revalidate');
    expect(cc, describeResponse(res)).toContain('max-age=60');
    if (flags.bfcache) {
        expect(cc, `bfcache is on, so no no-store expected\n${describeResponse(res)}`).not.toContain('no-store');
    } else {
        expect(cc, `bfcache is off, so no-store expected\n${describeResponse(res)}`).toContain('no-store');
    }
}

export function normalizeHtml(html: string, normalize: VarnishConfig['normalize']): string {
    let out = html;
    for (const pattern of normalize.stripRegexes) {
        out = out.replace(new RegExp(pattern, 'g'), '');
    }
    return out.replace(/\s+/g, ' ').trim();
}

export function hasLiteralEsi(body: string): boolean {
    return /<esi:include/i.test(body);
}

/** form_key values printed server side into the HTML (Hyva fills them client side, so they should be empty). */
export function extractFormKeyValues(html: string): string[] {
    const values: string[] = [];
    const re = /name=["']form_key["'][^>]*value=["']([^"']*)["']/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(html)) !== null) {
        if (match[1]) {
            values.push(match[1]);
        }
    }
    return values;
}

function encodeMarker(marker: string, encoding: 'raw' | 'html' | 'json' | 'url'): string {
    switch (encoding) {
        case 'html':
            return marker.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c] as string));
        case 'json':
            return JSON.stringify(marker).slice(1, -1).replace(/@/g, '\\u0040');
        case 'url':
            return encodeURIComponent(marker);
        default:
            return marker;
    }
}

/** Returns the markers (with encoding) found in the body. An empty array means no leak. */
export function findPii(body: string, markers: string[], encodings: Array<'raw' | 'html' | 'json' | 'url'>): string[] {
    const found: string[] = [];
    const haystack = body.toLowerCase();
    for (const marker of markers.filter((m) => m && m.length >= 4)) {
        for (const encoding of encodings) {
            const needle = encodeMarker(marker, encoding).toLowerCase();
            if (needle && haystack.includes(needle)) {
                found.push(`${marker} (${encoding})`);
            }
        }
    }
    return found;
}

/** Collects static and media asset URLs referenced by a page, limited to the same origin. */
export function assetUrls(html: string, origin: string): { static: string[]; media: string[] } {
    const urls = new Set<string>();
    const re = /(?:src|href)=["']([^"']+)["']/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(html)) !== null) {
        urls.add(match[1]);
    }
    const sameOrigin = [...urls]
        .map((u) => {
            try {
                return new URL(u, origin);
            } catch {
                return null;
            }
        })
        .filter((u): u is URL => u !== null && u.origin === new URL(origin).origin);
    return {
        static: sameOrigin.filter((u) => u.pathname.startsWith('/static/')).map((u) => u.toString()).slice(0, 3),
        media: sameOrigin.filter((u) => u.pathname.startsWith('/media/')).map((u) => u.toString()).slice(0, 3),
    };
}
