import { config } from '@/config/config';
import {
  clearExchangeRateCache,
  getAssetRate,
  getExchangeRate,
  parseRatePayload,
} from '@/services/exchangeRate.service';

/** Tests run against an in-memory Redis client connected in tests/setup.ts. */
describe('exchange rate cache', () => {
  const original = { ...config.exchangeRate };
  let fetchMock: jest.SpyInstance;

  beforeEach(async () => {
    await clearExchangeRateCache();
    // Fresh Response per call: a Response body can only be consumed once.
    fetchMock = jest
      .spyOn(global, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ rates: { USDC: 2.5 } }), { status: 200 })),
      );
  });

  afterEach(() => {
    fetchMock.mockRestore();
    (config.exchangeRate as { apiUrl: string }).apiUrl = original.apiUrl;
    (config.exchangeRate as { apiKey: string }).apiKey = original.apiKey;
    (config.exchangeRate as { cacheTtlSeconds: number }).cacheTtlSeconds = original.cacheTtlSeconds;
    jest.useRealTimers();
  });

  it('parses common FX response shapes', () => {
    expect(parseRatePayload({ rates: { USDC: '2.5' } }, 'USD', 'USDC')).toBe('2.5');
    expect(parseRatePayload({ USDC: 3 }, 'USD', 'USDC')).toBe('3');
    expect(parseRatePayload({ rate: 0.25 }, 'USD', 'USDC')).toBe('0.25');
    expect(parseRatePayload({ USDUSDC: 4 }, 'USD', 'USDC')).toBe('4');
    expect(() => parseRatePayload({ rates: {} }, 'USD', 'USDC')).toThrow();
  });

  it('falls back to the configured rate without an API configured', async () => {
    (config.exchangeRate as { apiUrl: string }).apiUrl = '';
    const rate = await getExchangeRate('USD', 'USDC');
    expect(rate).toMatchObject({ rate: '1', source: 'configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches once, then serves every conversion from the 60s Redis cache', async () => {
    (config.exchangeRate as { apiUrl: string }).apiUrl = 'https://fx.example/rates';
    expect(config.exchangeRate.cacheTtlSeconds).toBe(60);

    const first = await getExchangeRate('USD', 'USDC');
    expect(first).toMatchObject({ rate: '2.5', source: 'api' });
    const second = await getExchangeRate('USD', 'USDC');
    expect(second).toMatchObject({ rate: '2.5', source: 'cache' });
    expect(await getAssetRate()).toBe('2.5');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('base=USD');
    expect(url).toContain('symbols=USDC');
  });

  it('coalesces concurrent cache misses into one API call', async () => {
    (config.exchangeRate as { apiUrl: string }).apiUrl = 'https://fx.example/rates';
    const [a, b, c] = await Promise.all([
      getExchangeRate('USD', 'USDC'),
      getExchangeRate('USD', 'USDC'),
      getExchangeRate('USD', 'USDC'),
    ]);
    expect([a.rate, b.rate, c.rate]).toEqual(['2.5', '2.5', '2.5']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refetches after the TTL expires', async () => {
    (config.exchangeRate as { apiUrl: string }).apiUrl = 'https://fx.example/rates';
    (config.exchangeRate as { cacheTtlSeconds: number }).cacheTtlSeconds = 1;
    await getExchangeRate('USD', 'USDC');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const refreshed = await getExchangeRate('USD', 'USDC');
    expect(refreshed.source).toBe('api');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses the configured rate when the API is down', async () => {
    (config.exchangeRate as { apiUrl: string }).apiUrl = 'https://fx.example/rates';
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const rate = await getExchangeRate('USD', 'USDC');
    expect(rate).toMatchObject({ rate: '1', source: 'configured' });
  });
});
