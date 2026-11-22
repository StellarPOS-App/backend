import * as email from '@/services/email.service';
import { enqueueOutboxEmail, outboxStats, processOutboxOnce } from '@/services/outbox.service';
import { api, bearer, createProduct, createSale, signUp, useDatabase } from './helpers';

useDatabase();

describe('transactional outbox', () => {
  let token: string;
  let productId: string;
  let send: jest.SpyInstance;

  beforeAll(async () => {
    token = (await signUp()).token;
    productId = (await createProduct(token, { priceCents: 1250 })).id;
    // Clear the verification email queued when the first admin registered.
    await processOutboxOnce();
  });

  beforeEach(() => {
    send = jest.spyOn(email, 'sendEmail').mockResolvedValue(undefined);
  });

  afterEach(() => send.mockRestore());

  it('records one confirmation when a sale with a customer is created', async () => {
    const customer = await api()
      .post('/api/v1/customers')
      .set(bearer(token))
      .send({ name: 'Amaka', email: 'amaka@example.com' })
      .expect(201);
    const sale = await createSale(token, [{ productId, quantity: 2 }], {
      customerId: customer.body.data.id,
    });

    const pending = outboxStats().pending ?? 0;
    expect(pending).toBeGreaterThanOrEqual(1);

    expect(await processOutboxOnce()).toBeGreaterThanOrEqual(1);
    expect(outboxStats().pending ?? 0).toBe(0);

    const payload = send.mock.calls[0][0] as {
      to: string;
      subject: string;
      text: string;
    };
    expect(payload.to).toBe('amaka@example.com');
    expect(payload.subject).toContain(sale.reference);
    expect(payload.text).toContain('25.00');
  });

  it('collapses duplicate enqueues with the same dedupe key to one send', async () => {
    const before = outboxStats().sent ?? 0;
    const message = { to: 'buyer@example.com', subject: 'Order S-1', text: 'Thanks' };
    expect(enqueueOutboxEmail(message, 'order-confirmation:same-sale')).toBe(true);
    expect(enqueueOutboxEmail(message, 'order-confirmation:same-sale')).toBe(false);

    await processOutboxOnce();
    expect(send).toHaveBeenCalledTimes(1);
    expect((outboxStats().sent ?? 0) - before).toBe(1);
  });

  it('rolls the outbox row back with the transaction when the sale fails', async () => {
    const before = outboxStats().pending ?? 0;
    await api()
      .post('/api/v1/transactions')
      .set(bearer(token))
      .send({ items: [{ productId, quantity: 10_000 }] })
      .expect(409);
    expect(outboxStats().pending ?? 0).toBe(before);
  });

  it('no sale without a customer email produces a confirmation', async () => {
    await createSale(token, [{ productId, quantity: 1 }]);
    expect(outboxStats().pending ?? 0).toBe(0);
  });
});
