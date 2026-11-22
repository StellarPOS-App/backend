import { buildCheckoutMemo, MAX_MEMO_TEXT_BYTES } from '@/utils/memo';
import { api, bearer, createProduct, createSale, signUp, useDatabase } from './helpers';

useDatabase();

describe('human-readable Stellar memos', () => {
  it('includes the merchant name and the order total', () => {
    const memo = buildCheckoutMemo({
      merchantName: 'Kofi Coffee',
      totalCents: 1234,
      reference: 'S-000001',
      unique: 'A7KQ',
    });
    expect(memo).toContain('KOFI COFFEE');
    expect(memo).toContain('12.34');
    expect(memo).toContain('A7KQ');
    expect(Buffer.byteLength(memo, 'utf8')).toBeLessThanOrEqual(MAX_MEMO_TEXT_BYTES);
  });

  it('always fits in 28 bytes, even for long names and large totals', () => {
    for (const name of [
      'A',
      'Café & Sons 🚀 Very Long Merchant Name Indeed',
      'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW',
    ]) {
      const memo = buildCheckoutMemo({
        merchantName: name,
        totalCents: 99_999_999,
        reference: 'S-999999',
        unique: 'ABCD',
      });
      expect(Buffer.byteLength(memo, 'utf8')).toBeLessThanOrEqual(MAX_MEMO_TEXT_BYTES);
      expect(memo.length).toBeGreaterThan(0);
    }
  });

  it('produces distinct memos for repeated checkouts of the same sale', () => {
    const input = { merchantName: 'Kofi Coffee', totalCents: 500, reference: 'S-000001' };
    const memos = new Set(Array.from({ length: 25 }, () => buildCheckoutMemo(input)));
    expect(memos.size).toBe(25);
  });

  it('is used by the checkout endpoint', async () => {
    const token = (await signUp()).token;
    const product = await createProduct(token, { priceCents: 1999 });
    const sale = await createSale(token, [{ productId: product.id, quantity: 1 }]);

    const res = await api()
      .post('/api/v1/payments/requests')
      .set(bearer(token))
      .send({ transactionId: sale.id })
      .expect(201);
    const memo = res.body.data.memo as string;
    expect(Buffer.byteLength(memo, 'utf8')).toBeLessThanOrEqual(28);
    expect(memo).toContain('19.99');
    expect(res.body.data.uri).toContain('memo=');
    expect(decodeURIComponent(res.body.data.uri.split('memo=')[1].split('&')[0])).toBe(memo);
  });
});
