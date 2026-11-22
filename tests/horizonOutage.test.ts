/**
 * Chaos tests: Horizon is unavailable or misbehaving. The network is faked at
 * @/services/horizon, so nothing here touches a real Stellar node.
 *
 * Expected behaviour under fault:
 * - no sale is completed or marked paid without a verified on-chain payment
 * - the watcher does not advance its cursor past payments it failed to process
 * - read-only endpoints degrade instead of corrupting state
 * - once Horizon recovers, the same payment settles normally
 */
import * as horizon from '@/services/horizon';
import { handleIncomingPayment } from '@/services/checkout.service';
import { pollOnce } from '@/services/paymentWatcher';
import { getDb } from '@/utils/database';
import {
  MERCHANT,
  PAYER,
  USDC_ISSUER,
  api,
  bearer,
  createProduct,
  createSale,
  signUp,
  useDatabase,
} from './helpers';

jest.mock('@/services/horizon');
const mocked = jest.mocked(horizon);

useDatabase();

const outage = () => new Error('connect ECONNREFUSED horizon-testnet.stellar.org:443');
const HASH = 'a'.repeat(64);

const payment = (txHash: string, amount = '12.5000000'): horizon.IncomingPayment => ({
  pagingToken: '1001',
  txHash,
  from: PAYER,
  to: MERCHANT,
  amount,
  assetCode: 'USDC',
  assetIssuer: USDC_ISSUER,
});

const tx = (hash: string, memo: string | null): horizon.TransactionInfo => ({
  hash,
  successful: true,
  memo,
  memoType: memo ? 'text' : 'none',
  sourceAccount: PAYER,
  createdAt: new Date().toISOString(),
});

const storedCursor = (): string | undefined =>
  (
    getDb().prepare("SELECT value FROM kv WHERE key = 'horizon_payments_cursor'").get() as
      { value: string } | undefined
  )?.value;

let token: string;
let productId: string;

beforeAll(async () => {
  token = (await signUp('Chaos Admin')).token;
  productId = (await createProduct(token, { priceCents: 1250, stock: 100 })).id;
});

beforeEach(() => {
  mocked.fetchTransaction.mockReset();
  mocked.fetchPaymentsInTransaction.mockReset();
  mocked.fetchPaymentsSince.mockReset();
  mocked.latestCursor.mockReset();
  mocked.loadBalances.mockReset();
});

async function openCheckout(): Promise<{ saleId: string; requestId: string; memo: string }> {
  const sale = await createSale(token, [{ productId, quantity: 1 }]);
  const res = await api()
    .post('/api/v1/payments/requests')
    .set(bearer(token))
    .send({ transactionId: sale.id })
    .expect(201);
  return { saleId: sale.id, requestId: res.body.data.id, memo: res.body.data.memo };
}

