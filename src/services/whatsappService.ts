import {Client, LocalAuth, MessageMedia} from 'whatsapp-web.js';
import type {ClientOptions} from 'whatsapp-web.js';
import type {ChromeReleaseChannel, LaunchOptions} from 'puppeteer';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import {mkdir, rm} from 'node:fs/promises';
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
    /** Latest QR string while awaiting login; null once authenticated. */
    private currentQr: string | null = null;
    /** Where the scannable QR PNG is written while awaiting login. */
    private readonly qrImagePath: string;

    constructor(private readonly publisher: RabbitMqPublisher) {
        this.qrImagePath =
            config.whatsapp.qrImagePath ?? join(config.whatsapp.sessionPath, 'qr.png');

        const puppeteerOptions: LaunchOptions = {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
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
        try {
            await this.client.destroy();
        } catch (err) {
            logger.warn('Error while destroying WhatsApp client', err);
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
        });

        this.client.on('disconnected', (reason) => {
            this.status = 'disconnected';
            logger.error('WhatsApp client disconnected', reason);
        });

        this.client.on('message', async (message) => {
            const chatId = message.from;
            
            const contact = await message.getContact();
            logger.info(`Received message from chat ${chatId}`, {
                author: message.author,
                some: contact.name,
                hasMedia: message.hasMedia,
            });

            // Forward to RabbitMQ (headers exchange) so downstream consumers can
            // route on the `chatId` header. Best-effort: failures are swallowed
            // inside the publisher and must not break message handling.
            this.publisher.publishMessage(chatId, {
                id: message.id?._serialized,
                chatId,
                from: message.from,
                author: message.author,
                body: message.body,
                type: message.type,
                timestamp: message.timestamp,
                hasMedia: message.hasMedia,
            });
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
