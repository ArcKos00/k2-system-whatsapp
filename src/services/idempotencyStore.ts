import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { singleton } from 'tsyringe';
import { config } from '../config/env';
import { logger } from '../utils/logger';

/**
 * A send that completed successfully, keyed by the caller's idempotency key.
 */
export interface CompletedSend {
  chatId: string;
  sentMessages: number;
  completedAt: number;
}

interface StoreFile {
  version: 1;
  entries: Record<string, CompletedSend>;
}

/**
 * Remembers which sends already succeeded so a caller that retries after losing the
 * response (timeout, killed pod, torn connection) gets the original result back instead
 * of a second message landing in the chat.
 *
 * Kept on disk because the caller's retry usually outlives this process. Entries are
 * pruned by TTL — an idempotency key is only useful for as long as retries can arrive.
 *
 * Note the honest limit: a send that fails *part way* (text delivered, second attachment
 * not) cannot be made atomic against the WhatsApp API. Such a key is released, so the
 * retry re-sends the whole message. Exactly-once holds for complete sends; partial
 * failures stay at-least-once.
 */
@singleton()
export class IdempotencyStore {
  private readonly filePath: string;
  private readonly ttlMs: number;
  private readonly completed = new Map<string, CompletedSend>();
  /** Keys whose send is running right now, in this process. */
  private readonly inFlight = new Set<string>();
  private loaded: Promise<void> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor() {
    this.filePath = config.idempotency.path;
    this.ttlMs = config.idempotency.ttlMs;
  }

  /**
   * Returns the earlier result when this key already succeeded, `'in-flight'` when a send
   * for it is running, or `null` when the caller should proceed.
   */
  public async claim(key: string): Promise<CompletedSend | 'in-flight' | null> {
    await this.ensureLoaded();
    this.prune();

    const existing = this.completed.get(key);
    if (existing) {
      return existing;
    }

    if (this.inFlight.has(key)) {
      return 'in-flight';
    }

    this.inFlight.add(key);
    return null;
  }

  /** Records a fully successful send; later retries with this key are answered from here. */
  public async complete(key: string, result: Omit<CompletedSend, 'completedAt'>): Promise<void> {
    this.inFlight.delete(key);
    this.completed.set(key, { ...result, completedAt: Date.now() });
    this.persistLater();
  }

  /** Releases a key after a failed send so the caller's retry is allowed through. */
  public release(key: string): void {
    this.inFlight.delete(key);
  }

  private async ensureLoaded(): Promise<void> {
    this.loaded ??= this.load();
    await this.loaded;
  }

  private async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as StoreFile;

      for (const [key, entry] of Object.entries(parsed.entries ?? {})) {
        this.completed.set(key, entry);
      }

      this.prune();
      logger.info(`Idempotency store loaded (${this.completed.size} entries) from ${this.filePath}`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logger.warn(`Could not read the idempotency store at ${this.filePath}; starting empty`, err);
      }
    }
  }

  private prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [key, entry] of this.completed) {
      if (entry.completedAt < cutoff) {
        this.completed.delete(key);
      }
    }
  }

  /**
   * Serialises writes and swaps the file in atomically, so a crash mid-write cannot leave
   * a truncated store behind.
   */
  private persistLater(): void {
    this.writeQueue = this.writeQueue.then(() => this.persist()).catch((err) => {
      logger.warn('Failed to persist the idempotency store', err);
    });
  }

  private async persist(): Promise<void> {
    const payload: StoreFile = {
      version: 1,
      entries: Object.fromEntries(this.completed),
    };

    await mkdir(dirname(this.filePath), { recursive: true });

    const temporaryPath = join(dirname(this.filePath), `.${Date.now()}.idempotency.tmp`);
    await writeFile(temporaryPath, JSON.stringify(payload), 'utf8');
    await rename(temporaryPath, this.filePath);
  }
}
