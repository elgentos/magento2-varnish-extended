import { defineConfig, devices, PlaywrightTestProject } from '@playwright/test';
import * as path from 'path';
import { environment, loadConfig, projectDir, projectSpecsDir, resultsDir } from './lib/config';

/*
 * Project graph:
 *   preflight -> fixtures -> request:<store> / browser:<store> / project:<store> -> destructive -> fixtures-teardown
 *
 * Gates:
 *   VARNISH_ENV=production     never registers fixtures or destructive projects
 *   VARNISH_SKIP_DESTRUCTIVE=1 skips destructive on any environment
 *   VARNISH_SKIP_BROWSER=1     request specs only
 *   VARNISH_INCLUDE_EDGE=1     also runs @edge tests (known VCL quirks, documented with test.fail)
 */

const cfg = loadConfig();
const env = environment();
const here = __dirname;
const stores = cfg.stores.filter((s) => s.baseUrl && s.baseUrl !== '/');

if (stores.length === 0) {
    throw new Error('No store with a baseUrl. Set VARNISH_BASE_URL or stores[].baseUrl in varnish.config.json');
}

const fixturesEnabled = env !== 'production' && cfg.fixtures.mode === 'cli';
const destructiveEnabled = env !== 'production' && process.env.VARNISH_SKIP_DESTRUCTIVE !== '1';
const includeEdge = process.env.VARNISH_INCLUDE_EDGE === '1';
const browsersEnabled = process.env.VARNISH_SKIP_BROWSER !== '1';

const setupDir = path.join(here, 'setup');
const baseDeps = ['preflight', ...(fixturesEnabled ? ['fixtures'] : [])];
// Browser specs walk the whole page set with several visitors each; scale their budget with the page set.
const browserTimeout = Math.max(120000, 45000 * cfg.pageSet.length);

const projects: PlaywrightTestProject[] = [
    { name: 'preflight', testDir: setupDir, testMatch: /preflight\.setup\.ts/, use: { storeCode: stores[0].code } },
];

if (fixturesEnabled) {
    projects.push(
        {
            name: 'fixtures',
            testDir: setupDir,
            testMatch: /fixtures\.setup\.ts/,
            dependencies: ['preflight'],
            teardown: 'fixtures-teardown',
            use: { storeCode: stores[0].code },
        },
        { name: 'fixtures-teardown', testDir: setupDir, testMatch: /fixtures\.teardown\.ts/, use: { storeCode: stores[0].code } }
    );
}

const perStoreNames: string[] = [];
const overlaySpecs = projectSpecsDir();

for (const store of stores) {
    const request = `request:${store.code}`;
    perStoreNames.push(request);
    projects.push({
        name: request,
        testDir: path.join(here, 'specs', 'request'),
        dependencies: baseDeps,
        use: { storeCode: store.code },
    });

    if (browsersEnabled) {
        const browser = `browser:${store.code}`;
        perStoreNames.push(browser);
        projects.push({
            name: browser,
            testDir: path.join(here, 'specs', 'browser'),
            dependencies: baseDeps,
            timeout: browserTimeout,
            use: { ...devices['Desktop Chrome'], storeCode: store.code },
        });
    }

    if (overlaySpecs) {
        const project = `project:${store.code}`;
        perStoreNames.push(project);
        projects.push({
            name: project,
            testDir: overlaySpecs,
            dependencies: baseDeps,
            timeout: browserTimeout,
            use: { ...devices['Desktop Chrome'], storeCode: store.code },
        });
    }
}

if (destructiveEnabled) {
    // In a full run destructive waits for every other project and is skipped by Playwright when one of them
    // failed. VARNISH_ONLY_DESTRUCTIVE=1 runs it after preflight and fixtures only (npm run destructive).
    const destructiveOnly = process.env.VARNISH_ONLY_DESTRUCTIVE === '1';
    projects.push({
        name: 'destructive',
        testDir: path.join(here, 'specs', 'destructive'),
        dependencies: destructiveOnly ? baseDeps : perStoreNames,
        fullyParallel: false,
        use: { storeCode: stores[0].code },
    });
}

export default defineConfig<{ storeCode: string }>({
    projects,
    fullyParallel: true,
    workers: process.env.VARNISH_WORKERS ? Number(process.env.VARNISH_WORKERS) : 4,
    retries: 0,
    timeout: 90000,
    expect: { timeout: 10000 },
    forbidOnly: !!process.env.CI,
    grepInvert: includeEdge ? undefined : /@edge/,
    outputDir: path.join(resultsDir(), 'artifacts'),
    reporter: [
        ['list'],
        ['html', { outputFolder: path.join(projectDir(), 'playwright-report'), open: 'never' }],
        ['json', { outputFile: path.join(resultsDir(), 'varnish-report.json') }],
    ],
    use: {
        ignoreHTTPSErrors: true,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) VarnishPlaywright/1.0',
    },
});
