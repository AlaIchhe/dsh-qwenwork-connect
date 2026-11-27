/**
 * Shared client-side per-site status store.
 * Deduplicates fetches and shares polling between PluginCard and ComposerCredits.
 */

import { useEffect, useState } from 'react';
import {
  STATUS_PATH,
  STATUS_POLL_INTERVAL_MS,
  pathForSite,
  type SiteStatusResponse,
} from '../shared/contracts.js';
import type { SiteId } from '../shared/sites.js';

type Listener = (state: SiteStatusResponse | null) => void;

interface SiteEntry {
  state: SiteStatusResponse | null;
  listeners: Set<Listener>;
  inflight: Promise<SiteStatusResponse | null> | null;
  timer: ReturnType<typeof setInterval> | null;
}

const entries = new Map<SiteId, SiteEntry>();

function entryOf(siteId: SiteId): SiteEntry {
  let entry = entries.get(siteId);
  if (entry === undefined) {
    entry = { state: null, listeners: new Set(), inflight: null, timer: null };
    entries.set(siteId, entry);
  }
  return entry;
}

function notify(entry: SiteEntry): void {
  for (const listener of entry.listeners) {
    listener(entry.state);
  }
}

export async function fetchSiteStatus(
  siteId: SiteId,
  opts: { force?: boolean; silentError?: boolean; errorPrefix?: string } = {},
): Promise<SiteStatusResponse | null> {
  const entry = entryOf(siteId);
  if (!opts.force && entry.inflight !== null) return entry.inflight;

  const baseUrl = pathForSite(STATUS_PATH, siteId);
  const url = opts.force
    ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}force=1`
    : baseUrl;

  const run = (async () => {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      });
      if (!response.ok) {
        throw new Error(`${opts.errorPrefix ?? 'HTTP'} (${response.status})`);
      }
      const body = (await response.json()) as SiteStatusResponse;
      entry.state = body;
      notify(entry);
      return body;
    } catch (error) {
      if (!opts.silentError) {
        entry.state = {
          status: 'unavailable',
          provider: siteId === 'intl' ? 'qwenwork-intl' : 'qwenwork',
          siteId,
          siteLabel: siteId === 'intl' ? 'QwenWork Global' : 'QwenWork',
          gateway: '',
          error: {
            code: 'FETCH_FAILED',
            message: error instanceof Error ? error.message : String(error),
          },
        };
        notify(entry);
      }
      return entry.state;
    }
  })();

  entry.inflight = run;
  const clear = () => {
    if (entry.inflight === run) entry.inflight = null;
  };
  run.then(clear, clear);
  return run;
}

export function patchSiteStatus(
  siteId: SiteId,
  updater: (prev: SiteStatusResponse | null) => SiteStatusResponse | null,
): void {
  const entry = entryOf(siteId);
  entry.state = updater(entry.state);
  notify(entry);
}

export function useSiteStatus(
  siteId: SiteId,
  active: boolean,
  opts: { initialState?: SiteStatusResponse | null; silentError?: boolean; errorPrefix?: string } = {},
): SiteStatusResponse | null {
  const [state, setState] = useState<SiteStatusResponse | null>(
    () => opts.initialState ?? entryOf(siteId).state,
  );

  useEffect(() => {
    if (!active) return undefined;
    const entry = entryOf(siteId);
    if (entry.state !== null) {
      setState(entry.state);
    } else if (opts.initialState !== undefined) {
      setState(opts.initialState);
    } else {
      setState(null);
    }

    const listener: Listener = (next) => setState(next);
    entry.listeners.add(listener);

    if (entry.timer === null) {
      void fetchSiteStatus(siteId, {
        silentError: opts.silentError,
        errorPrefix: opts.errorPrefix,
      });
      entry.timer = setInterval(() => {
        void fetchSiteStatus(siteId, {
          silentError: opts.silentError,
          errorPrefix: opts.errorPrefix,
        });
      }, STATUS_POLL_INTERVAL_MS);
    } else if (entry.state === null) {
      void fetchSiteStatus(siteId, {
        silentError: opts.silentError,
        errorPrefix: opts.errorPrefix,
      });
    }

    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0 && entry.timer !== null) {
        clearInterval(entry.timer);
        entry.timer = null;
      }
    };
  }, [siteId, active, opts.silentError, opts.errorPrefix, opts.initialState]);

  return state;
}
