import { Router } from 'express';

const router = Router();

const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'StellarPOS Backend API',
    version: '1.0.0',
    description: 'API documentation for StellarPOS terminal and management platform.',
  },
  paths: {
    '/api/v1/auth/login': {
      post: {
        summary: 'Authenticate user',
        responses: { 200: { description: 'Successful login' } },
      },
    },
    '/api/v1/payments': {
      post: {
        summary: 'Record offline or Stellar payment',
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: false,
            schema: { type: 'string' },
          },
        ],
        responses: { 201: { description: 'Payment recorded' } },
      },
    },
    '/api/v1/orders': {
      post: {
        summary: 'Create an order (deduplicated with Idempotency-Key for 24h)',
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: false,
            schema: { type: 'string', maxLength: 255 },
          },
        ],
        responses: {
          201: { description: 'Order created' },
          200: { description: 'Replayed order' },
        },
      },
    },
    '/api/v1/withdrawals': {
      post: {
        summary: 'Initiate a Stellar withdrawal (requires approved KYC)',
        responses: {
          201: { description: 'Withdrawal queued' },
          403: { description: 'KYC not approved' },
        },
      },
      get: { summary: 'List withdrawals (requires approved KYC)' },
    },
    '/api/v1/users/{id}/kyc': {
      patch: {
        summary: 'Admin: record a merchant KYC decision',
        responses: { 200: { description: 'KYC status updated' } },
      },
    },
    '/api/v1/products': {
      get: {
        summary: 'List products',
        responses: { 200: { description: 'List of products' } },
      },
    },
    '/api/v1/transactions': {
      get: {
        summary: 'List transactions',
        responses: { 200: { description: 'List of transactions' } },
      },
    },
  },
};

router.get('/openapi.json', (_req, res) => {
  res.json(openApiSpec);
});

router.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>StellarPOS API Documentation</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.ui = SwaggerUIBundle({
      url: '/api/docs/openapi.json',
      dom_id: '#swagger-ui',
    });
  </script>
</body>
</html>`);
});

export default router;
