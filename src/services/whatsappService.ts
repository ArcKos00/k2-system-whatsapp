import {Client, LocalAuth, MessageMedia} from 'whatsapp-web.js';
import type {ClientOptions, Message} from 'whatsapp-web.js';
import type {ChromeReleaseChannel, LaunchOptions} from 'puppeteer';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import {mkdir, rm, readFile, writeFile, rename} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {singleton} from 'tsyringe';
import {config} from '../config/env';
import {logger} from '../utils/logger';
import {RabbitMqPublisher} from './rabbitMqPublisher';
import {
    BadAttachmentError,
    MessageSendError,
    NumberNotFoundError,
    WhatsAppNotReadyError,
} from '../errors/appErrors';

/**
 * One of:
 *  - `path`   : absolute/relative path to a file on disk (read by the lib);
 *  - `buffer` : raw bytes (e.g. from a multipart upload), requires mimetype + filename;
 *  - `base64` : base64 string, requires mimetype + filename.
 */
export interface MediaAttachment {
    path?: string;
    buffer?: Buffer;
    base64?: string;
    mimetype?: string;
    filename?: string;
}

export type WhatsAppStatus = 'initializing' | 'qr' | 'authenticated' | 'ready' | 'disconnected';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Owns the single whatsapp-web.js client instance, its lifecycle, and
 * the send pipeline. Registered as a tsyringe singleton so the same
 * authenticated session is shared across all controllers.
 */
@singleton()
export class WhatsappService {
    private readonly client: Client;
    private status: WhatsAppStatus = 'initializing';
    private lastSentAt = 0;
    /** Guards against overlapping recovery attempts after a frame loss. */
    private reinitializing = false;
    /** Periodic liveness probe; catches silent session deaths while idle. */
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    /** Periodic catch-up scan; the safety net that guarantees no lost message. */
    private reconcileTimer: ReturnType<typeof setInterval> | null = null;
    /** Guards against overlapping reconcile passes. */
    private reconciling = false;
    /**
     * Delivery cursor: WhatsApp timestamp (seconds) of the newest message we
     * have confirmed-published. Reconcile re-scans everything at-or-after this
     * and only advances it after a fully-confirmed pass, so a crash/outage
     * re-fetches instead of dropping. -1 until loaded from disk.
     */
    private cursor = -1;
    /** Latest QR string while awaiting login; null once authenticated. */
    private currentQr: string | null = null;
    /** Where the scannable QR PNG is written while awaiting login. */
    private readonly qrImagePath: string;
    /** Where the delivery cursor is persisted (durable, survives restarts). */
    private readonly cursorPath: string;

    constructor(private readonly publisher: RabbitMqPublisher) {
        this.qrImagePath =
            config.whatsapp.qrImagePath ?? join(config.whatsapp.sessionPath, 'qr.png');
        this.cursorPath =
            config.whatsapp.cursorPath ?? join(config.whatsapp.sessionPath, 'cursor.json');

        const puppeteerOptions: LaunchOptions = {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                // Memory-reduction flags: headless Chromium under a k8s memory
                // limit grows steadily as WA Web reloads/re-injects, which is the
                // usual cause of OOMKilled (137). These trim its footprint.
                '--no-zygote',
                '--js-flags=--max-old-space-size=256',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--mute-audio',
            ],
        };

        // Browser resolution priority:
        //  1. PUPPETEER_EXECUTABLE_PATH — explicit binary (used in Docker -> /usr/bin/chromium);
        //  2. PUPPETEER_BROWSER_CHANNEL — an installed channel like "chrome" / "msedge"
        //     (portable for local dev; no Chromium download required);
        //  3. fall back to Puppeteer's bundled/cached Chromium.
        if (config.whatsapp.puppeteerExecutablePath) {
            puppeteerOptions.executablePath = config.whatsapp.puppeteerExecutablePath;
        } else if (config.whatsapp.puppeteerChannel) {
            puppeteerOptions.channel = config.whatsapp.puppeteerChannel as ChromeReleaseChannel;
        }

