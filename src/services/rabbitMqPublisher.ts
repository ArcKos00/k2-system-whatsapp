import amqp from 'amqplib';
import { singleton } from 'tsyringe';
import { config } from '../config/env';
import { logger } from '../utils/logger';

// amqplib's exact connection/channel types vary slightly between minor
// versions; derive them from the API so we stay version-agnostic.
type AmqpConnection = Awaited<ReturnType<typeof amqp.connect>>;
type AmqpChannel = Awaited<ReturnType<AmqpConnection['createChannel']>>;

/**
 * Owns a single AMQP connection/channel and publishes inbound WhatsApp
 * messages to a `headers`-type exchange. Each message carries a `chatId`
 * header so consumers can bind a queue that matches a specific chat
 * (x-match: any/all on `chatId`). Registered as a tsyringe singleton.
 *
 * Forwarding is best-effort: when RabbitMQ is unreachable, publishes are
 * dropped (logged) rather than blocking the WhatsApp pipeline, and the
 * connection is re-established in the background.
 */
@singleton()
export class RabbitMqPublisher {
    private connection: AmqpConnection | null = null;
    private channel: AmqpChannel | null = null;
    /** Guards against overlapping connect attempts. */
    private connecting: Promise<void> | null = null;
    private closed = false;
    /** Chat ids to forward; empty Set means "forward all chats". */
    private readonly allowedChatIds = new Set(config.rabbitmq.chatIds);

    public get isEnabled(): boolean {
        return Boolean(config.rabbitmq.url);
    }

    /** Whether a chat's messages should be forwarded, per the allowlist. */
    private isAllowed(chatId: string): boolean {
        return this.allowedChatIds.size === 0 || this.allowedChatIds.has(chatId);
    }

    /** Establish the initial connection (no-op when no URL is configured). */
    public async init(): Promise<void> {
        if (!this.isEnabled) {
            logger.warn('RABBITMQ_URL not set — inbound message forwarding is disabled.');
            return;
        }
        this.closed = false;
        await this.connect();
    }

    /**
     * Publish a message to the headers exchange, tagged with `chatId`.
     * Returns true if handed to the broker, false if dropped (not connected
     * or back-pressured). Never throws — forwarding must not break message
     * handling.
     */
    public publishMessage(chatId: string, payload: unknown): boolean {
        if (!this.isEnabled) {
            return false;
        }
        if (!this.isAllowed(chatId)) {
            logger.debug('Skipping message: chat not in forward allowlist.', { chatId });
            return false;
        }
        if (!this.channel) {
            logger.warn('Dropping message: RabbitMQ channel not available.', { chatId });
            return false;
        }

        try {
            // Routing key is ignored by headers exchanges; matching is done on
            // the `headers` map below.
            return this.channel.publish(
                config.rabbitmq.exchange,
                '',
                Buffer.from(JSON.stringify(payload)),
                {
                    headers: { chatId },
                    contentType: 'application/json',
                    persistent: true,
                },
            );
        } catch (err) {
            logger.error('Failed to publish message to RabbitMQ', err);
            return false;
        }
    }

    /** Close the channel/connection on shutdown. */
    public async close(): Promise<void> {
        this.closed = true;
        try {
            await this.channel?.close();
        } catch (err) {
            logger.warn('Error closing RabbitMQ channel', err);
        }
        try {
            await this.connection?.close();
        } catch (err) {
            logger.warn('Error closing RabbitMQ connection', err);
        }
        this.channel = null;
        this.connection = null;
    }

    // --- internals -----------------------------------------------------------

    private async connect(): Promise<void> {
        if (this.connecting) {
            return this.connecting;
        }
        this.connecting = this.doConnect().finally(() => {
            this.connecting = null;
        });
        return this.connecting;
    }

    private async doConnect(): Promise<void> {
        const url = config.rabbitmq.url;
        if (!url) {
            return;
        }
        try {
            const connection = await amqp.connect(url);
            const channel = await connection.createChannel();
            await channel.assertExchange(config.rabbitmq.exchange, 'headers', {
                durable: true,
            });

            // Reconnect on connection loss (broker restart, network blip).
            connection.on('error', (err) => logger.warn('RabbitMQ connection error', err));
            connection.on('close', () => {
                this.channel = null;
                this.connection = null;
                this.scheduleReconnect();
            });

            this.connection = connection;
            this.channel = channel;
            logger.info('Connected to RabbitMQ', { exchange: config.rabbitmq.exchange });
        } catch (err) {
            logger.error('Failed to connect to RabbitMQ; will retry', err);
            this.scheduleReconnect();
        }
    }

    private scheduleReconnect(): void {
        if (this.closed) {
            return;
        }
        setTimeout(() => {
            void this.connect();
        }, config.rabbitmq.reconnectDelayMs).unref();
    }
}
