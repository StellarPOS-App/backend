import { randomUUID } from 'node:crypto';
import { api, bearer, createProduct, createSale, MERCHANT, signUp, useDatabase } from './helpers';
import { buildPaymentUri, configuredAsset } from '@/services/stellar.service';
import { closeDatabase, connectDatabase } from '@/utils/database';

useDatabase();

// Each test registers its own admin, so start from an empty database every time.
beforeEach(async () => {
  closeDatabase();
  await connectDatabase(':memory:');
});

describe('Stellar MEMO_TEXT validation', () => {
  it('rejects memos longer than 28 bytes before a payment URI is built', () => {
    expect(() =>
      buildPaymentUri({
        destination: MERCHANT,
        amount: '1',
        asset: configuredAsset(),
        memo: 'a'.repeat(29),
      }),
    ).toThrow(/28 bytes/);

    // 8 four-byte emoji = 32 bytes although it is only 8 characters.
    expect(() =>
      buildPaymentUri({
        destination: MERCHANT,
        amount: '1',
        asset: configuredAsset(),
        memo: '😀'.repeat(8),
      }),
    ).toThrow(/28 bytes/);

    expect(
      buildPaymentUri({
        destination: MERCHANT,
        amount: '1',
        asset: configuredAsset(),
        memo: 'SP1234567890',
      }),
    ).toContain('memo=SP1234567890');
  });

  it('rejects an oversized merchant-supplied memo at the API boundary', async () => {
    const admin = await signUp();
    const product = await createProduct(admin.token);
    const sale = await createSale(admin.token, [{ productId: product.id, quantity: 1 }]);

    const res = await api()
      .post('/api/v1/payments/requests')
      .set(bearer(admin.token))
      .send({ transactionId: sale.id, memo: 'M'.repeat(256) })
      .expect(400);
    expect(JSON.stringify(res.body.details)).toMatch(/28 bytes/);
  });

  it('accepts a custom memo at exactly 28 bytes', async () => {
    const admin = await signUp();
    const product = await createProduct(admin.token);
    const sale = await createSale(admin.token, [{ productId: product.id, quantity: 1 }]);
    const memo = 'M'.repeat(28);

    const res = await api()
      .post('/api/v1/payments/requests')
      .set(bearer(admin.token))
      .send({ transactionId: sale.id, memo })
      .expect(201);
    expect(res.body.data.memo).toBe(memo);
  });
});

describe('order creation idempotency', () => {
  it('replays the original order for a repeated Idempotency-Key within 24h', async () => {
    const admin = await signUp();
    const product = await createProduct(admin.token);
    const key = randomUUID();
    const payload = { items: [{ productId: product.id, quantity: 1 }] };

    const first = await api()
      .post('/api/v1/orders')
      .set(bearer(admin.token))
      .set('Idempotency-Key', key)
      .send(payload)
      .expect(201);

    const retry = await api()
      .post('/api/v1/orders')
      .set(bearer(admin.token))
      .set('Idempotency-Key', key)
      .send(payload)
      .expect(200);

    expect(retry.body.data.id).toBe(first.body.data.id);
    expect(retry.headers['idempotency-replayed']).toBe('true');

    const list = await api().get('/api/v1/transactions').set(bearer(admin.token)).expect(200);
    expect(list.body.pagination.total).toBe(1);
  });

  it('deduplicates on the /api/orders alias too', async () => {
    const admin = await signUp();
    const product = await createProduct(admin.token);
    const key = randomUUID();
    const payload = { items: [{ productId: product.id, quantity: 1 }] };

    const first = await api()
      .post('/api/orders')
      .set(bearer(admin.token))
      .set('Idempotency-Key', key)
      .send(payload)
      .expect(201);
    const retry = await api()
      .post('/api/orders')
      .set(bearer(admin.token))
      .set('Idempotency-Key', key)
      .send(payload)
      .expect(200);
    expect(retry.body.data.id).toBe(first.body.data.id);
  });

  it('creates a new order for a different key and rejects key reuse with a different body', async () => {
    const admin = await signUp();
    const product = await createProduct(admin.token);
    const payload = { items: [{ productId: product.id, quantity: 1 }] };

    const first = await api()
      .post('/api/v1/orders')
      .set(bearer(admin.token))
      .set('Idempotency-Key', randomUUID())
      .send(payload)
      .expect(201);
    const second = await api()
      .post('/api/v1/orders')
      .set(bearer(admin.token))
      .set('Idempotency-Key', randomUUID())
      .send(payload)
      .expect(201);
    expect(second.body.data.id).not.toBe(first.body.data.id);

    await api()
      .post('/api/v1/orders')
      .set(bearer(admin.token))
      .set('Idempotency-Key', first.body.data.reference) // a fresh key
      .send({ items: [{ productId: product.id, quantity: 2 }] })
      .expect(201);

    const key = randomUUID();
    await api()
      .post('/api/v1/orders')
      .set(bearer(admin.token))
      .set('Idempotency-Key', key)
      .send(payload)
      .expect(201);
    await api()
      .post('/api/v1/orders')
      .set(bearer(admin.token))
      .set('Idempotency-Key', key)
      .send({ items: [{ productId: product.id, quantity: 2 }] })
      .expect(409);
  });
});

