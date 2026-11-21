import 'dotenv/config';
import {
  assertStellarNetworkSettings,
  parseStellarNetwork,
  STELLAR_NETWORKS,
} from '@/config/stellarNetwork';

type Env = 'development' | 'production' | 'test';

function str(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value !== undefined && value !== '') return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable ${name}`);
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

const env = str('NODE_ENV', 'development') as Env;
// A typo such as "mainnnet" must stop start-up, not silently select testnet.
const network = parseStellarNetwork(str('STELLAR_NETWORK', 'testnet'));

export const config = {
  env,
  isProd: env === 'production',
  isTest: env === 'test',
  port: int('PORT', 3000),
  logLevel: str('LOG_LEVEL', env === 'production' ? 'info' : 'debug'),
  client: {
    url: str('CLIENT_URL', 'http://localhost:5173'),
  },
  jwt: {
    // No default: a baked-in secret would let anyone mint admin tokens.
    secret: str('JWT_SECRET'),
    expiresIn: str('JWT_EXPIRES_IN', '12h'),
  },
  database: {
    path: str('DATABASE_PATH', './data/stellarpos.db'),
  },
  email: {
    // 'log' (default) prints emails; 'resend' sends through api.resend.com.
    provider: str('EMAIL_PROVIDER', 'log'),
    apiKey: str('EMAIL_API_KEY', ''),
    from: str('EMAIL_FROM', 'StellarPOS <receipts@example.com>'),
  },
  backup: {
    dir: str('BACKUP_DIR', './data/backups'),
    intervalHours: int('BACKUP_INTERVAL_HOURS', 0),
    keep: int('BACKUP_KEEP', 14),
  },
  webhooks: {
    // No default: an empty secret would leave webhook routes unauthenticated.
    secret: str('WEBHOOK_SECRET', ''),
    toleranceSeconds: int('WEBHOOK_TOLERANCE_SECONDS', 300),
  },
  store: {
    name: str('STORE_NAME', 'StellarPOS Store'),
    currency: str('STORE_CURRENCY', 'USD').toUpperCase(),
    taxRateBps: int('TAX_RATE_BPS', 0),
  },
  stellar: {
    network,
    horizonUrl: str(
      'STELLAR_HORIZON_URL',
      network === 'mainnet' ? 'https://horizon.stellar.org' : 'https://horizon-testnet.stellar.org',
    ),
    // Checked against `network` at start-up (see assertStellarNetworkSettings).
    networkPassphrase: str('STELLAR_NETWORK_PASSPHRASE', STELLAR_NETWORKS[network].passphrase),
    merchantPublicKey: str('STELLAR_MERCHANT_PUBLIC_KEY', ''),
    asset: {
      code: str('STELLAR_ASSET_CODE', 'XLM'),
      issuer: str('STELLAR_ASSET_ISSUER', ''),
    },
    assetRate: str('STELLAR_ASSET_RATE', '1'),
    paymentTtlMinutes: int('STELLAR_PAYMENT_TTL_MINUTES', 15),
    watcher: {
      enabled: bool('STELLAR_WATCHER_ENABLED', env !== 'test'),
      intervalMs: int('STELLAR_WATCHER_INTERVAL_MS', 5000),
    },
    contracts: {
      paymentProcessor: str('STELLAR_PAYMENT_PROCESSOR_ID', ''),
      merchantRegistry: str('STELLAR_MERCHANT_REGISTRY_ID', ''),
    },
  },
  health: {
    // Upper bound for each dependency probe behind GET /health and /healthz.
    timeoutMs: int('HEALTH_CHECK_TIMEOUT_MS', 1000),
  },
  metrics: {
    // Optional. When set, GET /metrics requires "Authorization: Bearer <token>".
    token: str('METRICS_TOKEN', ''),
  },
  shutdown: {
    // SIGTERM: how long in-flight requests get to finish, and separately how long
    // the job queue gets to flush. After the first request deadline, open sockets are cut.
    timeoutMs: int('SHUTDOWN_TIMEOUT_MS', 10_000),
  },
} as const;

if (config.isProd && config.jwt.secret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters in production');
}
if (config.email.provider === 'resend' && !config.email.apiKey) {
  throw new Error('EMAIL_API_KEY is required when EMAIL_PROVIDER=resend');
}
if (config.store.taxRateBps < 0 || config.store.taxRateBps > 10_000) {
  throw new Error('TAX_RATE_BPS must be between 0 and 10000');
}
assertStellarNetworkSettings({
  network: config.stellar.network,
  horizonUrl: config.stellar.horizonUrl,
  networkPassphrase: config.stellar.networkPassphrase,
});
if (config.health.timeoutMs <= 0) {
  throw new Error('HEALTH_CHECK_TIMEOUT_MS must be greater than 0');
}
if (config.shutdown.timeoutMs <= 0) {
  throw new Error('SHUTDOWN_TIMEOUT_MS must be greater than 0');
}

export type Config = typeof config;
