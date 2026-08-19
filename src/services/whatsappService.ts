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
import type {ChatKind, ChatListResponse, ChatNameSource, ChatSummaryDto} from '../dtos/chat.dto';
import {
    BadAttachmentError,
    ChatNotFoundError,
    InvalidChatIdError,
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

/** What every send path returns, whether it was addressed by number or by chat id. */
export interface SendResult {
    success: boolean;
    chatId: string;
    sentMessages: number;
}

export type WhatsAppStatus = 'initializing' | 'qr' | 'authenticated' | 'ready' | 'disconnected';

/**
 * Everything WhatsApp's own in-page chat model knows about one chat, read straight out of the
 * collection instead of through the library's serializer.
 *
 * The serializer only ever gives us `formattedTitle`, which is empty for exactly the chats that
 * need a name most: a group whose metadata has not synced, or a stranger who is not in the
 * phone's address book. Reading the model lets us fall back to the group subject, the contact
 * record and finally the number, and it does it for the whole list in one page call.
 */
interface ChatDescriptor {
    id: string;
    title?: string;
    subject?: string;
    description?: string;
    participantCount?: number;
    contactName?: string;
    pushName?: string;
    verifiedName?: string;
    phoneNumber?: string;
    isMyContact?: boolean;
    isGroup?: boolean;
    isReadOnly?: boolean;
    archived?: boolean;
    timestamp?: number;
    unreadCount?: number;
}

/** Chat id servers the gateway will send to, and how the odd spellings map onto them. */
const CHAT_SERVERS = new Set(['c.us', 'g.us', 'lid', 'newsletter', 'broadcast']);

const CHAT_KIND_BY_SERVER: Record<string, ChatKind> = {
    'c.us': 'private',
    'g.us': 'group',
    lid: 'lid',
    newsletter: 'channel',
    broadcast: 'broadcast',
};


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
    /**
     * Chats already reported as unloadable, so the skip is announced once per session instead
     * of once per scan interval. Cleared on `ready`: a fresh session injects fresh page code,
     * which may well be able to model what the old one could not.
     */
    private readonly unreadableChats = new Set<string>();
    private bulkChatReadFailed = false;
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
    ): Promise<SendResult> {
        this.assertSendable(message, files);
        return this.dispatch(await this.resolveChatId(phoneNumber), message, files);
    }

    /**
     * Send to a chat addressed by its WhatsApp id rather than by phone number.
     *
     * A group has no number to resolve, so this is the only way to reach one; for a one-to-one
     * chat it also skips the `getNumberId` round trip, since an id the account already has a
     * chat for is by definition reachable.
     */
    public async sendMessageToChat(
        chatId: string,
        message?: string,
        files: MediaAttachment[] = [],
    ): Promise<SendResult> {
        this.assertSendable(message, files);
        return this.dispatch(await this.resolveTargetChatId(chatId), message, files);
    }

    private assertSendable(message: string | undefined, files: MediaAttachment[]): void {
        if (!this.isReady()) {
            throw new WhatsAppNotReadyError();
        }
        if (!message?.trim() && files.length === 0) {
            throw new MessageSendError('Either a message body or at least one file is required.');
        }
    }

    /** The send itself, once the target chat id is settled. */
    private async dispatch(
        chatId: string,
        message: string | undefined,
        files: MediaAttachment[],
    ): Promise<SendResult> {
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
     * Every chat the linked account can see, described as fully as WhatsApp will let us.
     *
     * The bulk read comes from the in-page chat models, which carry the group subject and the
     * contact record the library's own serializer drops — that is what used to leave most of
     * this listing nameless. Chats still unnamed after that get a second, per-chat pass:
     * `getChatById` forces a group-metadata fetch and `getContactById` asks for the contact
     * WhatsApp has not pushed to us yet. A chat WhatsApp will not let the library model at all
     * is reported by id under `unreadableChatIds` rather than failing the listing.
     */
    public async listChatSummaries(): Promise<ChatListResponse> {
        if (!this.isReady()) {
            throw new WhatsAppNotReadyError();
        }

        const allowlist = config.rabbitmq.chatIds;
        const forwardsEverything = allowlist.length === 0;

        const unreadableChatIds: string[] = [];
        const descriptors = await this.readChatDescriptors(unreadableChatIds);

        const chats: ChatSummaryDto[] = [];
        let enrichBudget = config.whatsapp.chatEnrichLimit;
        let notEnriched = 0;

        for (const descriptor of descriptors) {
            let enriched = descriptor;
            if (!this.isDescribed(descriptor)) {
                if (enrichBudget > 0) {
                    enrichBudget -= 1;
                    enriched = await this.enrichDescriptor(descriptor, unreadableChatIds);
                } else {
                    notEnriched += 1;
                }
            }

            chats.push(
                this.toChatSummary(enriched, forwardsEverything || allowlist.includes(enriched.id)),
            );
        }

        if (notEnriched > 0) {
            logger.warn(
                'Chat listing: hit WHATSAPP_CHAT_ENRICH_LIMIT; some chats were returned without ' +
                    'their per-chat lookup. Raise the limit to describe them.',
                {notEnriched, limit: config.whatsapp.chatEnrichLimit},
            );
        }

        chats.sort((left, right) => (right.timestamp ?? 0) - (left.timestamp ?? 0));

        const unnamedCount = chats.filter((chat) => !chat.name).length;
        if (unnamedCount > 0) {
            logger.info('Chat listing: some chats have no name WhatsApp will disclose', {
                unnamedCount,
                total: chats.length,
            });
        }

        return {
            chats,
            unreadableChatIds: [...new Set(unreadableChatIds)],
            allowlist: [...allowlist],
            unnamedCount,
        };
    }

    /**
     * Descriptors for every chat, preferring the one bulk page read and falling back to reading
     * ids and describing them one at a time when the page call will not answer.
     */
    private async readChatDescriptors(unreadableChatIds: string[]): Promise<ChatDescriptor[]> {
        try {
            return await this.listChatDescriptors();
        } catch (err) {
            logger.warn('Chat listing: bulk descriptor read failed; describing chats one by one.', {
                reason: this.summarizeError(err),
            });
        }

        const descriptors: ChatDescriptor[] = [];

        for (const chatId of await this.listChatIds()) {
            try {
                descriptors.push(await this.enrichDescriptor({id: chatId}, unreadableChatIds));
            } catch (err) {
                this.noteUnreadableChat('Chat listing', chatId, err);
                unreadableChatIds.push(chatId);
            }
        }

        return descriptors;
    }

    /**
     * Whether the descriptor already carries something worth showing a human.
     *
     * A title that is only a phone number does not count. WhatsApp fills the chat title with a
     * formatted number whenever it has no name, so treating that as described would skip the
     * very chats the per-chat lookup exists for.
     */
    private isDescribed(descriptor: ChatDescriptor): boolean {
        return [
            descriptor.title,
            descriptor.subject,
            descriptor.contactName,
            descriptor.verifiedName,
            descriptor.pushName,
        ].some((value) => Boolean(value) && !this.looksLikePhoneNumber(value as string));
    }

    /** A name WhatsApp synthesised from the number rather than one a human chose. */
    private looksLikePhoneNumber(value: string): boolean {
        return /^[+\s().\d-]+$/.test(value);
    }

    /**
     * Second pass for a chat the collection could not name. `getChatById` makes the library
     * fetch group metadata from the server, which is what fills in a subject and description
     * the account has never synced; `getContactById` does the same for a one-to-one chat.
     * Both are per-chat round trips, so only chats that need them pay for them.
     */
    private async enrichDescriptor(
        descriptor: ChatDescriptor,
        unreadableChatIds: string[],
    ): Promise<ChatDescriptor> {
        const enriched: ChatDescriptor = {...descriptor};

        try {
            const chat = await this.client.getChatById(descriptor.id);
            if (chat) {
                enriched.title ??= this.text(chat.name);
                enriched.isGroup ??= chat.isGroup;
                enriched.isReadOnly ??= chat.isReadOnly;
                enriched.archived ??= chat.archived;
                enriched.timestamp ??= chat.timestamp;
                enriched.unreadCount ??= chat.unreadCount;

                const metadata = (chat as unknown as {groupMetadata?: Record<string, unknown>})
                    .groupMetadata;
                if (metadata) {
                    enriched.isGroup = true;
                    enriched.subject ??= this.text(metadata.subject);
                    enriched.description ??= this.text(metadata.desc);
                    enriched.participantCount ??= Array.isArray(metadata.participants)
                        ? metadata.participants.length
                        : undefined;
                }
            }
        } catch (err) {
            if (this.isTransientFrameError(err)) throw err;
            // The chat is still listed — the bulk read already gave us its id and whatever else
            // it carried — but say which chats WhatsApp would not model, the way it always has.
            this.noteUnreadableChat('Chat listing', descriptor.id, err);
            unreadableChatIds.push(descriptor.id);
        }

        // Groups have no single contact behind them; a `@lid` thread does, and its contact is
        // usually the only place the number and push name are recorded.
        if (enriched.isGroup || !(descriptor.id.endsWith('@c.us') || descriptor.id.endsWith('@lid'))) {
            return enriched;
        }

        try {
            const contact = await this.client.getContactById(descriptor.id);
            if (contact) {
                enriched.contactName ??= this.text(contact.name);
                enriched.pushName ??= this.text(contact.pushname);
                enriched.verifiedName ??= this.text(contact.verifiedName);
                enriched.phoneNumber ??= this.text(contact.number);
                enriched.isMyContact ??= contact.isMyContact;
            }
        } catch (err) {
            if (this.isTransientFrameError(err)) throw err;
            logger.debug('Chat listing: could not load a contact for its name', {
                chatId: descriptor.id,
                reason: this.summarizeError(err),
            });
        }

        return enriched;
    }

    /**
     * Picks the name to show and says where it came from, so a caller can tell an unnamed chat
     * apart from one the gateway failed to read. Saved contact name first because that is what
     * the phone shows, then the group subject, then what the counterpart calls themselves, and
     * only then the bare number.
     */
    private toChatSummary(descriptor: ChatDescriptor, forwarded: boolean): ChatSummaryDto {
        const server = descriptor.id.slice(descriptor.id.lastIndexOf('@') + 1).toLowerCase();
        const kind: ChatKind = CHAT_KIND_BY_SERVER[server] ?? 'unknown';
        const user = descriptor.id.slice(0, Math.max(descriptor.id.lastIndexOf('@'), 0));

        const candidates: [ChatNameSource, string | undefined][] = [
            ['title', descriptor.title],
            ['subject', descriptor.subject],
            ['contact', descriptor.contactName],
            ['verifiedName', descriptor.verifiedName],
            ['pushname', descriptor.pushName],
            [
                'number',
                // A `@lid` thread counts here too: the linked identity hides the number in the
                // id, but once it is resolved it is the only human-readable thing we have.
                (kind === 'private' || kind === 'lid') && descriptor.phoneNumber
                    ? `+${descriptor.phoneNumber}`
                    : undefined,
            ],
        ];
        // A name a human chose wins; failing that we report the best number-shaped name we have
        // and say so, rather than passing a formatted number off as a contact name.
        const named = candidates.find(
            ([source, value]) =>
                Boolean(value) && source !== 'number' && !this.looksLikePhoneNumber(value as string),
        );
        const fallbackValue = candidates.find(([, value]) => Boolean(value))?.[1];
        const resolved: [ChatNameSource, string] | undefined =
            (named as [ChatNameSource, string] | undefined) ??
            (fallbackValue ? ['number', fallbackValue] : undefined);

        return {
            id: descriptor.id,
            name: resolved?.[1],
            displayName: resolved?.[1] || user || descriptor.id,
            nameSource: resolved?.[0] ?? 'fallback',
            kind,
            isGroup: descriptor.isGroup ?? kind === 'group',
            subject: descriptor.subject,
            description: descriptor.description,
            participantCount: descriptor.participantCount,
            phoneNumber: descriptor.phoneNumber,
            pushName: descriptor.pushName,
            verifiedName: descriptor.verifiedName,
            isMyContact: descriptor.isMyContact,
            isReadOnly: descriptor.isReadOnly,
            archived: descriptor.archived,
            timestamp: descriptor.timestamp,
            unreadCount: descriptor.unreadCount,
            forwarded,
        };
    }

    private text(value: unknown): string | undefined {
        const trimmed = typeof value === 'string' ? value.trim() : '';
        return trimmed.length > 0 ? trimmed : undefined;
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
            this.unreadableChats.clear();
            this.bulkChatReadFailed = false;
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
            const chats = await this.client.getChats();
            this.bulkChatReadFailed = false;
            return chats;
        } catch (err) {
            if (this.isTransientFrameError(err)) throw err;

            // The chat that rejects the bulk read rejects it on every pass, so say so once and
            // let the per-chat fallback get on with it.
            if (this.bulkChatReadFailed) {
                logger.debug('Reconcile: bulk chat read failed; using per-chat reads.');
            } else {
                this.bulkChatReadFailed = true;
                logger.warn(
                    'Reconcile: bulk chat read failed; falling back to per-chat reads. ' +
                        'Further passes log this at debug.',
                    {reason: this.summarizeError(err)},
                );
            }

            return this.fetchChatsById(await this.listChatIds());
        }
    }

    /**
     * A chat whatsapp-web.js cannot model — a `@lid` thread, a channel, a group shape newer
     * than the library — does not become readable on the next pass, so warning about it every
     * scan interval buries the log in a line that carries no new information. Report the id and
     * its reason once; after that the skip is a debug line.
     */
    private noteUnreadableChat(scope: string, chatId: string, err: unknown): void {
        if (this.unreadableChats.has(chatId)) {
            logger.debug(`${scope}: skipping a chat that would not load`, {chatId});
            return;
        }

        this.unreadableChats.add(chatId);
        logger.warn(
            `${scope}: skipping a chat that would not load. Further skips of this chat log at debug.`,
            {chatId, reason: this.summarizeError(err)},
        );
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
                this.noteUnreadableChat('Reconcile', chatId, err);
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

    /**
     * Describes every chat in a single page call, reading WhatsApp's own chat models directly.
     *
     * Why not `client.getChats()`: its serializer exposes only `formattedTitle`, which WhatsApp
     * leaves empty for an unsynced group and for anyone who is not in the phone's address book,
     * and one chat it cannot model rejects the whole call. Here each chat is read behind its own
     * `try`, every field is optional, and a chat that yields nothing but an id still comes back
     * as a row — so a page fault costs that chat's description, never the listing.
     */
    private async listChatDescriptors(): Promise<ChatDescriptor[]> {
        const page = this.client.pupPage;
        if (!page) {
            return [];
        }

        return page.evaluate(() => {
            type Loose = Record<string, unknown>;

            // globalThis, not window: the project compiles without the DOM lib, and inside the
            // page the two are the same object anyway.
            const load = (module: string): Loose | undefined => {
                try {
                    return (
                        globalThis as unknown as {require: (name: string) => Loose}
                    ).require(module);
                } catch {
                    return undefined;
                }
            };

            // Every read goes through here: these are WhatsApp's own getters, and one of them
            // throwing on one chat must not cost the other fields, let alone the other chats.
            const read = (get: () => unknown): unknown => {
                try {
                    return get();
                } catch {
                    return undefined;
                }
            };

            const text = (get: () => unknown): string | undefined => {
                const value = read(get);
                const trimmed = typeof value === 'string' ? value.trim() : '';
                return trimmed.length > 0 ? trimmed : undefined;
            };

            const numberOf = (get: () => unknown): number | undefined => {
                const value = read(get);
                return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
            };

            const boolOf = (get: () => unknown): boolean | undefined => {
                const value = read(get);
                return typeof value === 'boolean' ? value : undefined;
            };

            const countOf = (collection: unknown): number | undefined => {
                if (Array.isArray(collection)) return collection.length;
                const loose = collection as Loose | undefined;
                if (typeof loose?.length === 'number') return loose.length;
                const models = read(() =>
                    (loose as {getModelsArray?: () => unknown[]})?.getModelsArray?.(),
                );
                return Array.isArray(models) ? models.length : undefined;
            };

            const collections = load('WAWebCollections');
            const chatCollection = collections?.Chat as
                | {getModelsArray: () => Loose[]}
                | undefined;
            if (!chatCollection) {
                return [];
            }

            const lidUtils = load('WAWebLidMigrationUtils') as
                | {toPn?: (wid: unknown) => {user?: string} | undefined}
                | undefined;

            const digits = (value: unknown): string | undefined => {
                const trimmed = typeof value === 'string' ? value.replace(/\D/g, '') : '';
                return trimmed.length > 0 ? trimmed : undefined;
            };

            const describe = (chat: Loose): Loose | null => {
                const id = read(() => (chat?.id as Loose)?._serialized);
                if (typeof id !== 'string' || !id) {
                    return null;
                }

                const contact = read(() => chat.contact) as Loose | undefined;
                const metadata = read(() => chat.groupMetadata) as Loose | undefined;
                const newsletter = read(() => chat.newsletterMetadata) as Loose | undefined;

                // A `@lid` chat hides the number behind a linked identity; WhatsApp's own
                // migration helper is what maps it back to a phone number.
                const lidNumber = id.endsWith('@lid')
                    ? digits(read(() => lidUtils?.toPn?.(chat.id)?.user))
                    : undefined;

                return {
                    id,
                    title:
                        text(() => chat.formattedTitle) ??
                        text(() => chat.name) ??
                        text(() => (contact as Loose | undefined)?.formattedName),
                    subject:
                        text(() => metadata?.subject) ??
                        text(() => chat.subject) ??
                        text(() => newsletter?.name),
                    description:
                        text(() => metadata?.desc) ?? text(() => newsletter?.description),
                    participantCount: countOf(metadata?.participants),
                    contactName: text(() => contact?.name) ?? text(() => contact?.shortName),
                    pushName:
                        text(() => contact?.pushname) ?? text(() => contact?.notifyName),
                    verifiedName: text(() => contact?.verifiedName),
                    phoneNumber:
                        lidNumber ??
                        digits(read(() => (contact?.id as Loose | undefined)?.user)) ??
                        (id.endsWith('@c.us') ? digits(id.split('@')[0]) : undefined),
                    isMyContact: boolOf(() => contact?.isMyContact),
                    isGroup: Boolean(metadata) || id.endsWith('@g.us'),
                    isReadOnly:
                        boolOf(() => chat.isReadOnly) ?? boolOf(() => metadata?.announce),
                    archived: boolOf(() => chat.archive),
                    timestamp: numberOf(() => chat.t),
                    unreadCount: numberOf(() => chat.unreadCount),
                };
            };

            const models = read(() => chatCollection.getModelsArray());
            if (!Array.isArray(models)) {
                return [];
            }

            return models
                .map((chat) => {
                    try {
                        return describe(chat as Loose);
                    } catch {
                        return null;
                    }
                })
                .filter((descriptor): descriptor is Loose => descriptor !== null);
        }) as unknown as Promise<ChatDescriptor[]>;
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

    /**
     * Turns whatever the caller passed into a chat id WhatsApp will accept, or says why it is
     * not one. A bare number is read as a one-to-one chat and a bare `<creator>-<created>` as a
     * group, because those are the shapes people copy out of the listing without the suffix.
     */
    private normalizeChatId(rawChatId: string): string {
        const trimmed = (rawChatId ?? '').trim();
        if (!trimmed) {
            throw new InvalidChatIdError(rawChatId ?? '');
        }

        const at = trimmed.lastIndexOf('@');
        if (at < 0) {
            if (/^\d+-\d+$/.test(trimmed)) return `${trimmed}@g.us`;
            if (/^\d{5,}$/.test(trimmed)) return `${trimmed}@c.us`;
            throw new InvalidChatIdError(trimmed);
        }

        const user = trimmed.slice(0, at);
        const rawServer = trimmed.slice(at + 1).toLowerCase();
        // `s.whatsapp.net` is the same address in the protocol's own spelling; callers copying
        // ids out of other WhatsApp tooling hit it often enough to be worth accepting.
        const server = rawServer === 's.whatsapp.net' ? 'c.us' : rawServer;

        if (!user || !CHAT_SERVERS.has(server)) {
            throw new InvalidChatIdError(trimmed);
        }
        if (server !== 'broadcast' && !/^\d+(-\d+)?$/.test(user)) {
            throw new InvalidChatIdError(trimmed);
        }

        return `${user}@${server}`;
    }

    /**
     * The chat id a send should go to. An id the account already has a chat for is taken as is;
     * a one-to-one id it has never talked to is checked against WhatsApp, since sending opens
     * that chat; anything else the account cannot see is a 404, because a group you are not in
     * is not reachable by sending to it.
     */
    private async resolveTargetChatId(rawChatId: string): Promise<string> {
        const chatId = this.normalizeChatId(rawChatId);

        let knownIds: string[];
        try {
            knownIds = await this.listChatIds();
        } catch (err) {
            // The membership check is a courtesy. A page that will not answer must not block a
            // send WhatsApp would have accepted.
            logger.debug('Could not read the chat list while resolving a send target', {
                chatId,
                reason: this.summarizeError(err),
            });
            return chatId;
        }

        if (knownIds.includes(chatId)) {
            return chatId;
        }

        if (chatId.endsWith('@c.us')) {
            try {
                return await this.resolveChatId(chatId.slice(0, -'@c.us'.length));
            } catch (err) {
                if (err instanceof NumberNotFoundError) {
                    throw new ChatNotFoundError(chatId);
                }
                throw err;
            }
        }

        throw new ChatNotFoundError(chatId);
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

    /**
     * One line, no stack. Errors thrown inside the page arrive minified — the stack is ten
     * frames of puppeteer plumbing above a name like `r: r`, which tells nobody anything.
     */
    private summarizeError(err: unknown): string {
        if (err instanceof Error) {
            return err.message ? `${err.name}: ${err.message}` : err.name;
        }
        return String(err);
    }
}
