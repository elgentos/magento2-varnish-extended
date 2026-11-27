import { test as base, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import {
    Environment,
    Pages,
    StoreConfig,
    VarnishConfig,
    environment,
    loadConfig,
    pageSetFor,
    pagesFor,
    projectDir,
    storeByCode,
} from './config';
import { CacheClient, splitCredentials } from './http';
import { Account, MagentoCli, loadAccounts } from './magento';

/** Optional project hooks. Implement what the project needs in <overlay>/hooks.ts. */
export interface Hooks {
    beforeLogin?(page: Page): Promise<void>;
    declineOptionalCookies?(page: Page): Promise<void>;
    acceptAllCookies?(page: Page): Promise<void>;
    switchCurrency?(page: Page, code: string): Promise<void>;
    backendDown?(): Promise<void>;
    backendUp?(): Promise<void>;
}

let hooksCache: Hooks | null = null;

export async function loadHooks(): Promise<Hooks> {
    if (hooksCache) {
        return hooksCache;
    }
    const candidates = ['hooks.ts', 'hooks.js'].map((f) => path.join(projectDir(), f));
    const file = candidates.find((f) => fs.existsSync(f));
    if (!file) {
        hooksCache = {};
        return hooksCache;
    }
    // require() goes through Playwright's TypeScript transform; a native import() of a .ts file does not.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(file) as { default?: Hooks; hooks?: Hooks };
    hooksCache = mod.default ?? mod.hooks ?? (mod as Hooks);
    return hooksCache;
}

export const tags = {
    smoke: '@smoke',
    readonly: '@readonly',
    fixtures: '@fixtures',
    destructive: '@destructive',
    edge: '@edge',
    project: '@project',
};

interface VarnishFixtures {
    storeCode: string;
    cfg: VarnishConfig;
    env: Environment;
    store: StoreConfig;
    pages: Pages;
    pageSet: Array<{ key: keyof Pages; path: string }>;
    cache: CacheClient;
    magento: MagentoCli;
    accounts: Record<string, Account>;
    hooks: Hooks;
}

export const test = base.extend<VarnishFixtures>({
    storeCode: ['', { option: true }],
    cfg: async ({}, use) => {
        await use(loadConfig());
    },
    env: async ({}, use) => {
        await use(environment());
    },
    store: async ({ cfg, storeCode }, use) => {
        await use(storeByCode(cfg, storeCode));
    },
    pages: async ({ cfg, store }, use) => {
        await use(pagesFor(cfg, store));
    },
    pageSet: async ({ cfg, store }, use) => {
        await use(pageSetFor(cfg, store));
    },
    cache: async ({ cfg, store }, use) => {
        await use(new CacheClient(store, cfg));
    },
    magento: async ({}, use) => {
        await use(new MagentoCli());
    },
    accounts: async ({ cfg }, use) => {
        await use(loadAccounts(cfg));
    },
    hooks: async ({}, use) => {
        await use(await loadHooks());
    },
    baseURL: async ({ store }, use) => {
        await use(splitCredentials(store.baseUrl).baseUrl);
    },
    httpCredentials: async ({ store }, use) => {
        await use(splitCredentials(store.baseUrl).httpCredentials);
    },
});

export { expect };

/** Skips the test when the page is not configured for this store. */
export function requirePage(pages: Pages, key: keyof Pages): string {
    const value = pages[key];
    test.skip(!value, `pages.${key} is not configured for this store`);
    return value as string;
}

/** Skips the test when the fixture account is not available. */
export function requireAccount(account: Account | null | undefined, description: string): Account {
    test.skip(!account, `no fixture account available for: ${description}`);
    return account as Account;
}

export function requireHook<K extends keyof Hooks>(hooks: Hooks, name: K): NonNullable<Hooks[K]> {
    test.skip(!hooks[name], `project hook "${String(name)}" is not implemented in hooks.ts`);
    return hooks[name] as NonNullable<Hooks[K]>;
}

export function requireCli(magento: MagentoCli): void {
    test.skip(!magento.available(), 'no Magento CLI available (set MAGENTO_CLI)');
}
