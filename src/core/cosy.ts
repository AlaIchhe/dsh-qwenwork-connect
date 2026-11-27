/**
 * Pure JavaScript COSY envelope signing and custom wire body encoding (Encode=1).
 * Uses only node:crypto; zero WASM or native binary dependencies.
 */

import {
  constants,
  createCipheriv,
  createHash,
  publicEncrypt,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import type { StoredCredential } from './credentials.js';

export const COSY_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

const ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const PAD = '$';

const ALPHABET_INDEX = new Map<string, number>(
  [...ALPHABET].map((ch, idx) => [ch, idx]),
);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8');

export function encodeBody(text: string): string {
  return swapThirds(segmentEncode(textEncoder.encode(text)));
}

export function decodeBody(wire: string): string {
  const s = swapThirds(wire);
  const out: number[] = [];
  for (let g = 0; g + 4 <= s.length; g += 4) {
    const vals: number[] = [];
    for (let i = g; i < g + 4; i += 1) {
      const ch = s[i]!;
      if (ch === PAD) continue;
      const idx = ALPHABET_INDEX.get(ch);
      if (idx === undefined) {
        throw new Error('qwenwork: body contains unknown character, not COSY encoded');
      }
      vals.push(idx);
    }
    let x = 0;
    for (const v of vals) x = x * 64 + v;
    const n = Math.floor((6 * vals.length) / 8);
    for (let k = 0; k < n; k += 1) {
      out.push(Math.floor(x / 2 ** (6 * vals.length - 8 * (k + 1))) & 255);
    }
  }
  return textDecoder.decode(new Uint8Array(out));
}

export function looksEncoded(text: unknown): boolean {
  const t = String(text ?? '').trim();
  if (t === '' || t.startsWith('{') || t.startsWith('[')) return false;
  for (let i = 0; i < t.length; i += 1) {
    const ch = t[i]!;
    if (ch !== PAD && !ALPHABET_INDEX.has(ch)) return false;
  }
  return true;
}

export function signedPath(url: string): string {
  let pathname = new URL(url).pathname;
  if (pathname.startsWith('/algo')) pathname = pathname.slice(5);
  return pathname;
}

export interface BuildCosyHeadersParams {
  readonly url: string;
  readonly credential: StoredCredential;
  readonly machineId: string;
  readonly cosyVersion: string;
  readonly body?: string;
  readonly mode?: 'chat' | 'json';
  readonly modelKey?: string;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

export interface CosySignedHeaders {
  readonly headers: Record<string, string>;
  readonly payload: string;
  readonly signature: string;
  readonly timestamp: number;
}

export function buildCosyHeaders(params: BuildCosyHeadersParams): CosySignedHeaders {
  const user = params.credential.user;
  const uid = String(user?.id ?? '');
  const token = params.credential.token;
  if (uid === '' || token === '') {
    throw new Error('qwenwork: COSY signing requires non-empty uid and token');
  }
  if (params.machineId === '') {
    throw new Error('qwenwork: COSY signing requires non-empty machineId');
  }

  const { info, key } = buildUserBlob({
    uid,
    name: user?.name ?? '',
    email: user?.email ?? '',
    token,
  });

  const payload = Buffer.from(
    JSON.stringify({
      version: 'v1',
      requestId: randomUUID(),
      info,
      cosyVersion: params.cosyVersion,
      ideVersion: '',
    }),
  ).toString('base64');

  const path = signedPath(params.url);
  const ts = Math.floor(Date.now() / 1000);
  const body = params.body ?? '';
  const signature = createHash('md5')
    .update(`${payload}\n${key}\n${ts}\n${body}\n${path}`)
    .digest('hex');

  const headers: Record<string, string> = {
    ...params.extraHeaders,
    Accept: params.mode === 'chat' ? 'text/event-stream' : 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer COSY.${payload}.${signature}`,
    'Cosy-Business-Product': 'qoder_work',
    'Cosy-Business-Type': 'agent',
    'Cosy-ClientType': '6',
    'Cosy-Data-Policy': user?.dataPolicyAgreed === false ? 'disagree' : 'agree',
    'Cosy-Date': String(ts),
    'Cosy-Key': key,
    'Cosy-MachineId': params.machineId,
    'Cosy-MachineToken': params.machineId,
    'Cosy-MachineType': '5',
    ...(user?.organizationId ? { 'Cosy-Organization-Id': user.organizationId } : {}),
    'Cosy-Scene': 'assistant',
    'Cosy-User': uid,
    'Cosy-Version': params.cosyVersion,
    'Login-Version': 'v2',
  };

  if (params.mode === 'chat') {
    headers['Cache-Control'] = 'no-cache';
    headers.Connection = 'keep-alive';
    if (params.modelKey !== undefined && params.modelKey !== '') {
      headers['X-Model-Key'] = params.modelKey;
    }
  }

  return { headers, payload, signature, timestamp: ts };
}

function buildUserBlob(input: {
  uid: string;
  name: string;
  email: string;
  token: string;
}): { info: string; key: string } {
  const raw = JSON.stringify({
    uid: input.uid,
    aid: '',
    name: input.name,
    email: input.email,
    security_oauth_token: input.token,
  });
  const key = Buffer.from(randomBytes(8).toString('hex').slice(0, 16));
  const cipher = createCipheriv('aes-128-cbc', key, key);
  const info = Buffer.concat([cipher.update(raw, 'utf8'), cipher.final()]).toString('base64');
  const wrapped = publicEncrypt(
    { key: COSY_RSA_PUBLIC_KEY, padding: constants.RSA_PKCS1_PADDING },
    key,
  ).toString('base64');
  return { info, key: wrapped };
}

function segmentEncode(bytes: Uint8Array): string {
  let s = '';
  let acc = 0;
  let nb = 0;
  for (const b of bytes) {
    acc = ((acc << 8) | b) & 0xffffff;
    nb += 8;
    while (nb >= 6) {
      nb -= 6;
      s += ALPHABET[(acc >> nb) & 63];
    }
  }
  if (nb > 0) s += ALPHABET[(acc << (6 - nb)) & 63];
  while (s.length % 4 !== 0) s += PAD;
  return s;
}

function swapThirds(s: string): string {
  const t = Math.floor(s.length / 3);
  return t > 0 ? s.slice(s.length - t) + s.slice(t, s.length - t) + s.slice(0, t) : s;
}