        const clientOptions: ClientOptions = {
            authStrategy: new LocalAuth({
                clientId: config.whatsapp.clientId,
                dataPath: config.whatsapp.sessionPath,
            }),
            puppeteer: puppeteerOptions,
        };

        // Pin a known-good WhatsApp Web build when configured. This is the standard
        // remedy for "Execution context was destroyed" during inject, which happens
        // when the live WA Web version is incompatible with the injected scripts.
        if (config.whatsapp.webVersion) {
            const version = config.whatsapp.webVersion;
            clientOptions.webVersion = version;
            clientOptions.webVersionCache = {
                type: 'remote',
                remotePath:
                    config.whatsapp.webVersionRemotePath ??
                    `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${version}.html`,
            };
            logger.info('Pinning WhatsApp Web version', {version});
        }

        this.client = new Client(clientOptions);
    }

    /** Wire up event handlers and start the underlying browser/session. */
    public async initClient(): Promise<void> {
        await this.loadCursor();
        this.registerEventHandlers();
        await this.clearChromiumLocks();

        const maxAttempts = Math.max(1, config.whatsapp.initMaxAttempts);
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                logger.info('Initializing WhatsApp client...', {
                    clientId: config.whatsapp.clientId,
                    attempt,
                    maxAttempts,
                });
                // initialize() can hang forever if the browser launch or WA Web page
                // load stalls (e.g. a stale Chromium profile lock), so bound it.
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

                // Tear down the half-open browser so the next attempt relaunches clean.
                try {
                    await this.client.destroy();
                } catch (destroyErr) {
                    logger.warn('Error destroying client between init attempts', destroyErr);
                }
                await sleep(config.whatsapp.frameRetryDelayMs * attempt);
            }
        }
    }

    /**
     * Reject with a timeout error if `promise` does not settle within `ms`.
     * Used to stop a hung client.initialize() from blocking startup forever.
     */
    private withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
        if (ms <= 0) {
            return promise;
        }
        let timer: ReturnType<typeof setTimeout>;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms waiting for ${label}`)), ms);
        });
        return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
    }

    public getStatus(): WhatsAppStatus {
        return this.status;
    }

    public isReady(): boolean {
        return this.status === 'ready';
    }

    /**
     * Whether an error is a transient WhatsApp Web page/frame failure this
     * service knows how to recover from (vs. a genuine bug). The process-level
     * guards in server.ts use this to decide between recovering and crashing,
     * because whatsapp-web.js re-injects on WA Web navigation and can throw
     * "Execution context was destroyed" asynchronously, outside any try/catch.
     */
    public isRecoverableError(err: unknown): boolean {
        return this.isTransientFrameError(err);
    }

    /** Graceful shutdown (called on SIGINT/SIGTERM). */
    public async destroy(): Promise<void> {
        this.stopHeartbeat();
        this.stopReconcile();
        try {
            await this.client.destroy();
        } catch (err) {
            logger.warn('Error while destroying WhatsApp client', err);
        }
    }

    /**
     * Start the periodic liveness probe (idempotent). Safe to call on every
     * 'ready'; only the first call installs the timer.
     */
    private startHeartbeat(): void {
        const interval = config.whatsapp.healthCheckIntervalMs;
        if (interval <= 0 || this.heartbeatTimer) {
            return;
        }
        this.heartbeatTimer = setInterval(() => void this.checkHealth(), interval);
        // Don't let the probe alone keep the process alive during shutdown.
        this.heartbeatTimer.unref?.();
        logger.info('WhatsApp heartbeat started', {intervalMs: interval});
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    /**
     * Actively verify the session is still alive. whatsapp-web.js can stop
     * delivering 'message' events without ever emitting 'disconnected' when the
     * underlying page/frame silently detaches; getState() surfaces that (it
     * throws on a dead frame, or returns a non-CONNECTED state). Any anomaly
     * triggers the same recovery path used by the send flow.
     */
    private async checkHealth(): Promise<void> {
        // Skip while a (re)init is already in flight or we know we're not ready;
        // the recovery/ready lifecycle already governs those transitions.
        if (this.reinitializing || this.status !== 'ready') {
            return;
        }
        try {
            const state = await this.withTimeout(
                Promise.resolve(this.client.getState()),
                config.whatsapp.healthCheckTimeoutMs,
                'client.getState',
            );
            if (state !== 'CONNECTED') {
                logger.warn('Heartbeat: session not connected; recovering.', {state});
                void this.recoverFromFrameError(new Error(`health check state=${String(state)}`));
            }
        } catch (err) {
            logger.warn('Heartbeat: getState failed; recovering session.', err);
            void this.recoverFromFrameError(err);
        }
    }

    // --- delivery guarantee (catch-up / reconcile) ---------------------------

    /**
     * Serialize an inbound WhatsApp message into the RabbitMQ payload. The
     * WhatsApp message id travels as both `id` (payload) and the AMQP messageId
     * so downstream consumers can deduplicate — delivery is at-least-once.
     */
    private buildPayload(message: Message): Record<string, unknown> {
        return {
            id: message.id?._serialized,
            chatId: message.from,
            from: message.from,
            author: message.author,
            body: message.body,
            type: message.type,
            timestamp: message.timestamp,
            hasMedia: message.hasMedia,
        };
    }

    /**
     * Publish a single inbound message and report whether the broker confirmed
     * it. Used by both the live 'message' handler and the reconcile loop.
     */
    private async forwardMessage(message: Message): Promise<boolean> {
        const chatId = message.from;
        const messageId = message.id?._serialized;
        const confirmed = await this.publisher.publishMessage(
            chatId,
            this.buildPayload(message),
            messageId,
        );
        if (confirmed) {
            logger.info('Message forwarded', {chatId, messageId, hasMedia: message.hasMedia});
        }
        return confirmed;
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

    /**
     * The safety net that guarantees no inbound message is lost. Re-scans chats
     * for inbound messages at-or-after the delivery cursor and (re)publishes any
     * the broker has not confirmed. WhatsApp Web itself is the durable source
     * (messages stay there until synced), so this recovers both session-downtime
     * gaps and RabbitMQ-outage gaps. The cursor advances ONLY after a fully
     * confirmed pass, so any failure re-fetches next time instead of dropping.
     */
    private async reconcile(): Promise<void> {
        if (!this.publisher.isEnabled) return;
        if (this.reconciling || this.reinitializing || this.status !== 'ready') return;
        if (this.cursor < 0) return; // cursor not loaded yet

        this.reconciling = true;
        const scanFrom = Math.max(0, this.cursor - config.whatsapp.reconcileLookbackSec);
        let maxConfirmed = this.cursor;
        let allConfirmed = true;
        let published = 0;
        try {
            const chats = await this.client.getChats();
            for (const chat of chats) {
                // A chat can only hold new inbound messages if its last activity
                // is at/after our scan point, or it has unread messages.
                const lastActivity = typeof chat.timestamp === 'number' ? chat.timestamp : 0;
                if (lastActivity < scanFrom && chat.unreadCount <= 0) continue;

                let messages: Message[];
                try {
                    messages = await chat.fetchMessages({limit: config.whatsapp.catchUpLimitPerChat});
                } catch (err) {
                    if (this.isTransientFrameError(err)) throw err; // handled below
                    logger.warn('Reconcile: failed to fetch messages for chat', {
                        chatId: chat.id?._serialized,
                        err,
                    });
                    allConfirmed = false; // don't advance past a chat we couldn't read
                    continue;
                }

                for (const message of messages) {
                    if (message.fromMe) continue; // inbound only, matching the live 'message' event
                    const ts = typeof message.timestamp === 'number' ? message.timestamp : 0;
                    if (ts < scanFrom) continue; // already covered

                    if (await this.forwardMessage(message)) {
                        published += 1;
                        if (ts > maxConfirmed) maxConfirmed = ts;
                    } else {
                        // Broker down/nacked: hold the cursor so this message is
                        // re-fetched and re-published on the next pass.
                        allConfirmed = false;
                    }
                }
            }

            if (allConfirmed && maxConfirmed > this.cursor) {
                this.cursor = maxConfirmed;
                await this.saveCursor();
            }
            if (published > 0) {
                logger.info('Reconcile pass complete', {
                    published,
                    cursor: this.cursor,
                    fullyConfirmed: allConfirmed,
                });
            }
        } catch (err) {
            if (this.isTransientFrameError(err)) {
                logger.warn('Reconcile: session frame lost mid-scan; recovering.', err);
                void this.recoverFromFrameError(err);
            } else {
                logger.error('Reconcile pass failed', err);
            }
        } finally {
            this.reconciling = false;
        }
    }

    /** Load the persisted delivery cursor, or seed it at "now" on first run. */
    private async loadCursor(): Promise<void> {
        if (this.cursor >= 0) return; // already loaded
        try {
            const raw = await readFile(this.cursorPath, 'utf8');
            const parsed = JSON.parse(raw) as {cursor?: unknown};
            if (typeof parsed.cursor === 'number' && Number.isFinite(parsed.cursor)) {
                this.cursor = parsed.cursor;
                logger.info('Loaded delivery cursor', {cursor: this.cursor});
                return;
            }
        } catch {
            // Missing (first run) or unreadable — fall through to seed below.
        }
        // First ever start: begin at the current time so we don't replay the
        // whole chat history, but guarantee every message from here on.
        this.cursor = Math.floor(Date.now() / 1000);
        await this.saveCursor();
        logger.info('Initialized delivery cursor at current time', {cursor: this.cursor});
    }

    /** Persist the cursor atomically (temp file + rename) to avoid corruption. */
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

    /**
     * Send a text message and/or attachments to a phone number.
     * Applies an anti-ban throttle between every dispatched message.
     */
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
                // The page died mid-send. We deliberately do NOT retry here: the send
                // may have partially gone through, and a blind retry risks duplicates.
                // Recover the session and let the caller retry the whole request.
                void this.recoverFromFrameError(err);
                throw new WhatsAppNotReadyError();
            }
            throw new MessageSendError(err instanceof Error ? err.message : String(err));
        }

        logger.info('Message dispatched', {chatId, sentMessages});
        return {success: true, chatId, sentMessages};
    }

    // --- internals -----------------------------------------------------------

    private registerEventHandlers(): void {
        this.client.on('qr', (qr) => {
            this.status = 'qr';
            this.currentQr = qr;
            logger.warn('WhatsApp session not found — scan the QR (GET /qr) to log in.');
            // Terminal rendering is aspect-ratio dependent (often stretched in log
            // viewers), so the PNG (file + /qr endpoint) is the reliable version.
            qrcodeTerminal.generate(qr, {small: true});
            void this.saveQrImage(qr);
        });

        this.client.on('authenticated', () => {
            this.status = 'authenticated';
            // The QR is a login credential — drop it once it is consumed.
            this.currentQr = null;
            logger.info('WhatsApp authenticated; session persisted.');
            void this.removeQrImage();
        });

        this.client.on('auth_failure', (msg) => {
            this.status = 'disconnected';
            logger.error('WhatsApp authentication failed', msg);
        });

        this.client.on('ready', () => {
            this.status = 'ready';
            this.currentQr = null;
            logger.info('WhatsApp client is ready.');
            // Start (idempotently) probing liveness now that we have a session.
            this.startHeartbeat();
            // Immediately catch up on anything that arrived while we were down,
            // then keep the periodic reconcile net running.
            this.startReconcile();
            void this.reconcile();
        });

        this.client.on('disconnected', (reason) => {
            this.status = 'disconnected';
            logger.error('WhatsApp client disconnected', reason);
            // A listener-primary service may never issue a send to detect the
            // dead session lazily, so it would stay disconnected forever. Kick
            // off recovery here; the 'ready' event flips status back on success.
            void this.recoverFromFrameError(new Error(`disconnected: ${String(reason)}`));
        });

        this.client.on('message', (message) => {
            // Low-latency path. Correctness does NOT depend on this handler: the
            // reconcile loop re-publishes anything not confirmed here, so a throw
            // or a broker blip never loses the message. Fire-and-forget, but any
            // rejection is contained so it can't become an unhandledRejection.
            void this.forwardMessage(message).catch((err) =>
                logger.warn('Live message forward failed; reconcile will retry.', err),
            );
        });
    }

    /** Current login QR as a square PNG buffer, or null when none is pending. */
    public async getQrPng(): Promise<Buffer | null> {
        if (!this.currentQr) {
            return null;
        }
        return QRCode.toBuffer(this.currentQr, {type: 'png', width: 512, margin: 2});
    }

    /** Render the QR to a square PNG on disk and log where to find it. */
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
            // best-effort cleanup; ignore
        }
    }

    /**
     * Remove stale Chromium singleton lock files from the persisted profile.
     * When a pod/process is killed without a clean shutdown (OOM, node drain),
     * Chromium leaves a SingletonLock symlink behind. On a persistent session
     * volume the next launch sees it and aborts with "The profile appears to be
     * in use by another Chromium process", code 21. Safe to clear because this
     * service is single-instance — only one process owns the session at a time.
     */
    private async clearChromiumLocks(): Promise<void> {
        // LocalAuth stores the Chromium user-data-dir at <sessionPath>/session-<clientId>.
        const profileDir = join(
            config.whatsapp.sessionPath,
            `session-${config.whatsapp.clientId}`,
        );
        const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
        await Promise.all(
            lockFiles.map(async (name) => {
                try {
                    await rm(join(profileDir, name), {force: true, recursive: true});
                } catch (err) {
                    logger.warn(`Failed to remove stale Chromium lock ${name}`, err);
                }
            }),
        );
    }

    /** Validate the number exists on WhatsApp and return its chat id. */
    private async resolveChatId(phoneNumber: string): Promise<string> {
        const sanitized = phoneNumber.replace(/\D/g, '');
        if (!sanitized) {
            throw new NumberNotFoundError(phoneNumber);
        }

        // getNumberId runs page.evaluate inside WhatsApp Web's main frame; that
        // frame can be transiently detached when WA Web reloads itself. The lookup
        // is idempotent, so retry once before giving up.
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
                    // Still broken after the page should have settled: the session is
                    // unhealthy. Trigger recovery and surface a retryable 503.
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

    /**
     * Whether an error came from the underlying Puppeteer page/frame being torn
     * down (WhatsApp Web reload, renderer crash, session closed) rather than a
     * genuine application-level failure. These are transient and recoverable.
     */
    private isTransientFrameError(err: unknown): boolean {
        const message = err instanceof Error ? err.message : String(err);
        return /detached Frame|Execution context was destroyed|Session closed|Target closed|Protocol error|Most likely the page has been closed/i.test(
            message,
        );
    }

    /**
     * Recover from a lost page/frame: mark the client not-ready (so further
     * requests fail fast with 503 instead of hitting a dead frame) and restart
     * the underlying session in the background. Best-effort and re-entrant-safe;
     * the 'ready' event flips status back once the session reconnects.
     */
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
            await this.client.initialize();
        } catch (reinitErr) {
            this.status = 'disconnected';
            logger.error('WhatsApp client recovery failed', reinitErr);
        } finally {
            this.reinitializing = false;
        }
    }

    /** Enforce a minimum gap between consecutive sends to reduce ban risk. */
    private async throttle(): Promise<void> {
        const minDelay = config.whatsapp.messageDelayMs;
        if (minDelay <= 0) return;
        const elapsed = Date.now() - this.lastSentAt;
        if (elapsed < minDelay) {
            await sleep(minDelay - elapsed);
        }
        this.lastSentAt = Date.now();
    }
}
