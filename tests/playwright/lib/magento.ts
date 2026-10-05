import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { APIRequestContext, Page } from '@playwright/test';
import { FixtureCustomerSpec, StoreConfig, VarnishConfig, projectDir, resultsDir } from './config';
import { CacheClient, CacheResponse } from './http';

export interface Account {
    key: string;
    email: string;
    password: string;
    firstname: string;
    lastname: string;
    token: string;
    groupId: number;
    websiteId: number;
    storeId?: number;
    storeCode?: string;
    attributes?: Record<string, string>;
}

export interface AccountsState {
    createdAt: string;
    customers: Record<string, Account>;
}

export interface CliResult {
    status: number;
    stdout: string;
    stderr: string;
}

function findMagentoRoot(start: string): string | null {
    let dir = path.resolve(start);
    for (let i = 0; i < 12; i++) {
        if (fs.existsSync(path.join(dir, 'bin', 'magento'))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }
    return null;
}

/**
 * Thin wrapper around `bin/magento` (or magerun2, or an ssh-prefixed command).
 * MAGENTO_CLI examples: "php bin/magento", "magerun2", "ssh app@host php /data/web/magento2/bin/magento".
 */
export class MagentoCli {
    readonly command: string | null;
    readonly root: string | null;

    constructor() {
        this.root = process.env.MAGENTO_ROOT ? path.resolve(process.env.MAGENTO_ROOT) : findMagentoRoot(projectDir());
        const fromEnv = process.env.MAGENTO_CLI;
        if (fromEnv !== undefined) {
            this.command = fromEnv.trim() === '' ? null : fromEnv.trim();
        } else {
            this.command = this.root ? 'php bin/magento' : null;
        }
    }

    available(): boolean {
        return this.command !== null;
    }

    /** True when the CLI runs on this machine, so env.php can be read directly. */
    isLocal(): boolean {
        return this.root !== null && !(this.command ?? '').startsWith('ssh ');
    }

    run(args: string[], options: { allowFailure?: boolean; timeoutMs?: number } = {}): CliResult {
        if (!this.command) {
            throw new Error('No Magento CLI available. Set MAGENTO_CLI (for example "php bin/magento") or MAGENTO_ROOT');
        }
        const quoted = args.map((a) => (/^[A-Za-z0-9_\-=.,:/@%+]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`));
        const line = `${this.command} ${quoted.join(' ')}`;
        const result = spawnSync(line, {
            shell: true,
            cwd: this.root ?? process.cwd(),
            encoding: 'utf8',
            timeout: options.timeoutMs ?? 300000,
            env: { ...process.env },
        });
        const out: CliResult = {
            status: result.status ?? 1,
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? '',
        };
        if (out.status !== 0 && !options.allowFailure) {
            throw new Error(`Command failed (${out.status}): ${line}\n${out.stdout}\n${out.stderr}`);
        }
        return out;
    }

    /** Value of a config path as `config:show` prints it, or null when unset or unavailable. */
    configShow(configPath: string, scope?: { scope: string; code: string }): string | null {
        if (!this.available()) {
            return null;
        }
        const args = ['config:show'];
        if (scope) {
            args.push(`--scope=${scope.scope}`, `--scope-code=${scope.code}`);
        }
        args.push(configPath);
        const result = this.run(args, { allowFailure: true });
        if (result.status !== 0) {
            return null;
        }
        const value = result.stdout.trim();
        return value === '' ? null : value;
    }

    /** Reads a key from app/etc/env.php. Local installs only. */
    envValue<T = unknown>(key: string): T | null {
        if (!this.isLocal() || !this.root) {
            return null;
        }
        const script = `echo json_encode((include ${JSON.stringify(path.join(this.root, 'app/etc/env.php'))})[${JSON.stringify(key)}] ?? null);`;
        const result = spawnSync('php', ['-r', script], { cwd: this.root, encoding: 'utf8' });
        if (result.status !== 0) {
            return null;
        }
        try {
            return JSON.parse(result.stdout.trim()) as T;
        } catch {
            return null;
        }
    }

    cacheClean(types: string[]): void {
        this.run(['cache:clean', ...types]);
    }

    fixturesCreate(spec: FixtureCustomerSpec[], extraAttributes: Record<string, string>, outFile: string): AccountsState {
        const specFile = path.join(resultsDir(), 'varnish-fixtures-spec.json');
        const expanded = spec.map((customer, index) => ({
            key: customer.key,
            website: customer.website ?? String(customer.websiteId ?? 1),
            groupId: customer.groupId,
            storeCode: customer.storeCode,
            attributes: Object.fromEntries(
                Object.entries({ ...extraAttributes, ...(customer.attributes ?? {}) }).map(([k, v]) => [
                    k,
                    String(v).replace(/%d/g, String(index + 1)),
                ])
            ),
        }));
        fs.writeFileSync(specFile, JSON.stringify(expanded, null, 2));
        this.run(['varnish:test:fixtures', 'create', `--spec=${specFile}`, `--output=${outFile}`]);
        const state = JSON.parse(fs.readFileSync(outFile, 'utf8')) as AccountsState;
        for (const [key, account] of Object.entries(state.customers)) {
            account.key = key;
        }
        fs.writeFileSync(outFile, JSON.stringify(state, null, 2));
        return state;
    }

    fixturesCleanup(outFile: string): void {
        if (!fs.existsSync(outFile)) {
            return;
        }
        this.run(['varnish:test:fixtures', 'cleanup', `--output=${outFile}`], { allowFailure: true });
    }

    touch(target: { sku?: string | null; categoryId?: number | null }): void {
        const args = ['varnish:test:fixtures', 'touch'];
        if (target.sku) {
            args.push(`--sku=${target.sku}`);
        }
        if (target.categoryId) {
            args.push(`--category=${target.categoryId}`);
        }
        this.run(args);
    }
}

export function accountsFile(): string {
    return path.join(resultsDir(), 'varnish-accounts.json');
}

function envKey(key: string): string {
    return key.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/** Accounts from the fixtures step, or from VARNISH_ACCOUNT_<KEY>_EMAIL / _PASSWORD in provided mode. */
export function loadAccounts(config: VarnishConfig): Record<string, Account> {
    const file = accountsFile();
    if (fs.existsSync(file)) {
        return (JSON.parse(fs.readFileSync(file, 'utf8')) as AccountsState).customers;
    }
    const accounts: Record<string, Account> = {};
    for (const spec of config.fixtures.customers) {
        const email = process.env[`VARNISH_ACCOUNT_${envKey(spec.key)}_EMAIL`];
        const password = process.env[`VARNISH_ACCOUNT_${envKey(spec.key)}_PASSWORD`];
        if (email && password) {
            accounts[spec.key] = {
                key: spec.key,
                email,
                password,
                firstname: process.env[`VARNISH_ACCOUNT_${envKey(spec.key)}_FIRSTNAME`] ?? '',
                lastname: process.env[`VARNISH_ACCOUNT_${envKey(spec.key)}_LASTNAME`] ?? '',
                token: '',
                groupId: spec.groupId,
                websiteId: spec.websiteId ?? 1,
                storeCode: spec.storeCode,
                attributes: spec.attributes,
            };
        }
    }
    return accounts;
}

/** Accounts usable on a store: same website first, otherwise all (accounts shared globally). */
export function accountsForStore(accounts: Record<string, Account>, store: StoreConfig): Account[] {
    const all = Object.values(accounts);
    const sameWebsite = all.filter((a) => a.websiteId === store.websiteId);
    return sameWebsite.length > 0 ? sameWebsite : all;
}

/** Two accounts in the same customer group plus one in another group, when available. */
export function accountRoles(accounts: Record<string, Account>, store: StoreConfig): { a: Account | null; b: Account | null; other: Account | null } {
    const list = accountsForStore(accounts, store);
    const byGroup = new Map<number, Account[]>();
    for (const account of list) {
        byGroup.set(account.groupId, [...(byGroup.get(account.groupId) ?? []), account]);
    }
    const pair = [...byGroup.values()].find((group) => group.length >= 2);
    const a = pair?.[0] ?? list[0] ?? null;
    const b = pair?.[1] ?? null;
    const other = list.find((acc) => a && acc.groupId !== a.groupId) ?? null;
    return { a, b, other };
}

/** Strings that must never show up in a shared cache object. */
export function piiMarkers(config: VarnishConfig, accounts: Record<string, Account>): string[] {
    const markers = new Set<string>(config.pii.extraMarkers);
    if (config.pii.fromFixtures) {
        for (const account of Object.values(accounts)) {
            for (const value of [account.email, account.firstname, account.lastname, account.token]) {
                if (value) {
                    markers.add(value);
                }
            }
            for (const value of Object.values(account.attributes ?? {})) {
                if (value && value.length >= 6 && !/^(approved|pending|1|0)$/.test(value)) {
                    markers.add(value);
                }
            }
        }
    }
    return [...markers];
}

export interface RequestSession {
    context: APIRequestContext;
    response: CacheResponse;
    cookies: Array<{ name: string; value: string; domain: string; path: string; httpOnly: boolean; secure: boolean; sameSite: string }>;
    cookieHeader: string;
    varyCookie: string | null;
}

function randomFormKey(): string {
    return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

/**
 * Logs in without a browser: GET the login page for a session and form key, then POST loginPost.
 * The returned context carries the session cookies for follow-up requests.
 */
export async function loginViaRequest(client: CacheClient, config: VarnishConfig, account: Account): Promise<RequestSession> {
    const context = await client.newContext();
    const loginPage = await client.get(config.paths.loginPage, { context, maxRedirects: 2 });

    let formKey = (await context.storageState()).cookies.find((c) => c.name === 'form_key')?.value;
    if (!formKey) {
        const match = loginPage.body.match(/name=["']form_key["'][^>]*value=["']([^"']+)["']/);
        formKey = match?.[1];
    }
    if (!formKey) {
        formKey = randomFormKey();
    }

    const response = await client.post(config.paths.loginPost, {
        context,
        cookies: { form_key: formKey },
        form: {
            form_key: formKey,
            'login[username]': account.email,
            'login[password]': account.password,
            send: '',
        },
        maxRedirects: 0,
    });

    const cookies = (await context.storageState()).cookies as RequestSession['cookies'];
    return {
        context,
        response,
        cookies,
        cookieHeader: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
        varyCookie: cookies.find((c) => c.name === 'X-Magento-Vary')?.value ?? null,
    };
}

/**
 * Logs in through the real login form. When hooks are passed, `beforeLogin` runs on the loaded
 * login page (for example to dismiss a consent overlay that would block the submit button).
 */
export async function loginViaBrowser(
    page: Page,
    config: VarnishConfig,
    account: Account,
    hooks: { beforeLogin?(page: Page): Promise<void> } = {}
): Promise<void> {
    await page.goto(config.paths.loginPage, { waitUntil: 'domcontentloaded' });
    if (hooks.beforeLogin) {
        await hooks.beforeLogin(page);
    }
    const email = page.locator(config.selectors.loginEmail).filter({ visible: true }).first();
    await email.fill(account.email);
    await page.locator(config.selectors.loginPassword).filter({ visible: true }).first().fill(account.password);

    // Themes often render a second, hidden login form (header, mobile). Submit the form that holds the visible
    // email field; fall back to the configured selector, visible matches only.
    const form = email.locator('xpath=ancestor::form[1]');
    const inForm = form.locator("button[type='submit'], input[type='submit']").filter({ visible: true });
    const submit = (await inForm.count()) > 0
        ? inForm.first()
        : page.locator(config.selectors.loginSubmit).filter({ visible: true }).first();

    await Promise.all([
        page.waitForURL((url) => !url.pathname.includes('/customer/account/login'), { timeout: 30000 }),
        submit.click(),
    ]);
}

export async function isLoggedInViaSection(page: Page, config: VarnishConfig): Promise<boolean> {
    const response = await page.request.get(`${config.paths.sectionLoad}?sections=customer&force_new_section_timestamp=true`, {
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    if (!response.ok()) {
        return false;
    }
    const data = (await response.json()) as { customer?: { firstname?: string } };
    return Boolean(data.customer?.firstname);
}
