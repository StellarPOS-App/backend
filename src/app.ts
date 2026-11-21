import compression from 'compression';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { config } from '@/config/config';
import { apiVersion, unsupportedApiVersion } from '@/middleware/apiVersion.middleware';
import { auditTrail } from '@/middleware/audit.middleware';
import { errorHandler } from '@/middleware/error.middleware';
import { responseTime } from '@/middleware/responseTime.middleware';
import { notFoundHandler } from '@/middleware/notFound.middleware';
import { DEFAULT_ROLE_LIMITS, roleRateLimit } from '@/middleware/rateLimit.middleware';
import analyticsRoutes from '@/routes/analytics.routes';
import merchantRoutes from '@/routes/merchant.routes';
import auditRoutes from '@/routes/audit.routes';
import authRoutes from '@/routes/auth.routes';
import customerRoutes from '@/routes/customers.routes';
import paymentRoutes from '@/routes/payments.routes';
import productRoutes from '@/routes/products.routes';
import queueRoutes from '@/routes/queues.routes';
import searchRoutes from '@/routes/search.routes';
import storeRoutes from '@/routes/store.routes';
import transactionRoutes from '@/routes/transactions.routes';
import userRoutes from '@/routes/users.routes';
import { connections } from '@/services/realtime';
import { isDatabaseHealthy } from '@/utils/database';
import { logger } from '@/utils/logger';

export function createApp(): express.Express {
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(
    cors({
      origin: config.client.url,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    }),
  );
  app.use(
    '/api',
    roleRateLimit(
      config.isTest
        ? { anonymous: 10_000, cashier: 10_000, manager: 10_000, admin: 10_000 }
        : DEFAULT_ROLE_LIMITS,
    ),
  );
  app.use(express.json({ limit: '100kb' }));
  app.use('/api', auditTrail);
  // Compress all responses larger than 1 KB (#155). The filter skips
  // already-compressed content types (images, video, zip) so the CPU cost of
  // attempting a second compression pass is never paid for binary downloads.
  app.use(
    compression({
      threshold: 1024,
      filter: (req, res) => {
        const type = res.getHeader('Content-Type');
        if (typeof type === 'string' && /image|video|audio|zip|gzip|br/.test(type)) return false;
        return compression.filter(req, res);
      },
    }),
  );
  app.use(responseTime);
  app.use(compression());
  if (!config.isTest) {
    app.use(
      morgan(config.isProd ? 'combined' : 'dev', {
        stream: { write: (line) => logger.http(line.trim()) },
      }),
    );
  }

  // CDN redirect for static documentation and image assets (#160).
  // In production, set CDN_URL to your CDN origin (e.g. https://cdn.example.com).
  // The server 302-redirects /docs/* and /static/* to the CDN so Node.js does
  // not spend CPU streaming bytes that a CDN can serve at the edge.
  if (config.cdn.url) {
    app.use(['/docs', '/static'], (req, res) => {
      res.redirect(302, `${config.cdn.url}${req.path}`);
    });
  }

  app.get('/health', (_req, res) => {
    const database = isDatabaseHealthy() ? 'up' : 'down';
    // Load balancers take a 503 as "send traffic elsewhere".
    res.status(database === 'up' ? 200 : 503).json({
      status: database === 'up' ? 'OK' : 'DEGRADED',
      database,
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version ?? '0.2.0',
      environment: config.env,
      stellarNetwork: config.stellar.network,
      sockets: connections.count(),
    });
  });

  app.use('/api/v1', apiVersion('1'));
  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/users', userRoutes);
  app.use('/api/v1/store', storeRoutes);
  app.use('/api/v1/products', productRoutes);
  app.use('/api/v1/customers', customerRoutes);
  app.use('/api/v1/transactions', transactionRoutes);
  app.use('/api/v1/payments', paymentRoutes);
  app.use('/api/v1/analytics', analyticsRoutes);
  app.use('/api/v1/search', searchRoutes);
  app.use('/api/v1/audit', auditRoutes);
  app.use('/api/v1/merchant', merchantRoutes);
  app.use('/api/v1/queues', queueRoutes);
  app.use(unsupportedApiVersion(['1']));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

export const app = createApp();
