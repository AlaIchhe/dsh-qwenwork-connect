/**
 * DSH-native CredentialStore backed by `ctx.credentials` (`@deepseek-ai/dsh-credentials`),
 * with seamless read/clear interop with FileCredentialStore for headless CLI logins.
 */

import {
  FileCredentialStore,
  normalizeCredential,
  type CredentialStore,
  type StoredCredential,
} from '../core/credentials.js';
import { PLUGIN_CORDIS_NAME } from '../shared/contracts.js';
import type { SiteId } from '../shared/sites.js';
import type {
  OptionalCredentialRecord,
  OptionalCredentialsService,
  OptionalGrantRecord,
} from './dsh-services.js';

export function recordKeyForSite(siteId: SiteId): string {
  // Matches `@deepseek-ai/dsh-credentials` `credentialKey(scope, id)` grammar: `<scope>/<id>`
  return `${PLUGIN_CORDIS_NAME}/${siteId}`;
}

export class HybridCredentialStore implements CredentialStore {
  private readonly getDshCredentials: () => OptionalCredentialsService | undefined;
  private readonly fileFallback: FileCredentialStore;

  constructor(
    getDshCredentials: () => OptionalCredentialsService | undefined,
    fileFallback = new FileCredentialStore(),
  ) {
    this.getDshCredentials = getDshCredentials;
    this.fileFallback = fileFallback;
  }

  async read(siteId: SiteId): Promise<StoredCredential | undefined> {
    const svc = this.getDshCredentials();
    if (svc !== undefined) {
      const record = await svc.readRecord(recordKeyForSite(siteId));
      if (record !== undefined && record.kind === 'grant' && record.payload !== undefined) {
        return normalizeCredential(record.payload, siteId);
      }
    }
    return this.fileFallback.read(siteId);
  }

  async write(siteId: SiteId, credential: StoredCredential): Promise<void> {
    const svc = this.getDshCredentials();
    if (svc !== undefined) {
      await svc.modifyRecord(recordKeyForSite(siteId), async (): Promise<OptionalGrantRecord> => ({
        kind: 'grant',
        payload: credential,
      }));
      return;
    }
    await this.fileFallback.write(siteId, credential);
  }

  async update(
    siteId: SiteId,
    mutate: (current: StoredCredential | undefined) => Promise<StoredCredential | undefined>,
  ): Promise<StoredCredential | undefined> {
    const svc = this.getDshCredentials();
    if (svc !== undefined) {
      const key = recordKeyForSite(siteId);
      const record = await svc.readRecord(key);
      // If the credential came from the CLI file store (not yet in DSH credentials),
      // migrate it atomically into DSH credentials during update, or update via modifyRecord.
      let result: StoredCredential | undefined;
      await svc.modifyRecord(
        key,
        async (existing: OptionalCredentialRecord | undefined): Promise<OptionalGrantRecord | undefined> => {
          const current =
            existing !== undefined && existing.kind === 'grant' && existing.payload !== undefined
              ? normalizeCredential(existing.payload, siteId)
              : record === undefined
                ? await this.fileFallback.read(siteId)
                : undefined;
          const next = await mutate(current);
          if (next === undefined) {
            result = current;
            return undefined;
          }
          result = next;
          return { kind: 'grant', payload: next };
        },
      );
      return result;
    }
    return this.fileFallback.update(siteId, mutate);
  }

  async clear(siteId: SiteId): Promise<boolean> {
    let removed = false;
    const svc = this.getDshCredentials();
    if (svc !== undefined) {
      const key = recordKeyForSite(siteId);
      const had = (await svc.readRecord(key)) !== undefined;
      await svc.deleteRecord(key);
      if (had) removed = true;
    }
    const removedFile = await this.fileFallback.clear(siteId);
    return removed || removedFile;
  }
}
