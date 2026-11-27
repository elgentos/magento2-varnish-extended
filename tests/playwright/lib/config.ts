import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import defaults from '../config/defaults.json';

export interface Pages {
    home: string;
    category: string | null;
    product: string | null;
    cms: string | null;
    search: string;
    notFound: string;
}

export interface StoreConfig {
    code: string;
    baseUrl: string;
    websiteId: number;
    currency: string | null;
    pages: Partial<Pages>;
}

export interface FixtureCustomerSpec {
    key: string;
    groupId: number;
    websiteId?: number;
    website?: string;
    storeCode?: string;
    attributes?: Record<string, string>;
}

export interface ConditionalUrl {
    url: string;
    visibleTo: string;
    guestStatus: number;
    store?: string;
}

export interface LoggedInMarker {
    page: keyof Pages | string;
    selector: string;
    visibleWhenLoggedIn: boolean;
    store?: string;
}

export interface PriceAssertion {
    page: keyof Pages | string;
    store?: string;
    selector?: string;
    expect: Record<string, string>;
}

export interface Flags {
    autodetect: boolean;
    bfcache: boolean;
    cache404: boolean;
    mediaCache: boolean;
    staticCache: boolean;
    xkey: boolean;
    softpurge: boolean;
    gracePeriod: number;
    designExceptions: boolean;
    cookieDomain: string | null;
    passOnCookieRegexes: string[];
    /** Set by preflight: Magento has http_cache_hosts, so purges can reach Varnish. */
    purgeReachable?: boolean;
    magentoCliAvailable?: boolean;
}

export interface VarnishConfig {
    stores: StoreConfig[];
    pages: Pages;
    pageSet: Array<keyof Pages>;
    uncacheablePaths: string[];
    adminPath: string;
    privateUrls: string[];
    conditionalUrls: ConditionalUrl[];
    trackingParamsToAssert: string[];
    unknownParam: string;
    allowedVaryHeaders: string[];
    strippedResponseHeaders: string[];
    flags: Flags;
    purgeMode: 'auto' | 'ban' | 'xkey' | 'xkey-softpurge';
    fixtures: {
        mode: 'cli' | 'provided' | 'none';
        customers: FixtureCustomerSpec[];
        extraAttributes: Record<string, string>;
        purgeProductSku: string | null;
        purgeCategoryId: number | null;
    };
    pii: {
        fromFixtures: boolean;
        extraMarkers: string[];
        checkEncodings: Array<'raw' | 'html' | 'json' | 'url'>;
    };
    normalize: {
        stripRegexes: string[];
        stripSelectors: string[];
    };
    loggedInMarkers: LoggedInMarker[];
    priceAssertions: PriceAssertion[];
    selectors: Record<string, string>;
    paths: Record<string, string>;
    timeouts: { purgePropagationMs: number; sectionLoadMs: number };
    coalescing: { parallelRequests: number };
}

export type Environment = 'local' | 'staging' | 'production';

/** Directory that holds the project overlay (varnish.config.json, hooks.ts, specs/). */
export function projectDir(): string {
    return path.resolve(process.env.VARNISH_PROJECT_DIR || process.cwd());
}

/** Loads <overlay>/.env into process.env without overriding values that are already set. */
function loadDotEnv(): void {
    const file = path.join(projectDir(), '.env');
    if (!fs.existsSync(file)) {
        return;
    }
    for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }
        const eq = line.indexOf('=');
        if (eq <= 0) {
            continue;
        }
        const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (process.env[key] === undefined) {
            process.env[key] = value;
        }
    }
}

loadDotEnv();

