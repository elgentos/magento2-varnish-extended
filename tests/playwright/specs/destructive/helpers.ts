import { VarnishConfig } from '../../lib/config';
import { CacheResponse, describeResponse } from '../../lib/http';

export type PurgeMode = 'ban' | 'xkey' | 'xkey-softpurge';

/** Header the elgentos PurgeCache model adds when soft purging is enabled (see etc/varnish6.vcl). */
export const SOFT_PURGE_HEADER = 'X-Magento-Purge-Soft';

/** Age (seconds) below which a HIT counts as "freshly fetched after a soft purge". */
export const FRESH_AGE_SECONDS = 5;

export function effectivePurgeMode(cfg: VarnishConfig): PurgeMode {
    if (cfg.purgeMode !== 'auto') {
        return cfg.purgeMode;
    }
    if (cfg.flags.softpurge) {
        return 'xkey-softpurge';
    }
    return cfg.flags.xkey ? 'xkey' : 'ban';
}

/** True when the machine running the tests is listed in the Varnish purge ACL. */
export function clientInPurgeAcl(): boolean {
    return process.env.VARNISH_PURGE_CLIENT_IN_ACL === '1';
}

export interface PollResult<T> {
    value: T;
    satisfied: boolean;
    attempts: number;
    elapsedMs: number;
}

/**
 * Calls `probe` until `predicate` accepts its result or the timeout passes.
 * Always returns the last value, so the caller can print it in a failure message.
 */
export async function pollUntil<T>(
    probe: () => Promise<T>,
    predicate: (value: T) => boolean,
    timeoutMs: number,
    intervalMs: number = 500,
): Promise<PollResult<T>> {
    const started = Date.now();
    let attempts = 0;
    let value = await probe();
    attempts++;
    while (!predicate(value) && Date.now() - started < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        value = await probe();
        attempts++;
    }
    return { value, satisfied: predicate(value), attempts, elapsedMs: Date.now() - started };
}

/** A response that was fetched from the backend after the purge, in any purge mode. */
export function isFresh(res: CacheResponse): boolean {
    if (res.cacheStatus === 'MISS' || res.cacheStatus === 'MISS-FORCED') {
        return true;
    }
    return res.cacheStatus === 'HIT' && res.age !== null && res.age < FRESH_AGE_SECONDS;
}

/**
 * What a purge must have done to an object, per purge mode:
 * ban/xkey remove the object (next request is a MISS),
 * xkey-softpurge expires it (next request is HIT-GRACE while a background fetch runs, then a fresh object).
 */
export function isInvalidated(res: CacheResponse, mode: PurgeMode): boolean {
    if (mode === 'xkey-softpurge') {
        return res.cacheStatus === 'HIT-GRACE' || isFresh(res);
    }
    return isFresh(res);
}

export function invalidationExpectation(mode: PurgeMode): string {
    return mode === 'xkey-softpurge'
        ? 'HIT-GRACE (stale served while refreshing) or a fresh object'
        : 'a MISS';
}

export function describePoll(result: PollResult<CacheResponse>): string {
    return `after ${result.attempts} request(s) in ${result.elapsedMs}ms\n${describeResponse(result.value)}`;
}
