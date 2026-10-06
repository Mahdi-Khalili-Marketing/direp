import express, { Express } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api } from './routes.js';
import { webhookHandler } from './webhook.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp(): Express {
  const app = express();
  // Behind a local reverse proxy (nginx/Caddy) so req.ip and req.protocol are the client's.
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // Keep the raw body: BoxAPI's HMAC signature is computed over the exact bytes.
  app.use(
    express.json({
      limit: '1mb',
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    })
  );

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.post('/api/webhooks/boxapi', webhookHandler);
  app.use('/api', api);
  app.use(express.static(publicDir));
  return app;
}
