import { config } from '@/config/config';
import * as email from '@/services/email.service';
import { processOutboxOnce } from '@/services/outbox.service';
import { getDb } from '@/utils/database';
import { api, bearer, signUp, useDatabase } from './helpers';

useDatabase();

let send: jest.SpyInstance;

/** Delivers queued verification mail and extracts the link token from it. */
async function latestVerificationToken(): Promise<string> {
  await processOutboxOnce();
  const rows = getDb()
    .prepare("SELECT payload FROM outbox WHERE subject LIKE '%Verify%' ORDER BY rowid DESC")
    .all() as { payload: string }[];
  if (!rows.length) throw new Error('No verification email was queued');
  const text = (JSON.parse(rows[0].payload) as email.Email).text;
  return /token=([^\s]+)/.exec(text)![1];
}

describe('merchant email verification', () => {
  let token: string;

  beforeAll(async () => {
    send = jest.spyOn(email, 'sendEmail').mockResolvedValue(undefined);
    token = (await signUp()).token;
  });

  afterAll(() => send.mockRestore());

  it('defaults to a 24-hour link lifetime (previously 15 minutes)', async () => {
    expect(config.verification.tokenTtlHours).toBe(24);
    const res = await api()
      .post('/api/v1/verification/send')
      .set(bearer(token))
      .send({})
      .expect(202);
    const expiresAt = Date.parse(res.body.data.expiresAt);
    const hours = (expiresAt - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);
  });

  it('verifies a real link exactly once', async () => {
    const verificationToken = await latestVerificationToken();
    await api().post('/api/v1/verification/confirm').send({ token: verificationToken }).expect(200);
    await api()
      .get('/api/v1/verification/status')
      .set(bearer(token))
      .expect(200)
      .then((res) => expect(res.body.data).toEqual({ verified: true }));

    await api().post('/api/v1/verification/confirm').send({ token: verificationToken }).expect(400);
  });

  it('rejects unknown and malformed tokens', async () => {
    await api()
      .post('/api/v1/verification/confirm')
      .send({ token: 'x'.repeat(40) })
      .expect(400);
    await api().post('/api/v1/verification/confirm').send({ token: 'short' }).expect(400);
  });

  it('invalidates the old link when a new one is requested', async () => {
    const first = await latestVerificationToken();
    await api().post('/api/v1/verification/send').set(bearer(token)).send({}).expect(202);
    const second = await latestVerificationToken();
    expect(second).not.toBe(first);

    await api().post('/api/v1/verification/confirm').send({ token: first }).expect(400);
    await api().post('/api/v1/verification/confirm').send({ token: second }).expect(200);
  });

  it('rate-limits the resend endpoint but /send stays available', async () => {
    await api().post('/api/v1/verification/send').set(bearer(token)).send({}).expect(202);
    await api().post('/api/v1/verification/resend').set(bearer(token)).send({}).expect(429);
  });
});