/** Where setup steps write state that later projects read. */
export function resultsDir(): string {
    const dir = path.join(projectDir(), 'test-results');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

export function environment(): Environment {
    const value = (process.env.VARNISH_ENV || 'local').toLowerCase();
    if (value === 'production' || value === 'prod') {
        return 'production';
    }
    if (value === 'staging' || value === 'acceptance' || value === 'test') {
        return 'staging';
    }
    return 'local';
}

export function baseUrlFromEnv(): string {
    const url = process.env.VARNISH_BASE_URL || process.env.PLAYWRIGHT_BASE_URL || '';
    if (!url) {
        throw new Error('Set VARNISH_BASE_URL (or PLAYWRIGHT_BASE_URL) to the store front URL');
    }
    return url.endsWith('/') ? url : url + '/';
}

export function readJsonIfExists<T>(file: string): T | null {
    if (!fs.existsSync(file)) {
        return null;
    }
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Objects merge recursively, arrays and scalars from the overlay replace the default. */
export function deepMerge<T>(base: T, overlay: unknown): T {
    if (!isPlainObject(base) || !isPlainObject(overlay)) {
        return (overlay === undefined ? base : overlay) as T;
    }
    const result: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(overlay)) {
        result[key] = deepMerge((base as Record<string, unknown>)[key], value);
    }
    return result as T;
}

function substitute(value: unknown, vars: Record<string, string>): unknown {
    if (typeof value === 'string') {
        return value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (match, name: string) => vars[name] ?? match);
    }
    if (Array.isArray(value)) {
        return value.map((item) => substitute(item, vars));
    }
    if (isPlainObject(value)) {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, vars)]));
    }
    return value;
}

const KNOWN_TOP_LEVEL_KEYS = new Set(Object.keys(defaults));

function validateOverlay(overlay: Record<string, unknown>, file: string): void {
    const unknown = Object.keys(overlay).filter((key) => !KNOWN_TOP_LEVEL_KEYS.has(key));
    if (unknown.length > 0) {
        throw new Error(`Unknown key(s) in ${file}: ${unknown.join(', ')}. Known keys: ${[...KNOWN_TOP_LEVEL_KEYS].join(', ')}`);
    }
}

let cached: VarnishConfig | null = null;

export function loadConfig(): VarnishConfig {
    if (cached) {
        return cached;
    }

    const overlayFile = process.env.VARNISH_CONFIG
        ? path.resolve(process.env.VARNISH_CONFIG)
        : path.join(projectDir(), 'varnish.config.json');
    const overlay = readJsonIfExists<Record<string, unknown>>(overlayFile) ?? {};
    validateOverlay(overlay, overlayFile);

    let config = deepMerge(defaults as unknown as VarnishConfig, overlay);

    const vars: Record<string, string> = {
        VARNISH_BASE_URL: safeBaseUrl(),
        random: randomUUID().slice(0, 8),
    };
    config = substitute(config, vars) as VarnishConfig;

    if (process.env.VARNISH_FIXTURE_MODE) {
        config.fixtures.mode = process.env.VARNISH_FIXTURE_MODE as VarnishConfig['fixtures']['mode'];
    }
    if (environment() === 'production' && config.fixtures.mode === 'cli') {
        config.fixtures.mode = 'provided';
    }

    if (config.flags.autodetect) {
        const detected = readJsonIfExists<Partial<Flags>>(path.join(resultsDir(), 'varnish-flags.json'));
        if (detected) {
            config.flags = { ...config.flags, ...detected };
        }
    }

    config.stores = config.stores.map((store) => ({
        ...store,
        baseUrl: store.baseUrl.endsWith('/') ? store.baseUrl : store.baseUrl + '/',
        pages: store.pages ?? {},
    }));

    cached = config;
    return config;
}

function safeBaseUrl(): string {
    try {
        return baseUrlFromEnv();
    } catch {
        return '';
    }
}

export function storeByCode(config: VarnishConfig, code: string): StoreConfig {
    const store = config.stores.find((s) => s.code === code) ?? config.stores[0];
    if (!store) {
        throw new Error('No stores configured');
    }
    if (!store.baseUrl || store.baseUrl === '/') {
        throw new Error(`Store "${store.code}" has no baseUrl. Set VARNISH_BASE_URL or stores[].baseUrl in the overlay`);
    }
    return store;
}

/** Page paths for a store: store-level overrides win over the global pages. */
export function pagesFor(config: VarnishConfig, store: StoreConfig): Pages {
    return { ...config.pages, ...store.pages } as Pages;
}

/** Only the configured page keys that have a path. */
export function pageSetFor(config: VarnishConfig, store: StoreConfig): Array<{ key: keyof Pages; path: string }> {
    const pages = pagesFor(config, store);
    return config.pageSet
        .filter((key) => typeof pages[key] === 'string' && (pages[key] as string).length > 0)
        .map((key) => ({ key, path: pages[key] as string }));
}

export function projectSpecsDir(): string | null {
    const dir = path.join(projectDir(), 'specs');
    return fs.existsSync(dir) ? dir : null;
}
