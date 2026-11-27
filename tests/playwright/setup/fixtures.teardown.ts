import { test } from '../lib/fixtures';
import { accountsFile } from '../lib/magento';

test('fixtures: remove customers', async ({ magento }) => {
    test.skip(process.env.VARNISH_KEEP_FIXTURES === '1', 'VARNISH_KEEP_FIXTURES=1');
    test.skip(!magento.available(), 'no Magento CLI available');
    magento.fixturesCleanup(accountsFile());
});
