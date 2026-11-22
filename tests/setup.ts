process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-not-for-production-use-0123456789';
process.env.DATABASE_PATH = ':memory:';
process.env.STELLAR_NETWORK = 'testnet';
process.env.STELLAR_MERCHANT_PUBLIC_KEY =
  'GDSMS3UTKQMPU5VGX4IWWUDNNX432KIBT4F3SNVKHPMSJQZOI4T5TBUK';
process.env.STELLAR_ASSET_CODE = 'USDC';
process.env.STELLAR_ASSET_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.STELLAR_ASSET_RATE = '1';
process.env.STELLAR_WATCHER_ENABLED = 'false';
process.env.TAX_RATE_BPS = '0';

// The database is owned by each suite via useDatabase() (or its own beforeAll
// for file-backed tests). Only the shared Redis cache is reset per suite, so
// a rate cached by one file cannot hide an API call another file expects.
import { connectRedis, getRedis } from '@/utils/redis';

beforeAll(async () => {
  await connectRedis();
  await getRedis().flushAll();
});
