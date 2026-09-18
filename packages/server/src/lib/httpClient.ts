/**
 * Shared undici dispatchers for outbound requests.
 *
 * undici 7 removed the per-request `maxRedirections` option — redirect handling
 * is now a dispatcher interceptor — so following redirects has to be configured
 * once, here, rather than at each call site.
 */
import { Agent, interceptors } from 'undici';

/**
 * Metadata calls: search, post detail, size probes, posters. Short-lived, so a
 * small pool with brief timeouts is right.
 */
export const metadataDispatcher = new Agent({
  connectTimeout: 10_000,
  keepAliveTimeout: 10_000,
  connections: 16,
}).compose(interceptors.redirect({ maxRedirections: 5 }));

/**
 * File transfers. `bodyTimeout` is deliberately left to the caller: a download
 * is long-running and its own stall detection governs when to give up, not a
 * blanket timeout that would kill a healthy multi-gigabyte transfer.
 */
export const downloadDispatcher = new Agent({
  connectTimeout: 20_000,
  keepAliveTimeout: 30_000,
  connections: 8,
}).compose(interceptors.redirect({ maxRedirections: 5 }));

export async function closeDispatchers(): Promise<void> {
  await Promise.allSettled([metadataDispatcher.close(), downloadDispatcher.close()]);
}
