import * as database from '@/utils/database';
import * as horizon from '@/services/horizon';
import { api, useDatabase } from './helpers';

// Horizon is never reached from tests. Each case sets how the probe behaves.
jest.mock('@/services/horizon', () => ({
  ...jest.requireActual('@/services/horizon'),
  probeHorizon: jest.fn(),
}));

useDatabase();

const probe = jest.mocked(horizon.probeHorizon);
beforeEach(() => probe.mockResolvedValue(undefined));

describe('GET /health', () => {
  it('reports OK with the database and Horizon up', async () => {
    const res = await api().get('/health').expect(200);
    expect(res.body).toMatchObject({
      status: 'OK',
      database: { status: 'up' },
      horizon: { status: 'up' },
      environment: 'test',
      stellarNetwork: 'testnet',
    });
    expect(probe).toHaveBeenCalledWith(expect.any(Number));
  });

  it('serves the same check at /healthz', async () => {
    const res = await api().get('/healthz').expect(200);
    expect(res.body).toMatchObject({ status: 'OK', horizon: { status: 'up' } });
  });

  it('returns 503 DEGRADED when Horizon is unreachable, without echoing the error', async () => {
    probe.mockRejectedValue(new Error('getaddrinfo ENOTFOUND horizon.internal-secret.example'));
    const res = await api().get('/healthz').expect(503);
    expect(res.body).toMatchObject({
      status: 'DEGRADED',
      database: { status: 'up' },
      horizon: { status: 'down' },
    });
    expect(JSON.stringify(res.body)).not.toContain('internal-secret');
  });

  it('reports a Horizon timeout as "timeout"', async () => {
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    probe.mockRejectedValue(err);
    const res = await api().get('/health').expect(503);
    expect(res.body).toMatchObject({ status: 'DEGRADED', horizon: { status: 'timeout' } });
  });

  it('returns 503 when the database probe fails', async () => {
    const spy = jest.spyOn(database, 'isDatabaseHealthy').mockReturnValue(false);
    try {
      const res = await api().get('/health').expect(503);
      expect(res.body).toMatchObject({
        status: 'DEGRADED',
        database: { status: 'down' },
        horizon: { status: 'up' },
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('returns a JSON 404 for unknown routes', async () => {
    const res = await api().get('/api/v1/nope').expect(404);
    expect(res.body).toEqual({ success: false, error: 'Route not found: GET /api/v1/nope' });
  });

  it('rejects malformed JSON with 400', async () => {
    await api()
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email":')
      .expect(400);
  });
});
