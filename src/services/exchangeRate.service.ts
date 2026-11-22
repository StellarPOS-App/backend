/**
 * Exchange-rate lookup with a short-lived Redis cache.
 *
 * Stellar checkouts need the store-currency -> asset rate on every conversion.
 * Calling the external FX API for each one turns a burst of sales into hundreds
 * of requests per second and gets us rate limited. Every lookup therefore goes
 * through Redis first: a hit is served immediately, a miss performs at most one
 * live fetch per key (single-flight) and caches the result for 60 seconds.
 *
 * When no FX provider is configured we fall back to STELLAR_ASSET_RATE so a
 * checkout never fails just because an external service is down.
 */
import { config } from '@/config/config';
import { logger } from '@/utils/logger';
import { getRedis } from '@/utils/redis';

export const EXCHANGE_RATE_CACHE_TTL_SECONDS = 60;

export type RateSource = 'cache' | 'api' | 'configured';

export interface ExchangeRate {
  /** Store-currency units per one unit of the asset (same units as centsToAssetAmount). */
  rate: string;
  source: RateSource;
  fetchedAt: string;
}

interface CachedRate {
  rate: string;
  fetchedAt: string;
}

/** In-flight fetches, so concurrent misses for one pair make only one API call. */
const inFlight = new Map<string, Promise<ExchangeRate>>();

const cacheKey = (from: string, to: string) =>
  `exchange:rate:${from.toUpperCase()}:${to.toUpperCase()}`;

/**
 * Reads a payload in the shapes used by the common FX APIs:
 * `{ rates: { XLM: "2.5" } }`, `{ XLM: 2.5 }`, `{ rate: 2.5 }` or
 * `{ USD_XLM: 2.5 }`.
 */
export function parseRatePayload(body: unknown, from: string, to: string): string {
  if (!body || typeof body !== 'object') throw new Error('Malformed exchange-rate response');
  const data = body as Record<string, unknown>;
  const nested = data.rates;
  const candidates: unknown[] = [
    nested && typeof nested === 'object'
      ? (nested as Record<string, unknown>)[to.toUpperCase()]
      : undefined,
    (nested as Record<string, unknown> | undefined)?.[`${from.toUpperCase()}${to.toUpperCase()}`],
    data[to.toUpperCase()],
    data[`${from.toUpperCase()}${to.toUpperCase()}`],
    data.rate,
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === '') continue;
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) return String(value);
  }
  throw new Error(`Exchange-rate response has no positive rate for ${from}/${to}`);
}

async function fetchLiveRate(from: string, to: string): Promise<ExchangeRate> {
  const url = new URL(config.exchangeRate.apiUrl);
  url.searchParams.set('base', from.toUpperCase());
  url.searchParams.set('symbols', to.toUpperCase());
  if (config.exchangeRate.apiKey) url.searchParams.set('access_key', config.exchangeRate.apiKey);

  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`Exchange-rate API responded ${res.status}`);
  const rate = parseRatePayload(await res.json(), from, to);
  return { rate, source: 'api', fetchedAt: new Date().toISOString() };
}

function configuredRate(): ExchangeRate {
  const rate = Number(config.stellar.assetRate);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error('STELLAR_ASSET_RATE must be a positive number');
  }
  return { rate: String(rate), source: 'configured', fetchedAt: new Date().toISOString() };
}

async function loadRate(from: string, to: string): Promise<ExchangeRate> {
  const key = cacheKey(from, to);

  try {
    const cached = await getRedis().get(key);
    if (cached) {
      const parsed = JSON.parse(cached) as CachedRate;
      if (parsed?.rate && Number(parsed.rate) > 0) {
        return { ...parsed, source: 'cache' };
      }
    }
  } catch (err) {
    // Cache unavailable is not fatal: fall through to a live fetch.
    logger.debug(`Exchange-rate cache read failed: ${(err as Error).message}`);
  }

  if (!config.exchangeRate.apiUrl) return configuredRate();

  try {
    const fresh = await fetchLiveRate(from, to);
    try {
      await getRedis().set(key, JSON.stringify(fresh), config.exchangeRate.cacheTtlSeconds);
    } catch (err) {
      logger.debug(`Exchange-rate cache write failed: ${(err as Error).message}`);
    }
    return fresh;
  } catch (err) {
    logger.warn(
      `Exchange-rate API lookup failed (${(err as Error).message}); using configured rate`,
    );
    return configuredRate();
  }
}

/** Returns the rate for a currency pair, preferring the 60-second Redis cache. */
export function getExchangeRate(
  from: string = config.store.currency,
  to: string = config.stellar.asset.code,
): Promise<ExchangeRate> {
  const key = cacheKey(from, to);
  let pending = inFlight.get(key);
  if (!pending) {
    pending = loadRate(from, to).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}

/** Convenience for checkout conversions: just the rate string. */
export async function getAssetRate(): Promise<string> {
  return (await getExchangeRate()).rate;
}

/** Test helper: drops cached values and any in-flight fetches for all pairs. */
export async function clearExchangeRateCache(): Promise<void> {
  inFlight.clear();
  try {
    const redis = getRedis();
    // The in-memory client exposes only get/set/del, so use a versioned key
    // scheme by scanning known pairs is unnecessary here; tests use fresh Redis.
    await redis.flushAll();
  } catch {
    // Nothing to clear when Redis is not available.
  }
}
