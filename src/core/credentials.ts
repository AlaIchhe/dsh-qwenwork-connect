/**
 * Credential domain model, JWT helpers, and file-backed CredentialStore.
 * Pure Device Flow / JSON credentials — no Windows DPAPI or desktop scraping.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { siteOf, type SiteId } from '../shared/sites.js';
import { QwenError, QwenErrorCode } from './errors.js';

export interface CredentialUser {
  readonly id: string | null;
  readonly name: string | null;
  readonly username: string | null;
  readonly email: string | null;
  readonly organizationId: string | null;
  readonly dataPolicyAgreed: boolean;
}

export interface StoredCredential {
  readonly schemaVersion: number;
  readonly siteId: SiteId;
  readonly token: string;
  readonly refreshToken: string;
  readonly expiresAt: string | null;
  readonly refreshTokenExpiresAt: string | null;
  readonly loginDeviceId: string;
  readonly loginMethod: string;
  readonly user: CredentialUser;
}

/**
 * Storage contract for per-site credentials.
 * `update()` is a serialized read-modify-write (returning `undefined` leaves
 * the record untouched), matching `@deepseek-ai/dsh-credentials` `modifyRecord`.
 */
export interface CredentialStore {
  read(siteId: SiteId): Promise<StoredCredential | undefined>;
  write(siteId: SiteId, credential: StoredCredential): Promise<void>;
  update(
    siteId: SiteId,
    mutate: (current: StoredCredential | undefined) => Promise<StoredCredential | undefined>,
  ): Promise<StoredCredential | undefined>;
  clear(siteId: SiteId): Promise<boolean>;
}

export function defaultMachineIdPath(homeDir = os.homedir()): string {
  return path.join(homeDir, '.dsh', 'qwenwork-machine-id');
}

export function defaultCredentialPath(siteId: SiteId, homeDir = os.homedir()): string {
  return path.join(homeDir, '.dsh', siteOf(siteId).credentialFile);
}

export function resolveSiteCredentialPath(
  siteId: SiteId,
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir(),
): string {
  if (typeof explicit === 'string' && explicit !== '') return explicit;
  const site = siteOf(siteId);
  const fromEnv = env[site.envCredentialFile];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  return defaultCredentialPath(siteId, homeDir);
}

export async function getOrCreateMachineId(filePath = defaultMachineIdPath()): Promise<string> {
  try {
    const existing = (await fs.readFile(filePath, 'utf8')).trim();
    if (existing.length > 0) return existing;
  } catch {
    /* first run */
  }
  const id = crypto.randomUUID();
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, id, { mode: 0o600 });
  } catch {
    /* non-fatal */
  }
  return id;
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  if (typeof token !== 'string' || token === '') return null;
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function isTokenExpired(
  credential: Pick<StoredCredential, 'expiresAt'>,
  skewMs = 60_000,
  now = Date.now(),
): boolean {
  if (!credential.expiresAt) return false;
  const ts = Date.parse(credential.expiresAt);
  if (Number.isNaN(ts)) return false;
  return ts - skewMs <= now;
}

