import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {singleton} from 'tsyringe';
import {config} from '../config/env';
import {logger} from '../utils/logger';

/** A message the service is done with, by its serialized id and its WhatsApp timestamp (sec). */
export interface MessageMark {
    id: string;
    timestamp: number;
}

interface ChatRecord {
    /**
     * The newest message up to which the chat is known to be complete: everything at or before
     * it was either forwarded, filtered or deliberately skipped. A restart scrolls the chat back
     * to this message and resumes after it.
     */
    anchor?: MessageMark;
    /** Every message forwarded from this chat within the retention window: id → timestamp. */
    processed: Record<string, number>;
}

interface StoreFile {
    version: 1;
    /** Start (sec) of the last scan that confirmed every chat; covers chats with no anchor yet. */
    watermark?: number;
    chats: Record<string, ChatRecord>;
}

/** How long a burst of records may sit in memory before it is written out. */
const PERSIST_DELAY_MS = 1000;
/** The watermark moves on every scan; writing it more often than this buys nothing. */
const WATERMARK_PERSIST_INTERVAL_SEC = 60;

const nowSec = (): number => Math.floor(Date.now() / 1000);

/**
 * The week of inbound history the service has already handled, kept on the data volume so a
 * restart picks up where the last process stopped instead of where WhatsApp happens to be.
 *
 * Two things live here per chat: the set of message ids already forwarded (so a rescan never
 * publishes one twice) and the anchor a restart scrolls back to. Entries older than the
 * retention window are dropped — the backfill never reaches that far back anyway.
 *
 * Writes are coalesced: a crash can lose the last second of records, which costs a duplicate
 * publish on the next scan (the consumer dedups by message id), never a lost message.
 */
@singleton()
export class ProcessedMessageStore {
    private readonly filePath: string;
    private readonly retentionSec: number;
    private readonly chats = new Map<string, ChatRecord>();
    private watermarkSec: number | undefined;
    private watermarkSavedAt = 0;
    private loaded: Promise<void> | null = null;
    private persistTimer: ReturnType<typeof setTimeout> | null = null;
    private writeQueue: Promise<void> = Promise.resolve();

    constructor() {
        this.filePath =
            config.history.path ?? join(config.whatsapp.sessionPath, 'processed-messages.json');
        this.retentionSec = Math.max(config.history.retentionSec, config.history.backfillMaxAgeSec);
    }

    public get isLoaded(): boolean {
        return this.loaded !== null;
    }

    /** Start of the last scan that confirmed every chat, if the service ever completed one. */
    public get watermark(): number | undefined {
        return this.watermarkSec;
    }

    public async load(): Promise<void> {
        this.loaded ??= this.read();
        await this.loaded;
    }

    public has(chatId: string, messageId: string): boolean {
        return this.chats.get(chatId)?.processed[messageId] !== undefined;
    }

    public anchorOf(chatId: string): MessageMark | undefined {
        return this.chats.get(chatId)?.anchor;
    }

    /** Remembers a forwarded message so no later scan publishes it again. */
    public record(chatId: string, mark: MessageMark): void {
        this.chatRecord(chatId).processed[mark.id] = mark.timestamp;
        this.persistLater();
    }

    /** Moves the chat's anchor forward; an older mark than the current one is ignored. */
    public advanceAnchor(chatId: string, mark: MessageMark): void {
        const record = this.chatRecord(chatId);
        if (record.anchor?.id === mark.id || (record.anchor && record.anchor.timestamp > mark.timestamp)) {
            return;
        }
        record.anchor = mark;
        this.persistLater();
    }

    public advanceWatermark(timestamp: number): void {
        if (this.watermarkSec !== undefined && this.watermarkSec >= timestamp) {
            return;
        }
        this.watermarkSec = timestamp;
        if (timestamp - this.watermarkSavedAt >= WATERMARK_PERSIST_INTERVAL_SEC) {
            this.persistLater();
        }
    }

    /** Writes anything still pending; called on shutdown. */
    public async flush(): Promise<void> {
        if (this.persistTimer) {
            clearTimeout(this.persistTimer);
            this.persistTimer = null;
            this.enqueuePersist();
        }
        await this.writeQueue;
    }

    private chatRecord(chatId: string): ChatRecord {
        let record = this.chats.get(chatId);
        if (!record) {
            record = {processed: {}};
            this.chats.set(chatId, record);
        }
        return record;
    }

    private async read(): Promise<void> {
        try {
            const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as StoreFile;
            this.watermarkSec = typeof parsed.watermark === 'number' ? parsed.watermark : undefined;
            this.watermarkSavedAt = this.watermarkSec ?? 0;
            for (const [chatId, record] of Object.entries(parsed.chats ?? {})) {
                this.chats.set(chatId, {anchor: record.anchor, processed: record.processed ?? {}});
            }
            this.prune();
            logger.info('Loaded processed-message history', {
                path: this.filePath,
                chats: this.chats.size,
                watermark: this.watermarkSec,
            });
            return;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                logger.warn(`Could not read the message history at ${this.filePath}; starting empty`, err);
                return;
            }
        }

        await this.adoptLegacyCursor();
    }

    /**
     * Before this store the service kept one timestamp cursor for all chats. A deployment that
     * still has one takes it as the watermark, so its first restart on this version resumes
     * from there instead of from the full backfill window.
     */
    private async adoptLegacyCursor(): Promise<void> {
        const legacyPath = config.whatsapp.cursorPath ?? join(config.whatsapp.sessionPath, 'cursor.json');
        try {
            const parsed = JSON.parse(await readFile(legacyPath, 'utf8')) as {cursor?: unknown};
            if (typeof parsed.cursor === 'number' && Number.isFinite(parsed.cursor)) {
                this.watermarkSec = parsed.cursor;
                logger.info('Adopted the legacy delivery cursor as the history watermark', {
                    legacyPath,
                    watermark: this.watermarkSec,
                });
                this.persistLater();
            }
        } catch {
            // no legacy cursor either: a fresh install
        }
    }

    private prune(): void {
        const cutoff = nowSec() - this.retentionSec;
        for (const [chatId, record] of this.chats) {
            for (const [messageId, timestamp] of Object.entries(record.processed)) {
                if (timestamp < cutoff) {
                    delete record.processed[messageId];
                }
            }
            if (record.anchor && record.anchor.timestamp < cutoff) {
                record.anchor = undefined;
            }
            if (!record.anchor && Object.keys(record.processed).length === 0) {
                this.chats.delete(chatId);
            }
        }
    }

    private persistLater(): void {
        if (this.persistTimer) {
            return;
        }
        this.persistTimer = setTimeout(() => {
            this.persistTimer = null;
            this.enqueuePersist();
        }, PERSIST_DELAY_MS);
        this.persistTimer.unref?.();
    }

    /** Serialises writes and swaps the file in atomically, so a crash cannot truncate it. */
    private enqueuePersist(): void {
        this.writeQueue = this.writeQueue
            .then(() => this.persist())
            .catch((err) => logger.warn('Failed to persist the message history', err));
    }

    private async persist(): Promise<void> {
        this.prune();
        const payload: StoreFile = {
            version: 1,
            watermark: this.watermarkSec,
            chats: Object.fromEntries(this.chats),
        };

        await mkdir(dirname(this.filePath), {recursive: true});
        const temporaryPath = join(dirname(this.filePath), `.${Date.now()}.history.tmp`);
        await writeFile(temporaryPath, JSON.stringify(payload), 'utf8');
        await rename(temporaryPath, this.filePath);
        this.watermarkSavedAt = this.watermarkSec ?? 0;
    }
}
