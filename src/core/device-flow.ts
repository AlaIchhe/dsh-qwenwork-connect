/**
 * OAuth2 PKCE Device Flow for QwenWork (.cn and .ai).
 */

import crypto from 'node:crypto';
import { siteOf, type SiteId } from '../shared/sites.js';
import {
  decodeJwtPayload,
  getOrCreateMachineId,
  normalizeCredential,
  type CredentialStore,
  type StoredCredential,
} from './credentials.js';

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

export function createPkce(): PkcePair {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildAuthUrl(params: {
  readonly siteId: SiteId;
  readonly challenge: string;
  readonly nonce: string;
  readonly machineId: string;
  readonly base?: string;
}): string {
  const site = siteOf(params.siteId);
  const qs = new URLSearchParams({
    challenge: params.challenge,
    challenge_method: 'S256',
    nonce: params.nonce,
    machine_id: params.machineId,
    client_id: site.clientId,
    redirect_uri: site.redirectUri,
  });
  return `${params.base ?? site.gateway}/device/selectAccounts?${qs.toString()}`;
}

export interface DevicePollPayload {
  readonly token: string;
  readonly refresh_token?: string;
  readonly refreshToken?: string;
  readonly expires_at?: string | number;
  readonly user_id?: string;
  readonly user_name?: string;
}

export async function pollDeviceToken(options: {
  readonly siteId: SiteId;
  readonly nonce: string;
  readonly verifier: string;
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly base?: string;
  readonly signal?: AbortSignal;
}): Promise<DevicePollPayload> {
  const {
    siteId,
    nonce,
    verifier,
    intervalMs = 2_000,
    timeoutMs = 5 * 60 * 1000,
    fetchImpl = globalThis.fetch,
    base = siteOf(siteId).gateway,
    signal,
  } = options;

  const qs = new URLSearchParams({ nonce, verifier, challenge_method: 'S256' });
  const url = `${base}/api/v1/deviceToken/poll?${qs.toString()}`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new Error('login aborted');
    }

    let response: Response;
    try {
      response = await fetchImpl(url, { signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      await cancellableSleep(intervalMs, signal);
      continue;
    }

    if (response.status === 200) {
      const body = (await response.json().catch(() => ({}))) as Partial<DevicePollPayload>;
      if (typeof body.token === 'string' && body.token.length > 0) {
        return body as DevicePollPayload;
      }
    } else if (response.status !== 404) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `deviceToken/poll HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
      );
    }

    await cancellableSleep(intervalMs, signal);
  }

  throw new Error(`login timed out after ${Math.round(timeoutMs / 1000)}s`);
}

export function credentialFromPollPayload(
  payload: DevicePollPayload,
  params: { readonly siteId: SiteId; readonly machineId: string },
): StoredCredential {
  const claims = decodeJwtPayload(payload.token) ?? {};
  return normalizeCredential(
    {
      schemaVersion: 2,
      token: payload.token,
      refreshToken: payload.refresh_token ?? payload.refreshToken ?? '',
      expiresAt: payload.expires_at ?? claims.exp,
      loginDeviceId: params.machineId,
      loginMethod: 'device-flow',
      user: {
        id: payload.user_id ?? claims.user_id ?? claims.sub ?? null,
        name: payload.user_name ?? claims.username ?? null,
        username: claims.username ?? null,
        email: claims.email ?? null,
        organizationId: claims.biz_org_id ?? null,
        dataPolicyAgreed: true,
      },
    },
    params.siteId,
  );
}

export async function startDeviceLogin(options: {
  readonly siteId: SiteId;
  readonly store: CredentialStore;
  readonly machineIdPath?: string;
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly base?: string;
  readonly signal?: AbortSignal;
  readonly onUrl?: (url: string) => void;
}): Promise<{
  readonly siteId: SiteId;
  readonly url: string;
  readonly machineId: string;
  readonly credential: StoredCredential;
}> {
  const machineId = await getOrCreateMachineId(options.machineIdPath);
  const { verifier, challenge } = createPkce();
  const nonce = crypto.randomUUID();
  const url = buildAuthUrl({
    siteId: options.siteId,
    challenge,
    nonce,
    machineId,
    base: options.base,
  });

  options.onUrl?.(url);

  const payload = await pollDeviceToken({
    siteId: options.siteId,
    nonce,
    verifier,
    intervalMs: options.intervalMs,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
    base: options.base,
    signal: options.signal,
  });

  const credential = credentialFromPollPayload(payload, {
    siteId: options.siteId,
    machineId,
  });
  await options.store.write(options.siteId, credential);

  return {
    siteId: options.siteId,
    url,
    machineId,
    credential,
  };
}

function cancellableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('login aborted'));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('login aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