export function normalizeCredential(raw: unknown, siteId: SiteId): StoredCredential {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new QwenError(QwenErrorCode.SCHEMA_INVALID, '凭据内容不是合法对象。');
  }
  const rec = raw as Record<string, unknown>;
  const token = typeof rec.token === 'string' && rec.token !== '' ? rec.token : '';
  if (token === '') {
    throw new QwenError(QwenErrorCode.SCHEMA_INVALID, '凭据缺少 token 字段。');
  }

  const refreshToken = typeof rec.refreshToken === 'string' ? rec.refreshToken : '';
  const claims = decodeJwtPayload(token) ?? {};
  const rawUser =
    typeof rec.user === 'object' && rec.user !== null && !Array.isArray(rec.user)
      ? (rec.user as Record<string, unknown>)
      : {};

  const organizationId =
    asNonEmptyString(rawUser.organizationId) ??
    asNonEmptyString(rawUser.organization_id) ??
    asNonEmptyString(claims.biz_org_id) ??
    null;

  const user: CredentialUser = {
    id:
      asNonEmptyString(rawUser.id) ??
      asNonEmptyString(rawUser.uid) ??
      asNonEmptyString(claims.user_id) ??
      asNonEmptyString(claims.sub) ??
      null,
    name:
      asNonEmptyString(rawUser.name) ??
      asNonEmptyString(claims.username) ??
      null,
    username:
      asNonEmptyString(rawUser.username) ??
      asNonEmptyString(claims.username) ??
      null,
    email:
      asNonEmptyString(rawUser.email) ??
      asNonEmptyString(claims.email) ??
      null,
    organizationId,
    dataPolicyAgreed:
      rawUser.dataPolicyAgreed === false || rawUser.data_policy_agreed === false
        ? false
        : true,
  };

  const loginDeviceId =
    asNonEmptyString(rec.loginDeviceId) ??
    asNonEmptyString(rec.machineId) ??
    '';

  return {
    schemaVersion: typeof rec.schemaVersion === 'number' ? rec.schemaVersion : 2,
    siteId,
    token,
    refreshToken,
    expiresAt: toIsoString(rec.expiresAt) ?? toIsoString(claims.exp),
    refreshTokenExpiresAt: toIsoString(rec.refreshTokenExpiresAt),
    loginDeviceId,
    loginMethod: asNonEmptyString(rec.loginMethod) ?? 'device-flow',
    user,
  };
}

export class FileCredentialStore implements CredentialStore {
  private readonly pathResolver: (siteId: SiteId) => string;
  private readonly queues = new Map<SiteId, Promise<unknown>>();

  constructor(
    opts: {
      pathForSite?: (siteId: SiteId) => string;
      env?: NodeJS.ProcessEnv;
      homeDir?: string;
    } = {},
  ) {
    this.pathResolver =
      opts.pathForSite ??
      ((siteId) => resolveSiteCredentialPath(siteId, undefined, opts.env, opts.homeDir));
  }

  filePathFor(siteId: SiteId): string {
    return this.pathResolver(siteId);
  }

  async read(siteId: SiteId): Promise<StoredCredential | undefined> {
    const file = this.pathResolver(siteId);
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
      throw new QwenError(
        QwenErrorCode.CREDENTIALS_MISSING,
        `无法读取凭据文件：${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new QwenError(QwenErrorCode.SCHEMA_INVALID, '凭据文件不是合法 JSON。', { cause: error });
    }
    return normalizeCredential(parsed, siteId);
  }

  async write(siteId: SiteId, credential: StoredCredential): Promise<void> {
    await this.enqueue(siteId, async () => {
      await writeJsonAtomic(this.pathResolver(siteId), credential);
    });
  }

  async update(
    siteId: SiteId,
    mutate: (current: StoredCredential | undefined) => Promise<StoredCredential | undefined>,
  ): Promise<StoredCredential | undefined> {
    return this.enqueue(siteId, async () => {
      const current = await this.read(siteId);
      const next = await mutate(current);
      if (next === undefined) return current;
      await writeJsonAtomic(this.pathResolver(siteId), next);
      return next;
    });
  }

  async clear(siteId: SiteId): Promise<boolean> {
    return this.enqueue(siteId, async () => {
      const file = this.pathResolver(siteId);
      try {
        await fs.unlink(file);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
        throw error;
      }
    });
  }

  private enqueue<T>(siteId: SiteId, task: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(siteId) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(task);
    this.queues.set(siteId, run);
    const clear = () => {
      if (this.queues.get(siteId) === run) this.queues.delete(siteId);
    };
    run.then(clear, clear);
    return run;
  }
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const payload = JSON.stringify(data, null, 2);
  try {
    await fs.writeFile(tmpPath, payload, { mode: 0o600 });
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function toIsoString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}
