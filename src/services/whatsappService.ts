import {Client, LocalAuth, MessageMedia} from 'whatsapp-web.js';
import type {Chat, ClientOptions, Message} from 'whatsapp-web.js';
import type {ChromeReleaseChannel, LaunchOptions} from 'puppeteer';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import {mkdir, rm, readFile, writeFile, rename} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {singleton} from 'tsyringe';
import {config} from '../config/env';
import {logger} from '../utils/logger';
import {RabbitMqPublisher} from './rabbitMqPublisher';
import type {ChatListResponse, ChatSummaryDto} from '../dtos/chat.dto';
import {
    BadAttachmentError,
    MessageSendError,
    NumberNotFoundError,
    WhatsAppNotReadyError,
} from '../errors/appErrors';

export interface MediaAttachment {
    path?: string;
    buffer?: Buffer;
    base64?: string;
    mimetype?: string;
    filename?: string;
}

export type WhatsAppStatus = 'initializing' | 'qr' | 'authenticated' | 'ready' | 'disconnected';

const TRANSIENT_FRAME_ERROR =
    /detached Frame|Execution context was destroyed|Session closed|Target closed|Protocol error|Most likely the page has been closed/i;

const CHROMIUM_LOCK_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

const PUPPETEER_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-zygote',
    '--js-flags=--max-old-space-size=256',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--mute-audio',
];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const toSeconds = (value: unknown): number => (typeof value === 'number' ? value : 0);

/**
 * The message's serialized id. WhatsApp Web serializes `id` either as the object
 * whatsapp-web.js types (`{_serialized}`) or as the plain string, depending on the build, and
 * an id read from only one of those shapes silently becomes `undefined` — which then travels
 * to RabbitMQ as a message with no id for the consumer to deduplicate reconcile replays by.
 */
const messageIdOf = (message: Message): string | undefined => {
    const id: unknown = message.id;

    if (typeof id === 'string') {
        return id;
    }

    const serialized = (id as {_serialized?: unknown} | undefined)?._serialized;
    return typeof serialized === 'string' ? serialized : undefined;
};

@singleton()
export class WhatsappService {
    private readonly client: Client;
    private readonly qrImagePath: string;
    private readonly cursorPath: string;

    private status: WhatsAppStatus = 'initializing';
    private currentQr: string | null = null;
    private lastSentAt = 0;

    private reinitializing = false;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private readyWatchdogTimer: ReturnType<typeof setTimeout> | null = null;

    private reconcileTimer: ReturnType<typeof setInterval> | null = null;
    private reconciling = false;
    private reconcileFailures = 0;
    private reconcileRestarts = 0;
    private reconcileBackoffUntil = 0;
    private cursor = -1;

    constructor(private readonly publisher: RabbitMqPublisher) {
        this.qrImagePath =
            config.whatsapp.qrImagePath ?? join(config.whatsapp.sessionPath, 'qr.png');
        this.cursorPath =
            config.whatsapp.cursorPath ?? join(config.whatsapp.sessionPath, 'cursor.json');

        this.client = new Client(this.buildClientOptions());
    }

    public getStatus(): WhatsAppStatus {
        return this.status;
    }

    public isReady(): boolean {
        return this.status === 'ready';
    }

    public isRecoverableError(err: unknown): boolean {
        return this.isTransientFrameError(err);
    }

