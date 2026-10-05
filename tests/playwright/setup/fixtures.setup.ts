import * as fs from 'fs';
import { test, expect } from '../lib/fixtures';
import { accountsFile, loadAccounts, loginViaRequest } from '../lib/magento';
import { CacheClient } from '../lib/http';

/**
 * Creates the disposable customers through `bin/magento varnish:test:fixtures create`
 * and proves that at least one of them can log in on every configured store.
 */
test.describe.configure({ mode: 'serial' });

test('fixtures: create customers via CLI', async ({ magento, cfg, env }) => {
    test.skip(env === 'production', 'fixtures are never created on production');
    test.skip(cfg.fixtures.mode !== 'cli', `fixture mode is ${cfg.fixtures.mode}`);
    test.skip(!magento.available(), 'no Magento CLI available');

    const file = accountsFile();
    if (fs.existsSync(file)) {
        magento.fixturesCleanup(file);
    }
    const state = magento.fixturesCreate(cfg.fixtures.customers, cfg.fixtures.extraAttributes, file);
    expect(Object.keys(state.customers).length, 'no customers were created').toBeGreaterThan(0);
});

test('fixtures: accounts can log in', async ({ cfg }, testInfo) => {
    const accounts = loadAccounts(cfg);
    test.skip(Object.keys(accounts).length === 0, 'no fixture accounts (cli mode disabled and no VARNISH_ACCOUNT_* env)');

    const failures: string[] = [];
    for (const store of cfg.stores) {
        const client = new CacheClient(store, cfg);
        const candidates = Object.values(accounts).filter((a) => a.websiteId === store.websiteId);
        const list = candidates.length > 0 ? candidates : Object.values(accounts);
        for (const account of list) {
            const session = await loginViaRequest(client, cfg, account);
            await session.context.dispose();
            const location = session.response.headers['location'] ?? '';
            const ok = session.response.status === 302 && !location.includes('/customer/account/login');
            testInfo.annotations.push({
                type: 'login',
                description: `${store.code} ${account.key} (group ${account.groupId}): ${session.response.status} -> ${location} vary=${session.varyCookie ? 'yes' : 'no'}`,
            });
            if (!ok) {
                failures.push(`${store.code}/${account.key}: ${session.response.status} ${location}`);
            }
        }
    }
    expect(failures, 'some fixture accounts cannot log in (approval attribute, website scope, captcha?)').toEqual([]);
});