describe('watcher under Horizon outage', () => {
  it('does not advance the cursor when the poll fails', async () => {
    mocked.latestCursor.mockResolvedValue('500');
    mocked.fetchPaymentsSince.mockResolvedValueOnce({ payments: [], cursor: '500' });
    await pollOnce(MERCHANT);
    expect(storedCursor()).toBe('500');

    // pollOnce retries three times; keep the outage in place for every retry.
    mocked.fetchPaymentsSince.mockRejectedValue(outage());
    await expect(pollOnce(MERCHANT)).rejects.toThrow('ECONNREFUSED');
    expect(storedCursor()).toBe('500');
  });

  it('resumes from the same cursor after recovery and processes the missed payment', async () => {
    const { saleId, requestId, memo } = await openCheckout();
    const hash = 'c1'.repeat(32);

    mocked.fetchPaymentsSince.mockRejectedValueOnce(outage());
    await expect(pollOnce(MERCHANT)).rejects.toThrow();

    // Horizon is back: the payment is reported again from the untouched cursor.
    mocked.fetchPaymentsSince.mockResolvedValueOnce({
      payments: [payment(hash)],
      cursor: '1001',
    });
    mocked.fetchTransaction.mockResolvedValue(tx(hash, memo));
    const settled = await pollOnce(MERCHANT);

    expect(settled).toBe(1);
    expect(mocked.fetchPaymentsSince).toHaveBeenLastCalledWith(MERCHANT, '500');
    expect(storedCursor()).toBe('1001');
    const sale = await api().get(`/api/v1/transactions/${saleId}`).set(bearer(token));
    expect(sale.body.data.status).toBe('completed');
    const req = await api().get(`/api/v1/payments/requests/${requestId}`).set(bearer(token));
    expect(req.body.data.status).toBe('paid');
  });

  it('does not start a fresh watcher from "now" when the first lookup fails', async () => {
    getDb().prepare("DELETE FROM kv WHERE key = 'horizon_payments_cursor'").run();
    mocked.latestCursor.mockRejectedValueOnce(outage());

    await expect(pollOnce(MERCHANT)).rejects.toThrow('ECONNREFUSED');
    expect(storedCursor()).toBeUndefined();
    expect(mocked.fetchPaymentsSince).not.toHaveBeenCalled();
  });

  it('propagates a failed transaction lookup and leaves the checkout pending', async () => {
    const { requestId, memo } = await openCheckout();
    const hash = 'c2'.repeat(32);
    mocked.fetchTransaction.mockRejectedValueOnce(outage());

    await expect(handleIncomingPayment(payment(hash))).rejects.toThrow('ECONNREFUSED');
    const req = await api().get(`/api/v1/payments/requests/${requestId}`).set(bearer(token));
    expect(req.body.data.status).toBe('pending');
    expect(Buffer.byteLength(memo, 'utf8')).toBeLessThanOrEqual(28);
    expect(memo).toContain('12.50');
  });

  it('treats a transaction Horizon cannot find as not settling anything', async () => {
    const { requestId } = await openCheckout();
    mocked.fetchTransaction.mockResolvedValueOnce(null);

    expect(await handleIncomingPayment(payment('c3'.repeat(32)))).toBe(false);
    const req = await api().get(`/api/v1/payments/requests/${requestId}`).set(bearer(token));
    expect(req.body.data.status).toBe('pending');
  });
});

describe('checkout endpoints under Horizon outage', () => {
  it('does not complete a Stellar sale by hash while Horizon is down', async () => {
    const sale = await createSale(token, [{ productId, quantity: 1 }]);
    mocked.fetchTransaction.mockRejectedValueOnce(outage());
    mocked.fetchPaymentsInTransaction.mockRejectedValueOnce(outage());

    const res = await api()
      .post('/api/v1/payments')
      .set(bearer(token))
      .send({ transactionId: sale.id, method: 'stellar', stellarTxHash: HASH });

    expect(res.status).not.toBe(201);
    const saleNow = await api().get(`/api/v1/transactions/${sale.id}`).set(bearer(token));
    expect(saleNow.body.data.status).toBe('pending');
    const payments = await api().get(`/api/v1/payments/transaction/${sale.id}`).set(bearer(token));
    expect(payments.body.data.filter((p: { status: string }) => p.status === 'completed')).toEqual(
      [],
    );
  });

  it('does not mark a QR checkout paid when manual verification hits an outage', async () => {
    const { requestId } = await openCheckout();
    mocked.fetchTransaction.mockRejectedValueOnce(outage());

    const res = await api()
      .post(`/api/v1/payments/requests/${requestId}/verify`)
      .set(bearer(token))
      .send({ txHash: 'c4'.repeat(32) });

    expect(res.status).not.toBe(200);
    const req = await api().get(`/api/v1/payments/requests/${requestId}`).set(bearer(token));
    expect(req.body.data.status).toBe('pending');
  });

  it('keeps cash sales working while Horizon is down', async () => {
    mocked.fetchTransaction.mockRejectedValue(outage());
    const sale = await createSale(token, [{ productId, quantity: 1 }]);
    const res = await api()
      .post('/api/v1/payments')
      .set(bearer(token))
      .send({ transactionId: sale.id, method: 'cash', tenderedCents: 1250 })
      .expect(201);
    expect(res.body.data.transaction.status).toBe('completed');
  });

  it('reports wallet balances as an error, not as empty, when Horizon is down', async () => {
    mocked.loadBalances.mockRejectedValueOnce(outage());
    const res = await api().get('/api/v1/store/wallet').set(bearer(token));
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });

  it('still serves public store settings while Horizon is down', async () => {
    mocked.loadBalances.mockRejectedValue(outage());
    const res = await api().get('/api/v1/store').expect(200);
    expect(res.body.data.stellar.enabled).toBe(true);
    expect(res.body.data.stellar.merchantPublicKey).toBe(MERCHANT);
  });
});
