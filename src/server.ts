import 'reflect-metadata';
import { container } from 'tsyringe';

import { createApp } from './app';
import { config } from './config/env';
import { logger } from './utils/logger';
import { WhatsappService } from './services/whatsappService';

async function bootstrap(): Promise<void> {
  const whatsapp = container.resolve(WhatsappService);

  // Start the HTTP server first so /health and /qr are reachable immediately,
  // then connect WhatsApp in the background (login may need a QR scan).
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

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down...`);
    server.close();
    await whatsapp.destroy();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  logger.error('Fatal error during bootstrap', err);
  process.exit(1);
});
