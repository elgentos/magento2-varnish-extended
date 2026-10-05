#!/usr/bin/env node
/*
 * Copies the Varnish Playwright suite from the composer package into a project overlay
 * directory as `base/`, so every import resolves against the overlay's node_modules.
 *
 * Usage: node vendor/elgentos/magento2-varnish-extended/tests/playwright/bin/sync.mjs [overlayDir]
 * Default overlayDir is the current working directory.
 */
import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const overlay = resolve(process.argv[2] || process.cwd());
const target = join(overlay, 'base');

mkdirSync(overlay, { recursive: true });
rmSync(target, { recursive: true, force: true });
cpSync(source, target, {
    recursive: true,
    filter: (src) => !/[\\/](node_modules|test-results|playwright-report|\.auth)([\\/]|$)/.test(src),
});

const nodeModules = join(overlay, 'node_modules');
const sibling = join(overlay, '..', 'playwright', 'node_modules');
if (!existsSync(nodeModules) && existsSync(sibling)) {
    symlinkSync(join('..', 'playwright', 'node_modules'), nodeModules, 'dir');
    console.log(`Linked ${nodeModules} -> ../playwright/node_modules`);
}

if (!existsSync(nodeModules)) {
    console.warn('No node_modules next to the overlay: install @playwright/test here, or create the symlink to the playwright suite');
}

console.log(`Synced ${source} -> ${target}`);