describe('transaction pagination with filters', () => {
  async function seedVoidSales() {
    const admin = await signUp();
    const product = await createProduct(admin.token);
    const sales = [];
    for (let i = 0; i < 3; i++) {
      sales.push(await createSale(admin.token, [{ productId: product.id, quantity: 1 }]));
    }
    for (const sale of sales) {
      await api().post(`/api/v1/transactions/${sale.id}/void`).set(bearer(admin.token)).expect(200);
    }
    return { admin, sales };
  }

  it('applies page and limit after filters', async () => {
    const { admin, sales } = await seedVoidSales();
    const page1 = await api()
      .get('/api/v1/transactions?status=void&page=1&limit=2')
      .set(bearer(admin.token))
      .expect(200);
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.pagination).toMatchObject({ page: 1, limit: 2, total: 3 });

    const page2 = await api()
      .get('/api/v1/transactions?status=void&page=2&limit=2')
      .set(bearer(admin.token))
      .expect(200);
    expect(page2.body.data).toHaveLength(1);
    expect(page2.body.data[0].status).toBe('void');
    expect(page2.body.data[0].id).not.toBe(page1.body.data[0].id);
    expect(new Set(sales.map((s) => s.id)).has(page1.body.data[0].id)).toBe(true);
  });

  it('applies the keyset cursor after filters rather than returning everything', async () => {
    const { admin } = await seedVoidSales();
    const first = await api()
      .get('/api/v1/transactions?status=void&limit=2')
      .set(bearer(admin.token))
      .expect(200);
    expect(first.body.data).toHaveLength(2);
    expect(first.body.pagination.hasMore).toBe(true);
    expect(first.body.pagination.nextCursor).toBeTruthy();

    const second = await api()
      .get(
        `/api/v1/transactions?status=void&limit=2&cursor=${encodeURIComponent(first.body.pagination.nextCursor)}`,
      )
      .set(bearer(admin.token))
      .expect(200);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.data[0].status).toBe('void');
    expect(second.body.pagination.hasMore).toBe(false);

    const ids = [...first.body.data, ...second.body.data].map((t: { id: string }) => t.id);
    expect(new Set(ids).size).toBe(3);
  });
});

describe('KYC gate on withdrawals', () => {
  const validWithdrawal = {
    destination: MERCHANT,
    assetCode: 'XLM',
    amount: '1.5',
    memo: 'withdraw',
  };

  it('blocks every withdrawal endpoint until KYC is approved', async () => {
    const merchant = await signUp();
    await api()
      .post('/api/v1/withdrawals')
      .set(bearer(merchant.token))
      .send(validWithdrawal)
      .expect(403);
    await api().get('/api/v1/withdrawals').set(bearer(merchant.token)).expect(403);

    await api()
      .patch(`/api/v1/users/${merchant.id}/kyc`)
      .set(bearer(merchant.token))
      .send({ status: 'approved' })
      .expect(200);

    const created = await api()
      .post('/api/v1/withdrawals')
      .set(bearer(merchant.token))
      .send(validWithdrawal)
      .expect(201);
    expect(created.body.data.status).toBe('pending');

    const listed = await api().get('/api/v1/withdrawals').set(bearer(merchant.token)).expect(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0].id).toBe(created.body.data.id);
  });

  it('rejects non-approved KYC values and oversized withdrawal memos', async () => {
    const merchant = await signUp();
    await api()
      .patch(`/api/v1/users/${merchant.id}/kyc`)
      .set(bearer(merchant.token))
      .send({ status: 'approved' })
      .expect(200);

    const badMemo = await api()
      .post('/api/v1/withdrawals')
      .set(bearer(merchant.token))
      .send({ ...validWithdrawal, memo: 'x'.repeat(256) })
      .expect(400);
    expect(JSON.stringify(badMemo.body.details)).toMatch(/28 bytes/);

    await api()
      .patch(`/api/v1/users/${merchant.id}/kyc`)
      .set(bearer(merchant.token))
      .send({ status: 'rejected' })
      .expect(200);
    await api()
      .post('/api/v1/withdrawals')
      .set(bearer(merchant.token))
      .send(validWithdrawal)
      .expect(403);
  });

  it('does not let a non-admin set its own KYC status', async () => {
    await signUp(); // first user is the admin
    const cashier = await signUp();
    await api()
      .patch(`/api/v1/users/${cashier.id}/kyc`)
      .set(bearer(cashier.token))
      .send({ status: 'approved' })
      .expect(403);
  });
});