    public async initClient(): Promise<void> {
        await this.loadCursor();
        this.registerEventHandlers();
        await this.clearChromiumLocks();
        this.startHeartbeat();
        this.armReadyWatchdog();

        const maxAttempts = Math.max(1, config.whatsapp.initMaxAttempts);
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                logger.info('Initializing WhatsApp client...', {
                    clientId: config.whatsapp.clientId,
                    attempt,
                    maxAttempts,
                });
                await this.withTimeout(
                    this.client.initialize(),
                    config.whatsapp.initTimeoutMs,
                    'client.initialize',
                );
                return;
            } catch (err) {
                logger.error(`WhatsApp initialize attempt ${attempt}/${maxAttempts} failed`, err);

                if (attempt >= maxAttempts) {
                    throw err;
                }

                try {
                    await this.client.destroy();
                } catch (destroyErr) {
                    logger.warn('Error destroying client between init attempts', destroyErr);
                }
                await sleep(config.whatsapp.frameRetryDelayMs * attempt);
            }
        }
    }

    public async destroy(): Promise<void> {
        this.stopHeartbeat();
        this.stopReconcile();

        this.clearReadyWatchdog();
        try {
            await this.client.destroy();
        } catch (err) {
            logger.warn('Error while destroying WhatsApp client', err);
        }
    }

    public async sendMessage(
        phoneNumber: string,
        message?: string,
        files: MediaAttachment[] = [],
    ): Promise<{ success: boolean; chatId: string; sentMessages: number }> {
        if (!this.isReady()) {
            throw new WhatsAppNotReadyError();
        }
        if (!message?.trim() && files.length === 0) {
            throw new MessageSendError('Either a message body or at least one file is required.');
        }

        const chatId = await this.resolveChatId(phoneNumber);
        let sentMessages = 0;

        try {
            if (message?.trim()) {
                await this.throttle();
                await this.client.sendMessage(chatId, message);
                sentMessages += 1;
            }

            for (const file of files) {
                const media = this.toMessageMedia(file);
                await this.throttle();
                await this.client.sendMessage(chatId, media);
                sentMessages += 1;
            }
        } catch (err) {
            if (err instanceof BadAttachmentError) throw err;
            if (this.isTransientFrameError(err)) {
                void this.recoverFromFrameError(err);
                throw new WhatsAppNotReadyError();
            }
            throw new MessageSendError(err instanceof Error ? err.message : String(err));
        }

        logger.info('Message dispatched', {chatId, sentMessages});
        return {success: true, chatId, sentMessages};
    }

    /**
     * Every chat the linked account can see, with the id the forward allowlist keys on. A chat
     * WhatsApp will not let the library model is reported by id under `unreadableChatIds`
     * rather than failing the listing — the same failure that used to sink whole reconcile
     * passes.
     */
    public async listChatSummaries(): Promise<ChatListResponse> {
        if (!this.isReady()) {
            throw new WhatsAppNotReadyError();
        }

        const allowlist = config.rabbitmq.chatIds;
        const forwardsEverything = allowlist.length === 0;

        const chats: ChatSummaryDto[] = [];
        const unreadableChatIds: string[] = [];

        for (const chatId of await this.listChatIds()) {
            try {
                const chat = await this.client.getChatById(chatId);

                chats.push({
                    id: chat?.id?._serialized ?? chatId,
                    name: chat?.name,
                    isGroup: chat?.isGroup,
                    timestamp: chat?.timestamp,
                    unreadCount: chat?.unreadCount,
                    forwarded: forwardsEverything || allowlist.includes(chatId),
                });
            } catch (err) {
                logger.warn('Chat listing: chat would not load', {chatId, err});
                unreadableChatIds.push(chatId);
            }
        }

        chats.sort((left, right) => (right.timestamp ?? 0) - (left.timestamp ?? 0));

        return {chats, unreadableChatIds, allowlist: [...allowlist]};
    }

    public async getQrPng(): Promise<Buffer | null> {
        if (!this.currentQr) {
            return null;
        }
        return QRCode.toBuffer(this.currentQr, {type: 'png', width: 512, margin: 2});
    }

    private buildClientOptions(): ClientOptions {
        const puppeteer: LaunchOptions = {headless: true, args: PUPPETEER_ARGS};

        if (config.whatsapp.puppeteerExecutablePath) {
            puppeteer.executablePath = config.whatsapp.puppeteerExecutablePath;
        } else if (config.whatsapp.puppeteerChannel) {
            puppeteer.channel = config.whatsapp.puppeteerChannel as ChromeReleaseChannel;
        }

        const options: ClientOptions = {
            authStrategy: new LocalAuth({
                clientId: config.whatsapp.clientId,
                dataPath: config.whatsapp.sessionPath,
            }),
            puppeteer,
        };

        const version = config.whatsapp.webVersion;
        if (version) {
            options.webVersion = version;
            options.webVersionCache = {
                type: 'remote',
                remotePath:
                    config.whatsapp.webVersionRemotePath ??
                    `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${version}.html`,
            };
            logger.info('Pinning WhatsApp Web version', {version});
        }

        return options;
    }

    private registerEventHandlers(): void {
        this.client.on('qr', (qr) => {
            this.status = 'qr';
            this.currentQr = qr;
            this.clearReadyWatchdog();
            logger.warn('WhatsApp session not found — scan the QR (GET /qr) to log in.');
            qrcodeTerminal.generate(qr, {small: true});
            void this.saveQrImage(qr);
        });

        this.client.on('authenticated', () => {
            this.status = 'authenticated';
            this.currentQr = null;
            logger.info('WhatsApp authenticated; session persisted.');
            this.armReadyWatchdog();
            void this.removeQrImage();
        });

        this.client.on('auth_failure', (msg) => {
            this.status = 'disconnected';
            logger.error('WhatsApp authentication failed', msg);
        });

        this.client.on('ready', () => {
            this.status = 'ready';
            this.currentQr = null;
            this.clearReadyWatchdog();
            logger.info('WhatsApp client is ready.');
            void this.logWebVersion();
            this.startHeartbeat();
            this.startReconcile();
            void this.reconcile();
        });

        this.client.on('disconnected', (reason) => {
            this.status = 'disconnected';
            logger.error('WhatsApp client disconnected', reason);
            void this.recoverFromFrameError(new Error(`disconnected: ${String(reason)}`));
        });

        this.client.on('message', (message) => {
            void this.forwardMessage(message).catch((err) =>
                logger.warn('Live message forward failed; reconcile will retry.', err),
            );
        });
    }

    private startHeartbeat(): void {
        const interval = config.whatsapp.healthCheckIntervalMs;
        if (interval <= 0 || this.heartbeatTimer) {
            return;
        }
        this.heartbeatTimer = setInterval(() => void this.checkHealth(), interval);
        this.heartbeatTimer.unref?.();
        logger.info('WhatsApp heartbeat started', {intervalMs: interval});
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    private armReadyWatchdog(): void {
        const timeout = config.whatsapp.readyTimeoutMs;
        if (timeout <= 0) {
            return;
        }
        this.clearReadyWatchdog();
        this.readyWatchdogTimer = setTimeout(() => {
            this.readyWatchdogTimer = null;
            if (this.status === 'ready' || this.status === 'qr' || this.reinitializing) {
                return;
            }
            logger.warn('Watchdog: client never became ready; restarting session.', {
                status: this.status,
                timeoutMs: timeout,
            });
            void this.recoverFromFrameError(
                new Error(`stuck in status=${this.status} for ${timeout}ms without 'ready'`),
            );
        }, timeout);
        this.readyWatchdogTimer.unref?.();
    }

    private clearReadyWatchdog(): void {
        if (this.readyWatchdogTimer) {
            clearTimeout(this.readyWatchdogTimer);
            this.readyWatchdogTimer = null;
        }
    }

    private async checkHealth(): Promise<void> {
        if (this.reinitializing || this.status === 'qr') {
            return;
        }
        const ready = this.status === 'ready';
        try {
            const state = await this.withTimeout(
                Promise.resolve(this.client.getState()),
                config.whatsapp.healthCheckTimeoutMs,
                'client.getState',
            );
            if (state === 'CONNECTED') {
                return;
            }
            if (ready) {
                logger.warn('Heartbeat: session not connected; recovering.', {state});
                void this.recoverFromFrameError(new Error(`health check state=${String(state)}`));
            } else {
                logger.info('Heartbeat: still waiting for a ready session.', {
                    status: this.status,
                    state,
                });
            }
        } catch (err) {
            if (ready) {
                logger.warn('Heartbeat: getState failed; recovering session.', err);
                void this.recoverFromFrameError(err);
            } else {
                logger.info('Heartbeat: getState unavailable while not ready.', {
                    status: this.status,
                });
            }
        }
    }

    /**
     * Records which WhatsApp Web build the session actually loaded. The injected helpers talk
     * to that build's internals, so when they start throwing this line says what to pin
     * WHATSAPP_WEB_VERSION to (or which build broke).
     */
    private async logWebVersion(): Promise<void> {
        try {
            logger.info('WhatsApp Web version in use', {
                version: await this.client.getWWebVersion(),
                pinned: config.whatsapp.webVersion ?? null,
            });
        } catch (err) {
            logger.warn('Could not read the WhatsApp Web version', err);
        }
    }

    private startReconcile(): void {
        const interval = config.whatsapp.reconcileIntervalMs;
        if (interval <= 0 || this.reconcileTimer || !this.publisher.isEnabled) {
            return;
        }
        this.reconcileTimer = setInterval(() => void this.reconcile(), interval);
        this.reconcileTimer.unref?.();
        logger.info('WhatsApp reconcile loop started', {intervalMs: interval});
    }

    private stopReconcile(): void {
        if (this.reconcileTimer) {
            clearInterval(this.reconcileTimer);
            this.reconcileTimer = null;
        }
    }

    private canReconcile(): boolean {
        return (
            this.publisher.isEnabled &&
            !this.reconciling &&
            !this.reinitializing &&
            this.status === 'ready' &&
            this.cursor >= 0 &&
            Date.now() >= this.reconcileBackoffUntil
        );
    }

    /**
     * The chats a reconcile pass walks.
     *
     * `client.getChats()` serializes every chat in one page call, so a single chat the library
     * cannot model — a `@lid` thread or a channel it does not know how to read — rejects the
     * whole call and no pass ever completes. With a forward allowlist configured we therefore
     * ask for exactly those chats; nothing else would be published anyway. Without one we fall
     * back to the bulk read and, if that throws, to reading the ids and fetching chats one at a
     * time so a bad chat costs its own messages instead of the entire pass.
     */
    private async listChats(): Promise<Chat[]> {
        const allowed = config.rabbitmq.chatIds;
        if (allowed.length > 0) {
            return this.fetchChatsById(allowed);
        }

        try {
            return await this.client.getChats();
        } catch (err) {
            if (this.isTransientFrameError(err)) throw err;

            logger.warn('Reconcile: bulk chat read failed; falling back to per-chat reads.', err);
            return this.fetchChatsById(await this.listChatIds());
        }
    }

    private async fetchChatsById(chatIds: readonly string[]): Promise<Chat[]> {
        const chats: Chat[] = [];

        for (const chatId of chatIds) {
            try {
                const chat = await this.client.getChatById(chatId);
                if (chat) {
                    chats.push(chat);
                }
            } catch (err) {
                if (this.isTransientFrameError(err)) throw err;
                logger.warn('Reconcile: skipping a chat that would not load', {chatId, err});
            }
        }

        return chats;
    }

    /**
     * Ids only, straight from the collection whatsapp-web.js itself reads. Nothing per-chat is
     * serialized here, so the one chat that breaks the bulk read cannot break this too.
     */
    private async listChatIds(): Promise<string[]> {
        const page = this.client.pupPage;
        if (!page) {
            return [];
        }

        return page.evaluate(() => {
            // globalThis, not window: the project compiles without the DOM lib, and inside the
            // page the two are the same object anyway.
            const collections = (
                globalThis as unknown as {
                    require: (module: string) => {
                        Chat: {getModelsArray: () => {id?: {_serialized?: string}}[]};
                    };
                }
            ).require('WAWebCollections');

            return collections.Chat.getModelsArray()
                .map((chat) => chat?.id?._serialized)
                .filter((chatId): chatId is string => Boolean(chatId));
        });
    }

    private async reconcile(): Promise<void> {
        if (!this.canReconcile()) return;

        this.reconciling = true;
        const scanFrom = Math.max(0, this.cursor - config.whatsapp.reconcileLookbackSec);
        let maxConfirmed = this.cursor;
        let allConfirmed = true;
        let published = 0;
        try {
            for (const chat of await this.listChats()) {
                if (toSeconds(chat.timestamp) < scanFrom && chat.unreadCount <= 0) continue;

                let messages: Message[];
                try {
                    messages = await chat.fetchMessages({limit: config.whatsapp.catchUpLimitPerChat});
                } catch (err) {
                    if (this.isTransientFrameError(err)) throw err;
                    logger.warn('Reconcile: failed to fetch messages for chat', {
                        chatId: chat.id?._serialized,
                        err,
                    });
                    allConfirmed = false;
                    continue;
                }

                for (const message of messages) {
                    const timestamp = toSeconds(message.timestamp);
                    if (message.fromMe || timestamp < scanFrom) continue;

                    if (await this.forwardMessage(message)) {
                        published += 1;
                        maxConfirmed = Math.max(maxConfirmed, timestamp);
                    } else {
                        allConfirmed = false;
                    }
                }
            }

            if (allConfirmed && maxConfirmed > this.cursor) {
                this.cursor = maxConfirmed;
                await this.saveCursor();
            }
            this.reconcileFailures = 0;
            this.reconcileRestarts = 0;
            this.reconcileBackoffUntil = 0;
            if (published > 0) {
                logger.info('Reconcile pass complete', {
                    published,
                    cursor: this.cursor,
                    fullyConfirmed: allConfirmed,
                });
            }
        } catch (err) {
            this.handleReconcileFailure(err);
        } finally {
            this.reconciling = false;
        }
    }

    private handleReconcileFailure(err: unknown): void {
        if (this.isTransientFrameError(err)) {
            logger.warn('Reconcile: session frame lost mid-scan; recovering.', err);
            void this.recoverFromFrameError(err);
            return;
        }

        this.reconcileFailures += 1;
        logger.error('Reconcile pass failed', {
            consecutiveFailures: this.reconcileFailures,
            error: this.describeError(err),
        });

        const limit = config.whatsapp.reconcileMaxFailures;
        if (limit > 0 && this.reconcileFailures >= limit) {
            // A restart cures a sick session, not an incompatible one: when the injected page
            // code no longer matches the WhatsApp Web build it is talking to, the fresh session
            // fails the same way. So each escalation also pauses scanning for twice as long as
            // the last, turning a permanent fault into an occasional retry instead of a restart
            // every few passes. A pass that finally succeeds clears the whole ladder.
            const pausedForMs = this.nextReconcileBackoffMs();

            this.reconcileFailures = 0;
            this.reconcileRestarts += 1;
            this.reconcileBackoffUntil = Date.now() + pausedForMs;

            logger.warn('Reconcile: failing persistently; restarting session and pausing scans.', {
                consecutiveRestarts: this.reconcileRestarts,
                pausedForMs,
            });

            void this.recoverFromFrameError(err);
        }
    }

    /**
     * How long to leave reconcile alone after an escalation: one scan interval, then double
     * per consecutive restart, up to WHATSAPP_RECONCILE_BACKOFF_MAX_MS.
     */
    private nextReconcileBackoffMs(): number {
        const base = Math.max(1000, config.whatsapp.reconcileIntervalMs);
        const ceiling = Math.max(base, config.whatsapp.reconcileBackoffMaxMs);

        return Math.min(base * 2 ** this.reconcileRestarts, ceiling);
    }

    private buildPayload(message: Message): Record<string, unknown> {
        return {
            id: messageIdOf(message),
            chatId: message.from,
            from: message.from,
            author: message.author,
            body: message.body,
            type: message.type,
            timestamp: message.timestamp,
            hasMedia: message.hasMedia,
        };
    }

    private async forwardMessage(message: Message): Promise<boolean> {
        const chatId = message.from;
        const messageId = messageIdOf(message);
        const result = await this.publisher.publishMessage(
            chatId,
            this.buildPayload(message),
            messageId,
        );

        if (result === 'published') {
            logger.info('Message forwarded', {chatId, messageId, hasMedia: message.hasMedia});
        }

        // 'filtered' counts as confirmed: the message was never meant to leave, so the cursor
        // moves past it. It is not logged as forwarded — that read as a contradiction next to
        // the allowlist skip line it always follows.
        return result !== 'unconfirmed';
    }

    private async loadCursor(): Promise<void> {
        if (this.cursor >= 0) return;
        try {
            const raw = await readFile(this.cursorPath, 'utf8');
            const parsed = JSON.parse(raw) as {cursor?: unknown};
            if (typeof parsed.cursor === 'number' && Number.isFinite(parsed.cursor)) {
                this.cursor = parsed.cursor;
                logger.info('Loaded delivery cursor', {cursor: this.cursor});
                return;
            }
        } catch {
            // no persisted cursor yet
        }
        this.cursor = Math.floor(Date.now() / 1000);
        await this.saveCursor();
        logger.info('Initialized delivery cursor at current time', {cursor: this.cursor});
    }

    private async saveCursor(): Promise<void> {
        try {
            await mkdir(dirname(this.cursorPath), {recursive: true});
            const tmp = `${this.cursorPath}.tmp`;
            await writeFile(tmp, JSON.stringify({cursor: this.cursor}), 'utf8');
            await rename(tmp, this.cursorPath);
        } catch (err) {
            logger.warn('Failed to persist delivery cursor', err);
        }
    }

    private async saveQrImage(qr: string): Promise<void> {
        try {
            await mkdir(dirname(this.qrImagePath), {recursive: true});
            await QRCode.toFile(this.qrImagePath, qr, {width: 512, margin: 2});
            logger.info(`QR code image written (open and scan): ${this.qrImagePath}`);
        } catch (err) {
            logger.warn('Failed to write QR image file', err);
        }
    }

    private async removeQrImage(): Promise<void> {
        try {
            await rm(this.qrImagePath, {force: true});
        } catch {
            // best-effort cleanup
        }
    }

    private async clearChromiumLocks(): Promise<void> {
        const profileDir = join(
            config.whatsapp.sessionPath,
            `session-${config.whatsapp.clientId}`,
        );
        await Promise.all(
            CHROMIUM_LOCK_FILES.map(async (name) => {
                try {
                    await rm(join(profileDir, name), {force: true, recursive: true});
                } catch (err) {
                    logger.warn(`Failed to remove stale Chromium lock ${name}`, err);
                }
            }),
        );
    }

    private async resolveChatId(phoneNumber: string): Promise<string> {
        const sanitized = phoneNumber.replace(/\D/g, '');
        if (!sanitized) {
            throw new NumberNotFoundError(phoneNumber);
        }

        let numberId;
        try {
            numberId = await this.client.getNumberId(sanitized);
        } catch (err) {
            if (!this.isTransientFrameError(err)) {
                throw err;
            }
            logger.warn('WhatsApp frame detached during getNumberId; retrying once.', err);
            await sleep(config.whatsapp.frameRetryDelayMs);
            try {
                numberId = await this.client.getNumberId(sanitized);
            } catch (retryErr) {
                if (this.isTransientFrameError(retryErr)) {
                    void this.recoverFromFrameError(retryErr);
                    throw new WhatsAppNotReadyError();
                }
                throw retryErr;
            }
        }

        if (!numberId) {
            throw new NumberNotFoundError(phoneNumber);
        }
        return numberId._serialized;
    }

    private toMessageMedia(file: MediaAttachment): MessageMedia {
        if (file.path) {
            return MessageMedia.fromFilePath(file.path);
        }
        if (file.buffer) {
            if (!file.mimetype || !file.filename) {
                throw new BadAttachmentError('buffer attachments require mimetype and filename');
            }
            return new MessageMedia(file.mimetype, file.buffer.toString('base64'), file.filename);
        }
        if (file.base64) {
            if (!file.mimetype || !file.filename) {
                throw new BadAttachmentError('base64 attachments require mimetype and filename');
            }
            return new MessageMedia(file.mimetype, file.base64, file.filename);
        }
        throw new BadAttachmentError('attachment must provide one of path, buffer, or base64');
    }

    private async recoverFromFrameError(err: unknown): Promise<void> {
        this.status = 'disconnected';
        if (this.reinitializing) {
            return;
        }
        this.reinitializing = true;
        logger.warn('Recovering WhatsApp client after frame/session loss...', err);
        try {
            try {
                await this.client.destroy();
            } catch (destroyErr) {
                logger.warn('Error while destroying client during recovery', destroyErr);
            }
            await this.clearChromiumLocks();
            this.status = 'initializing';
            this.armReadyWatchdog();
            await this.client.initialize();
        } catch (reinitErr) {
            this.status = 'disconnected';
            logger.error('WhatsApp client recovery failed', reinitErr);
        } finally {
            this.reinitializing = false;
        }
    }

    private async throttle(): Promise<void> {
        const minDelay = config.whatsapp.messageDelayMs;
        if (minDelay <= 0) return;
        const elapsed = Date.now() - this.lastSentAt;
        if (elapsed < minDelay) {
            await sleep(minDelay - elapsed);
        }
        this.lastSentAt = Date.now();
    }

    private withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
        if (ms <= 0) {
            return promise;
        }
        let timer: ReturnType<typeof setTimeout>;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(
                () => reject(new Error(`Timed out after ${ms}ms waiting for ${label}`)),
                ms,
            );
        });
        return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
    }

    private isTransientFrameError(err: unknown): boolean {
        return TRANSIENT_FRAME_ERROR.test(err instanceof Error ? err.message : String(err));
    }

    private describeError(err: unknown): string {
        if (err instanceof Error) {
            return err.stack ?? `${err.name}: ${err.message}`;
        }
        return String(err);
    }
}
