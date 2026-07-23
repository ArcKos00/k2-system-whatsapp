import './apm';
import 'reflect-metadata';
import { container } from 'tsyringe';

import { createApp } from './app';
import { config } from './config/env';
import { logger } from './utils/logger';
import { WhatsappService } from './services/whatsappService';
import { RabbitMqPublisher } from './services/rabbitMqPublisher';

async function bootstrap(): Promise<void> {
  const rabbitmq = container.resolve(RabbitMqPublisher);
  const whatsapp = container.resolve(WhatsappService);

  await rabbitmq.init();

  const app = createApp();
  const base = config.pathBase;
  const server = app.listen(config.port, () => {
    logger.info(`HTTP server listening on port ${config.port} (${config.env})`);
    if (base) {
      logger.info(`Path base: ${base}`);
    }
    logger.info(`Swagger UI available at http://localhost:${config.port}${base}/docs`);
    logger.info(`Login QR (while pending) at http://localhost:${config.port}${base}/qr`);
  });

  whatsapp.initClient().catch((err) => {
    logger.error('WhatsApp client failed to initialize', err);
  });

  const handleFatal = (kind: string, err: unknown): void => {
    if (whatsapp.isRecoverableError(err)) {
      logger.warn(`Ignoring transient WhatsApp error (${kind}); session left intact.`, err);
      return;
    }
    logger.error(`${kind}; shutting down`, err);
    process.exit(1);
  };

  process.on('unhandledRejection', (reason) => handleFatal('unhandledRejection', reason));
  process.on('uncaughtException', (err) => handleFatal('uncaughtException', err));

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down...`);
    server.close();
    await whatsapp.destroy();
    await rabbitmq.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  logger.error('Fatal error during bootstrap', err);
  process.exit(1);
});
