import amqp from 'amqplib';
import { singleton } from 'tsyringe';
import { config } from '../config/env';
import { logger } from '../utils/logger';

type AmqpConnection = Awaited<ReturnType<typeof amqp.connect>>;
type AmqpChannel = Awaited<ReturnType<AmqpConnection['createConfirmChannel']>>;

@singleton()
export class RabbitMqPublisher {
    private connection: AmqpConnection | null = null;
    private channel: AmqpChannel | null = null;
    private connecting: Promise<void> | null = null;
    private closed = false;
    private readonly allowedChatIds = new Set(config.rabbitmq.chatIds);

    public get isEnabled(): boolean {
        return Boolean(config.rabbitmq.url);
    }

    public async init(): Promise<void> {
        if (!this.isEnabled) {
            logger.warn('RABBITMQ_URL not set — inbound message forwarding is disabled.');
            return;
        }
        this.closed = false;
        await this.connect();
    }

    public publishMessage(chatId: string, payload: unknown, messageId?: string): Promise<boolean> {
        if (!this.isEnabled) {
            return Promise.resolve(false);
        }
        if (!this.isAllowed(chatId)) {
            logger.debug('Skipping message: chat not in forward allowlist.', { chatId });
            return Promise.resolve(true);
        }
        const channel = this.channel;
        if (!channel) {
            logger.warn('Cannot publish yet: RabbitMQ channel not available.', { chatId });
            return Promise.resolve(false);
        }

        return new Promise<boolean>((resolve) => {
            try {
                channel.publish(
                    config.rabbitmq.exchange,
                    '',
                    Buffer.from(JSON.stringify(payload)),
                    {
                        headers: { chatId },
                        contentType: 'application/json',
                        persistent: true,
                        messageId,
                    },
                    (err) => {
                        if (err) {
                            logger.warn('RabbitMQ nacked publish; will retry via reconcile.', { chatId, err });
                        }
                        resolve(!err);
                    },
                );
            } catch (err) {
                logger.error('Failed to publish message to RabbitMQ', err);
                resolve(false);
            }
        });
    }

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

    private isAllowed(chatId: string): boolean {
        return this.allowedChatIds.size === 0 || this.allowedChatIds.has(chatId);
    }

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
            const channel = await connection.createConfirmChannel();
            await channel.assertExchange(config.rabbitmq.exchange, 'headers', { durable: true });

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
