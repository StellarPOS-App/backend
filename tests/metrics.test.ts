import { config } from '@/config/config';
import { getQueue, setupQueues } from '@/utils/queue';
import { api, createProduct, signUp, useDatabase } from './helpers';

useDatabase();
beforeAll(() => setupQueues());

describe('GET /metrics', () => {
  it('exposes HTTP metrics labelled by route template, not raw URL', async () => {
    const { token } = await signUp();
    await createProduct(token);

    const res = await api().get('/metrics').expect(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toContain('# TYPE http_request_duration_seconds histogram');
    expect(res.text).toMatch(
      /http_requests_total\{method="POST",route="\/api\/v1\/products",status_code="201"\} [1-9]/,
    );
  });

  it('counts unmatched paths under one "unmatched" label', async () => {
    await api().get('/no/such/path/12345').expect(404);
    const res = await api().get('/metrics').expect(200);
    expect(res.text).toMatch(/route="unmatched"/);
    expect(res.text).not.toContain('/no/such/path');
  });

  it('reports queue depth per queue', async () => {
    // No processor is registered, so the job stays waiting and counts toward depth.
    getQueue('notifications').add({ to: 'someone@example.com', subject: 's', text: 't' });
    const res = await api().get('/metrics').expect(200);
    expect(res.text).toMatch(/queue_depth\{queue="notifications"\} 1/);
    expect(res.text).toMatch(/queue_dead_letters\{queue="notifications"\} 0/);
  });

  it('records Stellar outcomes as a bounded counter', async () => {
    const res = await api().get('/metrics').expect(200);
    expect(res.text).toContain('# TYPE stellar_transactions_total counter');
  });

  it('requires METRICS_TOKEN when it is configured', async () => {
    const settings = config.metrics as { token: string };
    const original = settings.token;
    settings.token = 'scrape-secret-value';
    try {
      await api().get('/metrics').expect(401);
      await api().get('/metrics').set('Authorization', 'Bearer wrong-value-here').expect(401);
      await api().get('/metrics').set('Authorization', 'Bearer scrape-secret-value').expect(200);
    } finally {
      settings.token = original;
    }
  });
});
