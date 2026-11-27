/**
 * Gateway endpoint resolution (public cloud & enterprise VPC) and configurable
 * per-hop TLS transport with keepAlive pooling and explicit disposal.
 */

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { siteOf, type SiteId } from '../shared/sites.js';
import { decodeJwtPayload, type StoredCredential } from './credentials.js';

export const VPC_MARKER = '.vpc.';

export interface VpcTlsOptions {
  readonly caCertPath?: string;
  readonly insecureTls?: boolean;
}

export function isVpcEndpoint(endpoint: string): boolean {
  return endpoint.includes(VPC_MARKER);
}

/**
 * Derive gateway origin:
 * 1. Enterprise VPC tenant: JWT `iss` origin containing `.vpc.`
 * 2. Public cloud preset for `siteId`
 */
export function resolveGatewayEndpoint(
  credential: Pick<StoredCredential, 'token' | 'siteId'> | null | undefined,
  siteId: SiteId,
): string {
  const iss = credential?.token ? decodeJwtPayload(credential.token)?.iss : undefined;
  if (typeof iss === 'string' && iss !== '') {
    try {
      const origin = new URL(iss).origin;
      if (origin.startsWith('https://') && isVpcEndpoint(origin)) {
        return origin;
      }
    } catch {
      /* ignore invalid iss */
    }
  }
  return siteOf(credential?.siteId ?? siteId).gateway;
}

export interface GatewayTransport {
  fetch(url: string | URL, init?: RequestInit): Promise<Response>;
  dispose(): void;
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
]);

/**
 * Create a disposable fetch wrapper for a specific gateway endpoint.
 * Public cloud endpoints use globalThis.fetch directly.
 * VPC endpoints with custom `caCertPath` or explicit `insecureTls: true`
 * use a scoped, keepAlive-enabled https.Agent without mutating global TLS state.
 */
export function createGatewayTransport(
  endpoint: string,
  tls: VpcTlsOptions = {},
  baseFetch: typeof fetch = globalThis.fetch,
): GatewayTransport {
  const needsCustomAgent =
    isVpcEndpoint(endpoint) &&
    (tls.insecureTls === true || (typeof tls.caCertPath === 'string' && tls.caCertPath !== ''));

  if (!needsCustomAgent) {
    return {
      fetch: (url, init) => baseFetch(url, init),
      dispose: () => {},
    };
  }

  const ca =
    typeof tls.caCertPath === 'string' && tls.caCertPath !== ''
      ? fs.readFileSync(tls.caCertPath)
      : undefined;

  const agent = new https.Agent({
    keepAlive: true,
    ...(ca === undefined ? {} : { ca }),
    rejectUnauthorized: tls.insecureTls === true ? false : true,
  });

  return {
    fetch: (url, init) => fetchWithAgent(url, init, agent, tls.insecureTls === true),
    dispose: () => {
      agent.destroy();
    },
  };
}

function fetchWithAgent(
  url: string | URL,
  init: RequestInit = {},
  agent: https.Agent,
  insecureTls: boolean,
): Promise<Response> {
  const target = new URL(url);
  const secure = target.protocol === 'https:';
  const transport = secure ? https : http;
  const signal = init.signal;
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason instanceof Error ? signal.reason : new Error('The operation was aborted'),
    );
  }

  const payload =
    init.body === undefined || init.body === null
      ? null
      : Buffer.isBuffer(init.body)
        ? init.body
        : Buffer.from(String(init.body));

  return new Promise<Response>((resolve, reject) => {
    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (secure ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: init.method ?? 'GET',
        headers: toHeaderRecord(init.headers),
        agent: secure ? agent : undefined,
        ...(secure && insecureTls ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const stream = decodeContentEncoding(res);
        resolve(
          new Response(Readable.toWeb(stream) as ReadableStream, {
            status: res.statusCode ?? 0,
            headers: toFetchHeaders(res.headers),
          }),
        );
      },
    );

    req.on('error', reject);
    if (signal) {
      const onAbort = () => {
        req.destroy(
          signal.reason instanceof Error ? signal.reason : new Error('The operation was aborted'),
        );
      };
      signal.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => signal.removeEventListener('abort', onAbort));
    }

    if (payload !== null) req.end(payload);
    else req.end();
  });
}

function toHeaderRecord(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers === undefined) return out;
  for (const [key, value] of new Headers(headers)) {
    out[key] = value;
  }
  return out;
}

function decodeContentEncoding(res: http.IncomingMessage): Readable {
  const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase();
  if (encoding.includes('gzip')) return res.pipe(zlib.createGunzip());
  if (encoding.includes('deflate')) return res.pipe(zlib.createInflate());
  if (encoding.includes('br')) return res.pipe(zlib.createBrotliDecompress());
  return res;
}

function toFetchHeaders(raw: http.IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (HOP_BY_HOP.has(key) || value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      try {
        headers.append(key, String(item));
      } catch {
        /* forbidden header */
      }
    }
  }
  return headers;
}
