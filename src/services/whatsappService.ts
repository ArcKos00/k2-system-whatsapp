import { Client, LocalAuth, MessageMedia } from 'whatsapp-web.js';
import type { ChromeReleaseChannel, LaunchOptions } from 'puppeteer';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { singleton } from 'tsyringe';
import { config } from '../config/env';
import { logger } from '../utils/logger';
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
  /** Latest QR string while awaiting login; null once authenticated. */
  private currentQr: string | null = null;
  /** Where the scannable QR PNG is written while awaiting login. */
  private readonly qrImagePath: string;

  constructor() {
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

    this.client = new Client({
      authStrategy: new LocalAuth({
        clientId: config.whatsapp.clientId,
        dataPath: config.whatsapp.sessionPath,
      }),
      puppeteer: puppeteerOptions,
    });
  }

  /** Wire up event handlers and start the underlying browser/session. */
  public async initClient(): Promise<void> {
    this.registerEventHandlers();
    logger.info('Initializing WhatsApp client...', { clientId: config.whatsapp.clientId });
    await this.client.initialize();
  }

  public getStatus(): WhatsAppStatus {
    return this.status;
  }

  public isReady(): boolean {
    return this.status === 'ready';
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
      throw new MessageSendError(err instanceof Error ? err.message : String(err));
    }

    logger.info('Message dispatched', { chatId, sentMessages });
    return { success: true, chatId, sentMessages };
  }

  // --- internals -----------------------------------------------------------

  private registerEventHandlers(): void {
    this.client.on('qr', (qr) => {
      this.status = 'qr';
      this.currentQr = qr;
      logger.warn('WhatsApp session not found — scan the QR (GET /qr) to log in.');
      // Terminal rendering is aspect-ratio dependent (often stretched in log
      // viewers), so the PNG (file + /qr endpoint) is the reliable version.
      qrcodeTerminal.generate(qr, { small: true });
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
  }

  /** Current login QR as a square PNG buffer, or null when none is pending. */
  public async getQrPng(): Promise<Buffer | null> {
    if (!this.currentQr) {
      return null;
    }
    return QRCode.toBuffer(this.currentQr, { type: 'png', width: 512, margin: 2 });
  }

  /** Render the QR to a square PNG on disk and log where to find it. */
  private async saveQrImage(qr: string): Promise<void> {
    try {
      await mkdir(dirname(this.qrImagePath), { recursive: true });
      await QRCode.toFile(this.qrImagePath, qr, { width: 512, margin: 2 });
      logger.info(`QR code image written (open and scan): ${this.qrImagePath}`);
    } catch (err) {
      logger.warn('Failed to write QR image file', err);
    }
  }

  private async removeQrImage(): Promise<void> {
    try {
      await rm(this.qrImagePath, { force: true });
    } catch {
      // best-effort cleanup; ignore
    }
  }

  /** Validate the number exists on WhatsApp and return its chat id. */
  private async resolveChatId(phoneNumber: string): Promise<string> {
    const sanitized = phoneNumber.replace(/\D/g, '');
    if (!sanitized) {
      throw new NumberNotFoundError(phoneNumber);
    }
    const numberId = await this.client.getNumberId(sanitized);
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
