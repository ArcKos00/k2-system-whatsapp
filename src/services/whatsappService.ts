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
import {canSendInline, resolveMimetype, verifiedMimetype} from '../utils/mediaKind';
import {RabbitMqPublisher} from './rabbitMqPublisher';
import type {ChatKind, ChatListResponse, ChatNameSource, ChatSummaryDto} from '../dtos/chat.dto';
import {
    AppError,
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

/**
 * What the page says about WhatsApp's own media prep, logged once per ready session.
 *
 * `hasFilehash` is the whole question: everything downstream of the prep is keyed by that hash,
 * and a build that stops returning one takes every media send down with an error from inside
 * WhatsApp's bundle. `filledByShim` says the hash was ours, `resultKeys` describes what the
 * prep handed back when it was not, which is what a fix would have to be written against.
 */
export interface MediaPrepReport {
    shimInstalled: boolean;
    detail?: string;
    hasFilehash?: boolean;
    filledByShim?: boolean;
    resultKeys?: string[];
    blobKind?: string;
    /** Whether the hash could then be looked up the way the library does it. */
    mediaObjectResolved?: boolean;
    mediaObjectError?: string;
    probeError?: string;
    /** The image the probe prepped: its edge in pixels (0 for the built-in 8x8) and its size. */
    probePixels?: number;
    probeBytes?: number;
    /** Which identities the account still has. A send goes out under one of them. */
    meLidUser?: string;
    mePnUser?: string;
    meUserError?: string;
    /** A key WhatsApp built itself, to hold the library's one against. */
    realKey?: unknown;
    realKeyError?: string;
    /** Only when a chat id was given: whether the send path's very first call still works. */
    chatResolved?: boolean;
    chatError?: string;
    chatIsGroup?: boolean;
    chatIsLid?: boolean;
    groupMetadataLoaded?: boolean;
    groupLidAddressing?: boolean;
    /** What this build's MsgKey makes of the fields the library gives it. */
    msgKey?: Record<string, unknown>;
    msgKeyError?: string;
    /** What the prep had produced the last time it came back without a filehash. */
    lastPrepFailure?: Record<string, unknown>;
    /** The last few calls the send made after the prep, and which of them threw. */
    mediaTrace?: Record<string, unknown>[];
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

/**
 * How a failure of WhatsApp's own in-page media prep reads by the time it reaches us.
 *
 * The prep decodes and re-encodes the file inside the page. When it yields nothing the library
 * passes the missing filehash straight into a memoized in-page getter, so what surfaces is
 * WhatsApp's minified complaint about an id property rather than anything about the file. Its
 * own guard for the same case (`media-fault: ... filehash undefined`) sits one statement too
 * late to ever run, so both spellings are matched here.
 */
const MEDIA_PREP_FAILURE =
    /must include an id property|media-fault|filehash undefined|upload failed: media entry was not created/i;

/**
 * An 8x8 baseline JPEG, used to ask the page whether media prep still works at all without
 * sending anything to anyone.
 */
const PROBE_JPEG_BASE64 =
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIs' +
    'IxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAAIAAgBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcI' +
    'CQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcY' +
    'GRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKj' +
    'pKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APn+' +
    'iiiv/9k=';

const CHROMIUM_LOCK_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

const PUPPETEER_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-zygote',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--mute-audio',
];

/**
 * The browser flags, with the renderer's heap ceiling only when one is configured.
 *
 * That ceiling is not just about idling memory: the renderer is where WhatsApp Web decodes and
 * re-encodes an outgoing photo, and a heap too small for that makes the prep give up quietly —
 * it resolves without a filehash instead of throwing, and the send dies further down inside
 * WhatsApp's own bundle. `WHATSAPP_RENDERER_HEAP_MB=0` removes the ceiling.
 */
const puppeteerArgs = (): string[] => {
    const heapMb = config.whatsapp.rendererHeapMb;
    return heapMb > 0 ? [...PUPPETEER_ARGS, `--js-flags=--max-old-space-size=${heapMb}`] : PUPPETEER_ARGS;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** How many bytes a base64 payload holds, without decoding it. */
const base64ByteLength = (data: string): number => {
    const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
};

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
    private readonly webVersionCachePath: string;

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
        this.webVersionCachePath =
            config.whatsapp.webVersionCachePath ?? join(config.whatsapp.sessionPath, 'web-versions');

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
        await this.ensurePinnedBuild();
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

    /**
     * The send itself, once the target chat id is settled.
     *
     * When files are attached the text travels as the caption of the first one, so the
     * recipient sees a single message rather than a text bubble followed by the file; any
     * further files go out on their own. Text without files is sent as a plain message.
     *
     * A photo, video or audio file is sent as inline media first, so it shows up as a real
     * picture or player in the chat. Only when WhatsApp refuses it that way — an image too
     * large to preview, a codec it cannot transcode — is the same file re-sent as a document,
     * which WhatsApp accepts for anything. Every other file type is a document from the start.
     */
    private async dispatch(
        chatId: string,
        message: string | undefined,
        files: MediaAttachment[],
    ): Promise<SendResult> {
        let sentMessages = 0;
        const text = message?.trim() ? message : undefined;

        try {
            if (text && files.length === 0) {
                await this.throttle();
                await this.client.sendMessage(chatId, text);
                sentMessages += 1;
            }

            for (const [index, file] of files.entries()) {
                const media = this.toMessageMedia(file);
                const caption = index === 0 ? text : undefined;
                await this.throttle();
                await this.sendMedia(chatId, media, caption);
                sentMessages += 1;
            }
        } catch (err) {
            // An AppError already carries the status and the explanation; wrapping it again
            // would bury both under a second "Failed to send WhatsApp message:".
            if (err instanceof AppError) throw err;
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
        const puppeteer: LaunchOptions = {headless: true, args: puppeteerArgs()};

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
            // Read from disk, never over the network. The library's own remote cache fetches the
            // build from inside the pod and, when that fetch fails, returns null and lets the
            // session load whatever WhatsApp serves — the pin then shows up in the log as applied
            // while the page says otherwise. `ensurePinnedBuild` does the fetching, once, where a
            // failure can be reported.
            options.webVersionCache = {
                type: 'local',
                path: this.webVersionCachePath,
            };
            logger.info('Pinning WhatsApp Web version', {version, from: this.webVersionCachePath});
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
            void this.inspectMediaPrep();
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
     * Put the pinned build's HTML where the library will find it, and say so either way.
     *
     * A pin is only honoured if the file is there when the session starts: the library falls
     * back to the live build without raising anything, so an unreachable archive looks exactly
     * like a working pin until the "version in use" line says a different number. Fetching it
     * here makes that failure loud, and keeping the file on the session volume means the pin
     * holds through restarts even from a cluster with no way out to the archive — where the file
     * can simply be dropped in by hand.
     */
    private async ensurePinnedBuild(): Promise<void> {
        const version = config.whatsapp.webVersion;
        if (!version) return;

        const file = join(this.webVersionCachePath, `${version}.html`);
        try {
            const cached = await readFile(file, 'utf-8');
            if (cached.length > 0) {
                logger.info('Pinned WhatsApp Web build is already on disk', {
                    version,
                    file,
                    bytes: cached.length,
                });
                return;
            }
        } catch {
            // Not cached yet — fetch it below.
        }

        const url =
            config.whatsapp.webVersionRemotePath ??
            `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${version}.html`;
        try {
            const response = await fetch(url, {
                signal: AbortSignal.timeout(config.whatsapp.webVersionFetchTimeoutMs),
            });
            if (!response.ok) {
                throw new Error(`${url} returned ${response.status}`);
            }
            const html = await response.text();
            // The archive answers 200 with a "404: Not Found" page for a version it does not
            // have, and a few bytes of that would pin the session to nothing.
            if (html.length < 10000) {
                throw new Error(`${url} returned ${html.length} bytes, which is not a build`);
            }
            await mkdir(this.webVersionCachePath, {recursive: true});
            await writeFile(file, html, 'utf-8');
            logger.info('Pinned WhatsApp Web build downloaded', {version, file, bytes: html.length});
        } catch (err) {
            logger.error(
                'Pinned WhatsApp Web build could not be fetched; the session will load whatever ' +
                    'WhatsApp serves. Put the file on the session volume by hand to pin it anyway.',
                {version, url, file, reason: this.summarizeError(err)},
            );
        }
    }

    /**
     * Records which WhatsApp Web build the session actually loaded. The injected helpers talk
     * to that build's internals, so when they start throwing this line says what to pin
     * WHATSAPP_WEB_VERSION to (or which build broke).
     */
    private async logWebVersion(): Promise<void> {
        try {
            const version = await this.client.getWWebVersion();
            const pinned = config.whatsapp.webVersion ?? null;
            // A pin that did not take is the quietest failure here: the session runs on a build
            // nobody chose, and everything downstream is explained by the wrong thing.
            if (pinned && version !== pinned) {
                logger.error('WhatsApp Web build is NOT the pinned one; the pin did not take', {
                    version,
                    pinned,
                });
                return;
            }
            logger.info('WhatsApp Web version in use', {version, pinned});
        } catch (err) {
            logger.warn('Could not read the WhatsApp Web version', err);
        }
    }

    /**
     * Repair WhatsApp's media prep if this build has stopped filling in the filehash, and say
     * in the log whether it works.
     *
     * whatsapp-web.js prepares every attachment through WhatsApp's own `prepRawMedia`, then
     * looks the result's `filehash` up in a memoized page store. On a build that no longer
     * returns that hash the lookup gets `undefined` and every single media send dies inside
     * WhatsApp's minified bundle ("Data passed to getter must include an id property"), whatever
     * the file is — the library's version is the newest published one, so there is no upgrade to
     * wait for. The hash is a plain SHA-256 of the bytes that are about to be uploaded, so when
     * the prep omits it we compute it ourselves and the rest of the send proceeds untouched.
     *
     * The probe that follows sends nothing: it preps an 8x8 JPEG and reports what came back, so
     * one log line per session says whether prep is healthy, whether our hash rescued it, or —
     * when neither holds — what shape the prep now returns.
     */
    public async inspectMediaPrep(chatId?: string, pixels?: number): Promise<MediaPrepReport> {
        const page = this.client.pupPage;
        if (!page) {
            return {shimInstalled: false, detail: 'the browser page is not open'};
        }

        try {
            const report = await page.evaluate(
                async (probeJpegBase64: string, probeChatId: string, probePixels: number) => {
                    type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
                    const scope = globalThis as unknown as Loose;
                    const report: Loose = {shimInstalled: false};

                    const load = (name: string): Loose | undefined => {
                        try {
                            return scope.require(name);
                        } catch {
                            return undefined;
                        }
                    };

                    const sha256Base64 = async (bytes: ArrayBuffer): Promise<string> => {
                        const digest = await scope.crypto.subtle.digest('SHA-256', bytes);
                        return scope.btoa(String.fromCharCode(...new Uint8Array(digest)));
                    };

                    // The prepared blob is what gets uploaded, so it — not the file we handed in —
                    // is what the hash has to describe. Which of these shapes holds the bytes
                    // depends on the build, so every one is tried.
                    const bytesOf = async (candidate: Loose | undefined): Promise<ArrayBuffer | undefined> => {
                        if (!candidate) return undefined;
                        const attempts = [
                            async () => candidate.arrayBuffer?.(),
                            async () => (await candidate.forceToBlob?.())?.arrayBuffer?.(),
                            async () => candidate._blob?.arrayBuffer?.(),
                        ];
                        for (const attempt of attempts) {
                            try {
                                const buffer = await attempt();
                                if (buffer?.byteLength > 0) return buffer;
                            } catch {
                                // Next shape.
                            }
                        }
                        return undefined;
                    };

                    // ---- a trace over everything the send does after the prep ----
                    // The prep is provably healthy, so the memoized getter that throws may well
                    // be one of the steps behind it. Each is wrapped by hand rather than through
                    // injectToFunction, whose fallback would call a failing upload a second time.
                    if (!scope.__k2MediaTraceInstalled) {
                        const record = (entry: Loose): void => {
                            const trail: Loose[] = (scope.__k2MediaTrace ??= []);
                            trail.push({at: new Date().toISOString(), ...entry});
                            if (trail.length > 20) trail.shift();
                        };

                        const wrap = (
                            moduleName: string,
                            fnName: string,
                            describe: (args: Loose[]) => Loose,
                        ): void => {
                            const target = moduleName ? load(moduleName) : (scope.WWebJS as Loose);
                            const original = target?.[fnName];
                            if (typeof original !== 'function') {
                                record({step: fnName, missing: moduleName || 'WWebJS'});
                                return;
                            }
                            (target as Loose)[fnName] = function (this: unknown, ...args: Loose[]) {
                                const info = describe(args);
                                const failed = (err: Loose): void =>
                                    record({step: fnName, ...info, ok: false, error: String(err?.message ?? err)});
                                try {
                                    const result = original.apply(this, args);
                                    if (typeof result?.then === 'function') {
                                        return result.then(
                                            (value: unknown) => {
                                                record({step: fnName, ...info, ok: true});
                                                return value;
                                            },
                                            (err: Loose) => {
                                                failed(err);
                                                throw err;
                                            },
                                        );
                                    }

                                    // Some of these hand back an array of promises rather than a
                                    // promise, and returning them settled is not ours to do — so
                                    // they are watched from the side. The observer swallows the
                                    // rejection it sees, which is the caller's to handle, not a
                                    // second unhandled one.
                                    const pending: Loose[] = Array.isArray(result)
                                        ? result.filter((entry) => typeof entry?.then === 'function')
                                        : [];
                                    if (pending.length > 0) {
                                        record({step: fnName, ...info, ok: 'pending'});
                                        pending.forEach((promise, index) => {
                                            promise.then(
                                                () => record({step: `${fnName}[${index}]`, ok: true}),
                                                (err: Loose) =>
                                                    record({
                                                        step: `${fnName}[${index}]`,
                                                        ...info,
                                                        ok: false,
                                                        error: String(err?.message ?? err),
                                                        stack: String(err?.stack ?? '').slice(0, 900),
                                                    }),
                                            );
                                        });
                                        return result;
                                    }

                                    record({step: fnName, ...info, ok: true});
                                    return result;
                                } catch (err) {
                                    failed(err as Loose);
                                    throw err;
                                }
                            };
                        };

                        wrap('', 'processMediaData', ([mediaInfo, options]) => ({
                            mimetype: mediaInfo?.mimetype,
                            asDocument: Boolean(options?.forceDocument),
                        }));
                        wrap('WAWebMediaStorage', 'getOrCreateMediaObject', (args) => {
                            const filehash: unknown = args[0];
                            return {
                                filehash:
                                    typeof filehash === 'string'
                                        ? `${filehash.slice(0, 10)}... (${filehash.length} chars)`
                                        : String(filehash),
                            };
                        });
                        wrap('WAWebMmsMediaTypes', 'msgToMediaType', ([msg]) => ({
                            msgType: String(msg?.type),
                            isGif: Boolean(msg?.isGif),
                        }));
                        wrap('WAWebMediaMmsV4Upload', 'uploadMedia', ([data]) => ({
                            mediaType: String(data?.mediaType),
                            mimetype: String(data?.mimetype),
                            hasMediaObject: Boolean(data?.mediaObject),
                        }));

                        // The call the message is actually handed to. Everything before it now
                        // reports ok, so this is where the failure has to be — and the identities
                        // it carries are the ones the library had to guess at.
                        const widOf = (value: Loose): string =>
                            String(value?._serialized ?? value?.user ?? value ?? 'undefined');
                        wrap('WAWebSendMsgChatAction', 'addAndSendMsgToChat', ([chat, message]) => {
                            // The participant lives on the message key, never on the message —
                            // reading it off the message was always going to say "undefined".
                            // In a group it is what identifies us among the members, and the
                            // library only fills it in when it recognises the chat as a group.
                            const key = message?.id as Loose | undefined;
                            const isGroup = widOf(message?.to).endsWith('@g.us');
                            let repaired = false;
                            if (isGroup && key && !key.participant && message?.from) {
                                try {
                                    key.participant = load('WAWebWidFactory')?.asUserWidOrThrow(message.from);
                                    repaired = Boolean(key.participant);
                                } catch {
                                    // Leave it as it was; the trace still says it was missing.
                                }
                            }
                            return {
                                from: widOf(message?.from),
                                to: widOf(message?.to),
                                keyParticipant: widOf(key?.participant),
                                keyFrom: widOf(key?.from),
                                participantRepaired: repaired,
                                chatIsGroup:
                                    typeof chat?.id?.isGroup === 'function'
                                        ? chat.id.isGroup()
                                        : 'isGroup is not a function',
                                chatIsLid:
                                    typeof chat?.id?.isLid === 'function'
                                        ? chat.id.isLid()
                                        : 'isLid is not a function',
                                msgType: String(message?.type),
                            };
                        });

                        // MsgKey in this build keeps its serialized form behind toString() and has
                        // no _serialized at all — a key WhatsApp builds itself has none either. The
                        // library reads that field in thirty-odd places, so every one of them gets
                        // undefined: the id of a forwarded message, the lookup that closes a send.
                        // Giving the class the property back, pointing at its own toString, fixes
                        // all of them at once and changes nothing for WhatsApp's own code.
                        if (!scope.__k2MsgKeySerialized) {
                            const MsgKey = load('WAWebMsgKey') as Loose | undefined;
                            const proto = (MsgKey as Loose)?.prototype;
                            if (proto && !('_serialized' in proto) && typeof proto.toString === 'function') {
                                Object.defineProperty(proto, '_serialized', {
                                    get(this: Loose) {
                                        return this.toString();
                                    },
                                    configurable: true,
                                });
                                scope.__k2MsgKeySerialized = true;
                                record({step: 'MsgKey._serialized restored'});
                            }
                        }

                        // An entry for the install itself, so an empty trail and an old build
                        // cannot be mistaken for each other: no field at all means the page is
                        // not running this code, while just this line means nothing has been
                        // sent since it loaded.
                        record({step: 'trace installed'});
                        scope.__k2MediaTraceInstalled = true;
                    }

                    const wwebjs = scope.WWebJS as Loose | undefined;
                    if (scope.__k2MediaPrepShim) {
                        report.shimInstalled = true;
                        report.detail = 'already installed';
                    } else if (typeof wwebjs?.injectToFunction !== 'function') {
                        report.detail = 'WWebJS.injectToFunction is unavailable';
                    } else {
                        wwebjs.injectToFunction(
                            {module: 'WAWebPrepRawMedia', function: 'prepRawMedia'},
                            (module: Loose, original: Loose, ...args: unknown[]) => {
                                const prep = (original as (...a: unknown[]) => Loose).apply(module, args);
                                const waitForPrep = prep?.waitForPrep;
                                if (typeof waitForPrep !== 'function') return prep;

                                prep.waitForPrep = async (...waitArgs: unknown[]) => {
                                    const mediaData = await waitForPrep.apply(prep, waitArgs);
                                    if (!mediaData || mediaData.filehash) return mediaData;

                                    // The input is only worth hashing when the prep was not asked to
                                    // transcode: for a photo or a video the bytes that go up are the
                                    // prepared ones, and a hash of anything else would travel with the
                                    // message and not match what the recipient downloads.
                                    const untouched = Boolean((args[1] as Loose | undefined)?.asDocument);
                                    const bytes =
                                        (await bytesOf(mediaData.mediaBlob)) ??
                                        (untouched ? await bytesOf(args[0] as Loose) : undefined);
                                    if (bytes) {
                                        mediaData.filehash = await sha256Base64(bytes);
                                        scope.__k2MediaPrepShimHits = (scope.__k2MediaPrepShimHits ?? 0) + 1;
                                    }

                                    // How far the prep actually got. A stage short of the end, or a
                                    // missing blob, says it gave up on the image rather than on the
                                    // hash — which is what tells a starved renderer apart from a
                                    // build that simply stopped returning the field.
                                    scope.__k2LastPrepFailure = {
                                        at: new Date().toISOString(),
                                        asDocument: untouched,
                                        filledByShim: Boolean(bytes),
                                        mediaStage: mediaData.mediaStage,
                                        type: mediaData.type,
                                        mimetype: mediaData.mimetype,
                                        fullWidth: mediaData.fullWidth,
                                        fullHeight: mediaData.fullHeight,
                                        blobKind: mediaData.mediaBlob?.constructor?.name,
                                        blobSize: mediaData.mediaBlob?.size,
                                        hasPreview: Boolean(mediaData.preview),
                                        keys: Object.keys(mediaData).slice(0, 40),
                                    };
                                    return mediaData;
                                };
                                return prep;
                            },
                        );
                        scope.__k2MediaPrepShim = true;
                        report.shimInstalled = true;
                    }

                    try {
                        const OpaqueData = load('WAWebMediaOpaqueData');
                        const prepModule = load('WAWebPrepRawMedia');
                        if (!OpaqueData || typeof prepModule?.prepRawMedia !== 'function') {
                            report.probeError = 'the media prep modules are not loaded in this build';
                            return report;
                        }

                        // The built-in 8x8 proves the plumbing; a generated full-size photo is what
                        // exercises the decode-and-re-encode step a real send goes through, and it is
                        // the only way to reproduce a size-dependent failure without sending anything.
                        let file: Loose;
                        if (probePixels > 0) {
                            const canvas = scope.document.createElement('canvas');
                            canvas.width = probePixels;
                            canvas.height = probePixels;
                            const context = canvas.getContext('2d');
                            // Noise, not a flat fill: a uniform image compresses to almost nothing and
                            // would not weigh anything like the photo it stands in for.
                            for (let y = 0; y < probePixels; y += 8) {
                                for (let x = 0; x < probePixels; x += 8) {
                                    context.fillStyle = `rgb(${(x * 7) % 256},${(y * 13) % 256},${(x + y) % 256})`;
                                    context.fillRect(x, y, 8, 8);
                                }
                            }
                            const blob = await new Promise((resolve) =>
                                canvas.toBlob(resolve, 'image/jpeg', 0.85),
                            );
                            if (!blob) {
                                report.probeError = `the renderer could not encode a ${probePixels}px JPEG`;
                                return report;
                            }
                            file = new scope.File([blob], `probe-${probePixels}.jpeg`, {type: 'image/jpeg'});
                        } else {
                            const binary = scope.atob(probeJpegBase64);
                            const bytes = new Uint8Array(binary.length);
                            for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
                            file = new scope.File([bytes], 'probe.jpeg', {type: 'image/jpeg'});
                        }
                        report.probePixels = probePixels;
                        report.probeBytes = file.size;

                        const hitsBefore = scope.__k2MediaPrepShimHits ?? 0;
                        const opaque = await OpaqueData.createFromData(file, 'image/jpeg');
                        const mediaData = await prepModule.prepRawMedia(opaque, {}).waitForPrep();

                        report.hasFilehash = Boolean(mediaData?.filehash);
                        report.filledByShim = (scope.__k2MediaPrepShimHits ?? 0) > hitsBefore;
                        report.resultKeys = mediaData ? Object.keys(mediaData).slice(0, 40) : [];
                        report.blobKind = mediaData?.mediaBlob?.constructor?.name;

                        // The step the send actually dies on: the hash goes into a memoized page
                        // store, and it is that store — not the prep — that throws about an id
                        // property. Running it here says which of the two is the broken one.
                        try {
                            const storage = load('WAWebMediaStorage');
                            const mediaObject = storage?.getOrCreateMediaObject(mediaData?.filehash);
                            report.mediaObjectResolved = Boolean(mediaObject);
                        } catch (err) {
                            report.mediaObjectResolved = false;
                            report.mediaObjectError = err instanceof Error ? err.message : String(err);
                        }
                    } catch (err) {
                        report.probeError = err instanceof Error ? err.message : String(err);
                    }

                    // Every send, with a file or without, resolves the chat first. If this is what
                    // throws, the media path was never the problem.
                    if (probeChatId) {
                        try {
                            const chat = await (scope.WWebJS as Loose).getChat(probeChatId, {getAsModel: false});
                            report.chatResolved = Boolean(chat);
                            report.chatIsGroup = Boolean(chat?.id?.isGroup?.());
                            report.chatIsLid = Boolean(chat?.id?.isLid?.());
                            // The one field that decides which identity a group send goes out
                            // under. Absent metadata is not the same as "not LID": it makes the
                            // library fall back to the phone-number identity either way.
                            report.groupMetadataLoaded = Boolean(chat?.groupMetadata);
                            report.groupLidAddressing = Boolean(chat?.groupMetadata?.isLidAddressingMode);
                        } catch (err) {
                            report.chatResolved = false;
                            report.chatError = err instanceof Error ? err.message : String(err);
                        }
                    }

                    report.lastPrepFailure = scope.__k2LastPrepFailure;
                    report.mediaTrace = scope.__k2MediaTrace;
                    return report;
                },
                PROBE_JPEG_BASE64,
                chatId ?? '',
                pixels ?? 0,
            );

            // The same reading the failure log carries, so a question answered in one place is
            // never missing from the other.
            const details = Object.assign(report as MediaPrepReport, await this.readSendIdentities(chatId ?? ''));
            if (details.hasFilehash && details.mediaObjectResolved && !details.filledByShim) {
                logger.info('WhatsApp media prep is healthy', details);
            } else if (details.hasFilehash && details.mediaObjectResolved) {
                logger.warn('WhatsApp media prep no longer returns a filehash; ours is filling in', details);
            } else {
                logger.error('WhatsApp media prep is broken and could not be repaired', details);
            }
            return details;
        } catch (err) {
            logger.warn('Could not inspect WhatsApp media prep', err);
            return {
                shimInstalled: false,
                detail: err instanceof Error ? err.message : String(err),
            };
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

    /**
     * One attachment, inline if WhatsApp can show it that way, as a document otherwise.
     *
     * The inline attempt is the one that can fail on the file itself rather than on the
     * connection: WhatsApp Web validates and transcodes photos and videos before upload, and
     * rejects what it cannot handle. A document upload skips all of that, so it is the safe
     * second try. Connection-level failures are not retried here — the caller already turns
     * them into a reconnect.
     */
    private async sendMedia(chatId: string, media: MessageMedia, caption: string | undefined): Promise<void> {
        const options = caption ? {caption} : {};
        if (!canSendInline(media.mimetype)) {
            await this.sendAsDocument(chatId, media, options);
            return;
        }

        try {
            await this.client.sendMessage(chatId, media, options);
        } catch (err) {
            if (this.isTransientFrameError(err)) throw err;
            logger.warn('Inline media rejected, re-sending as document', {
                chatId,
                filename: media.filename,
                mimetype: media.mimetype,
                size: media.filesize,
                reason: err instanceof Error ? err.message : String(err),
            });
            await this.sendAsDocument(chatId, media, options);
        }
    }

    private async sendAsDocument(chatId: string, media: MessageMedia, options: {caption?: string}): Promise<void> {
        try {
            await this.client.sendMessage(chatId, media, {...options, sendMediaAsDocument: true});
        } catch (err) {
            await this.logPrepSnapshot(chatId, media);
            throw this.asMediaFailure(err, media);
        }
    }

    /**
     * How far WhatsApp's prep had got on the file that just failed.
     *
     * The error the send throws comes from a minified bundle and names nothing, while the prep
     * leaves behind the half-finished model it gave up on. That model is the difference between
     * "this build stopped returning the field" and "the renderer ran out of room on a full-size
     * photo", so it is worth one page call on a failure.
     */
    private async logPrepSnapshot(chatId: string, media: MessageMedia): Promise<void> {
        const page = this.client.pupPage;
        if (!page) return;
        try {
            const {snapshot, trace} = await page.evaluate(() => {
                const scope = globalThis as unknown as Record<string, unknown>;
                return {snapshot: scope.__k2LastPrepFailure, trace: scope.__k2MediaTrace};
            });
            logger.error('WhatsApp send identities', await this.readSendIdentities(chatId));
            logger.error('WhatsApp media send failed; page trace follows', {
                filename: media.filename,
                size: media.filesize,
                trace,
            });
            if (snapshot) {
                logger.error('WhatsApp media prep gave up on this file', {
                    filename: media.filename,
                    mimetype: media.mimetype,
                    size: media.filesize,
                    // Both ends of the file, because they answer different questions: the head
                    // says what format these bytes really are, and a JPEG that does not end in
                    // ffd9 was cut off before it was fully written.
                    head: this.hexEdge(media.data, 'head'),
                    tail: this.hexEdge(media.data, 'tail'),
                    snapshot,
                });
            }
        } catch (err) {
            logger.warn('Could not read the media prep snapshot', err);
        }
    }

    /**
     * Who the account is, and what this build's MsgKey makes of the fields the library feeds it.
     *
     * The trace says the send fails on a key whose `from` is undefined while everything going in
     * was right, and that only a probe by hand would have shown. Running it on the failure itself
     * puts the answer in the same log as the failure, instead of behind a call someone has to
     * remember to make.
     */
    private async readSendIdentities(chatId: string): Promise<Record<string, unknown>> {
        const page = this.client.pupPage;
        if (!page) return {detail: 'the browser page is not open'};
        try {
            return await page.evaluate(async (probeChatId: string) => {
                type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
                const scope = globalThis as unknown as Loose;
                const load = (name: string): Loose | undefined => {
                    try {
                        return scope.require(name);
                    } catch {
                        return undefined;
                    }
                };
                const widText = (value: Loose): string =>
                    String(value?._serialized ?? value?.user ?? value ?? 'undefined');

                const out: Loose = {};
                const meUsers = load('WAWebUserPrefsMeUser');
                out.meLidUser = widText(meUsers?.getMaybeMeLidUser?.());
                out.mePnUser = widText(meUsers?.getMaybeMePnUser?.());

                try {
                    const MsgKey = load('WAWebMsgKey') as unknown as {
                        new (fields: Loose): Loose;
                        newId(): Promise<string>;
                    };
                    const widFactory = load('WAWebWidFactory');
                    const from = meUsers?.getMaybeMeLidUser?.() ?? meUsers?.getMaybeMePnUser?.();
                    const key = new MsgKey({
                        from,
                        to: probeChatId ? widFactory?.createWid(probeChatId) : undefined,
                        id: await MsgKey.newId(),
                        participant: from,
                        selfDir: 'out',
                    });
                    out.msgKey = {
                        from: widText(key.from),
                        to: widText(key.to),
                        remote: widText(key.remote),
                        participant: widText(key.participant),
                        fromMe: key.fromMe,
                        selfDir: String(key.selfDir),
                        serialized: String(key._serialized),
                        ownKeys: Object.keys(key).slice(0, 30),
                    };
                } catch (err) {
                    out.msgKeyError = err instanceof Error ? err.message : String(err);
                }

                // A key WhatsApp built itself, for comparison. Incoming messages arrive fine, so
                // the chat holds well-formed keys — and what the class offers is on its prototype,
                // where a renamed or dropped member shows up plainly instead of as `undefined`.
                try {
                    let messages: Loose[] = [];
                    if (probeChatId) {
                        const chat = await (scope.WWebJS as Loose).getChat(probeChatId, {getAsModel: false});
                        messages = chat?.msgs?.getModelsArray?.() ?? [];
                    }
                    // A chat model can be loaded with none of its messages in memory. The global
                    // collection holds whatever the session has seen, and any key WhatsApp built
                    // answers the question just as well.
                    if (messages.length === 0) {
                        messages = load('WAWebCollections')?.Msg?.getModelsArray?.() ?? [];
                    }
                    // Ours is an outgoing key, and the newest message is usually someone else's.
                    // An outgoing one is the like-for-like comparison.
                    const outgoing = messages.filter((message) => message?.id?.fromMe);
                    const real = (outgoing[outgoing.length - 1] ?? messages[messages.length - 1])?.id;
                    out.realKey = real
                        ? {
                              ownKeys: Object.keys(real),
                              members: Object.getOwnPropertyNames(Object.getPrototypeOf(real)).slice(0, 40),
                              serialized: String(real._serialized),
                              stringified: String(real),
                              from: widText(real.from),
                              remote: widText(real.remote),
                              participant: widText(real.participant),
                              fromMe: real.fromMe,
                          }
                        : 'no messages loaded in this chat';
                } catch (err) {
                    out.realKeyError = err instanceof Error ? err.message : String(err);
                }
                return out;
            }, chatId);
        } catch (err) {
            return {detail: err instanceof Error ? err.message : String(err)};
        }
    }

    /** The first or last 16 bytes of base64 data, in hex. */
    private hexEdge(data: string, end: 'head' | 'tail'): string {
        // Base64 decodes in 4-character groups, so both slices have to sit on that grid.
        const slice = end === 'head' ? data.slice(0, 24) : data.slice(Math.max(0, data.length - 24));
        try {
            return Buffer.from(slice, 'base64').toString('hex');
        } catch {
            return '<unreadable>';
        }
    }

    /**
     * The document attempt is the last one, so its failure is where the send gets explained.
     *
     * A prep failure is not the caller's fault: the empty and the mislabelled files are already
     * turned away in `toMessageMedia`, so what reaches here is a file WhatsApp's own prep would
     * not hash — which on a drifted build is every file. That makes it a gateway fault (502),
     * not a bad attachment: a 4xx would have the uploader drop the media and move on, and the
     * whole feed would go quiet while every send failed. The message names the prep and the
     * session log line that says whether the build is the reason.
     */
    private asMediaFailure(err: unknown, media: MessageMedia): unknown {
        if (this.isTransientFrameError(err)) return err;
        const detail = err instanceof Error ? err.message : String(err);
        if (!MEDIA_PREP_FAILURE.test(detail)) return err;
        return new MessageSendError(
            `WhatsApp Web's media prep gave up on '${media.filename ?? 'attachment'}' ` +
            `(${media.mimetype}, ${media.filesize ?? 'unknown'} bytes), so the upload had no filehash to ` +
            `key on. GET /health/media-prep says which step is at fault: if a small image passes and ` +
            `?pixels=2048 does not, the renderer is out of room (WHATSAPP_RENDERER_HEAP_MB); if even a ` +
            `small one fails, the WhatsApp Web build has moved past the library and wants pinning. ` +
            `Underlying failure: ${detail}`,
        );
    }

    /**
     * Wrap an attachment for the library, with a mimetype and a size we can trust.
     *
     * WhatsApp Web decodes a photo or a video in the page before uploading it, and a file that
     * cannot survive that — no content at all, or bytes that are not the format its name claims
     * — does not come back as a refusal but takes the send down inside WhatsApp's own bundle.
     * So the content is checked here, while the file can still be named in the error, and the
     * bytes are given the final say over what the caller declared.
     */
    private toMessageMedia(file: MediaAttachment): MessageMedia {
        const media = this.readAttachment(file);
        const size = base64ByteLength(media.data);
        if (size === 0) {
            throw new BadAttachmentError(`'${media.filename ?? 'attachment'}' has no content (0 bytes)`);
        }

        // Only the head is decoded: enough for every magic number, and a video stays out of memory.
        const head = Buffer.from(media.data.slice(0, 96), 'base64');
        const {mimetype, declaredMimetype, mismatched} = verifiedMimetype(media.mimetype, media.filename, head);
        if (mismatched) {
            logger.warn('Attachment content does not match its declared type; trusting the content', {
                filename: media.filename,
                declaredMimetype,
                mimetype,
                size,
            });
        }
        media.mimetype = mimetype;
        media.filesize = size;
        return media;
    }

    /**
     * The attachment as the library wants it, under the mimetype the caller vouched for. A
     * caller that sends `application/octet-stream` for a JPEG would otherwise get a document
     * card instead of a photo; the file extension usually knows better, so it gets the final
     * say over a generic type.
     */
    private readAttachment(file: MediaAttachment): MessageMedia {
        if (file.path) {
            const media = MessageMedia.fromFilePath(file.path);
            media.mimetype = resolveMimetype(file.mimetype ?? media.mimetype, file.filename ?? media.filename);
            if (file.filename) media.filename = file.filename;
            return media;
        }
        if (file.buffer) {
            if (!file.mimetype || !file.filename) {
                throw new BadAttachmentError('buffer attachments require mimetype and filename');
            }
            return new MessageMedia(
                resolveMimetype(file.mimetype, file.filename),
                file.buffer.toString('base64'),
                file.filename,
            );
        }
        if (file.base64) {
            if (!file.mimetype || !file.filename) {
                throw new BadAttachmentError('base64 attachments require mimetype and filename');
            }
            return new MessageMedia(resolveMimetype(file.mimetype, file.filename), file.base64, file.filename);
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
