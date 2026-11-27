/**
 * Non-blocking opt-in request trace logger.
 * Disabled by default; enabled via `config.debugTrace.enabled`.
 * Writes JSONL asynchronously to user-private `~/.dsh/logs/qwenwork-trace.log`.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAX_BYTES = 2 * 1024 * 1024;

export interface DebugTraceSettings {
  readonly enabled: boolean;
  readonly logPath: string;
}

export class DebugTracer {
  private readonly getSettings: () => DebugTraceSettings;
  private queue: Promise<void> = Promise.resolve();

  constructor(getSettings: () => DebugTraceSettings) {
    this.getSettings = getSettings;
  }

  record(event: string, data: Record<string, unknown> = {}): void {
    const settings = this.getSettings();
    if (!settings.enabled) return;

    const targetPath =
      settings.logPath !== ''
        ? settings.logPath
        : path.join(os.homedir(), '.dsh', 'logs', 'qwenwork-trace.log');

    const line =
      JSON.stringify({
        t: new Date().toISOString(),
        source: 'dsh-qwenwork-connect',
        pid: process.pid,
        event,
        ...data,
      }) + '\n';

    this.queue = this.queue
      .then(() => appendRotated(targetPath, line))
      .catch(() => undefined);
  }
}

async function appendRotated(filePath: string, line: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_BYTES) {
      await fs.writeFile(filePath, '', { encoding: 'utf8', mode: 0o600 });
    }
  } catch {
    /* file does not exist yet */
  }
  await fs.appendFile(filePath, line, { encoding: 'utf8', mode: 0o600 });
}
