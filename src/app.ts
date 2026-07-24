import express, { Application, json, urlencoded } from 'express';
import swaggerUi from 'swagger-ui-express';
import { container } from 'tsyringe';

import { config } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { usePathBase } from './middleware/pathBase';
import { WhatsappService } from './services/whatsappService';

import { RegisterRoutes } from './generated/routes';
import swaggerDocument from './generated/swagger.json';

export function createApp(): Application {
  const app = express();

  app.use(usePathBase(config.pathBase));

  app.use(json({ limit: '25mb' }));
  app.use(urlencoded({ extended: true, limit: '25mb' }));

  const spec = config.pathBase
    ? { ...swaggerDocument, servers: [{ url: config.pathBase }] }
    : swaggerDocument;

  app.use('/docs', swaggerUi.serve, swaggerUi.setup(spec));
  app.get('/openapi.json', (_req, res) => res.json(spec));

  const whatsapp = container.resolve(WhatsappService);
  app.get('/qr', async (_req, res, next) => {
    try {
      const png = await whatsapp.getQrPng();
      if (!png) {
        res.status(404).json({
          message: `No QR pending (WhatsApp status: ${whatsapp.getStatus()})`,
          code: 'QR_NOT_AVAILABLE',
        });
        return;
      }
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'no-store');
      res.send(png);
    } catch (err) {
      next(err);
    }
  });

  RegisterRoutes(app);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
