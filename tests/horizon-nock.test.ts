/**
 * [TEST-008] Demonstrates the nock-based Horizon HTTP mock.
 *
 * These tests verify the helper utilities in horizon-mock.ts and confirm
 * that nock correctly intercepts outbound Horizon HTTP requests so payment
 * tests run offline and deterministically.
 */

import { get } from 'node:https';
import nock from 'nock';
import {
  mockHorizonPayments,
  mockHorizonTransaction,
  cleanHorizonMocks,
  assertAllHorizonMocksConsumed,
  type MockPayment,
  type MockTransaction,
} from './horizon-mock';

const MERCHANT = process.env.STELLAR_MERCHANT_PUBLIC_KEY ?? 'GDUMMY_MERCHANT';
const PAYER = 'GDUMMY_PAYER000000000000000000000000000000000000000000000000';
const HORIZON_BASE = process.env.STELLAR_HORIZON_URL ?? 'https://horizon-testnet.stellar.org';

afterEach(() => {
  cleanHorizonMocks();
});

function paymentRecord(overrides: Partial<MockPayment> = {}): MockPayment {
  return {
    id: '1',
    type: 'payment',
    paging_token: '1',
    transaction_hash: 'a'.repeat(64),
    from: PAYER,
    to: MERCHANT,
    amount: '12.5000000',
    asset_type: 'credit_alphanum4',
    asset_code: 'USDC',
    asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    ...overrides,
  };
}

function txRecord(overrides: Partial<MockTransaction> = {}): MockTransaction {
  return {
    hash: 'a'.repeat(64),
    successful: true,
    memo: 'S-000001',
    memo_type: 'text',
    source_account: PAYER,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

/** nock 13 intercepts node:http(s); undici's fetch is not interceptable there. */
function getJson(url: string): Promise<{ ok: boolean; json: () => Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode ?? 200;
        resolve({
          ok: status >= 200 && status < 300,
          json: async () => JSON.parse(text) as unknown,
        });
      });
    }).on('error', reject);
  });
}

describe('[TEST-008] nock Horizon mock helpers', () => {
  it('mockHorizonPayments intercepts the payments endpoint', async () => {
    const scope = mockHorizonPayments(MERCHANT, [paymentRecord()]);

    // Use node's built-in fetch (Node 18+) or a simple http.get to verify interception.
    const url = `${HORIZON_BASE}/accounts/${MERCHANT}/payments?limit=200&order=asc&cursor=0`;
    const res = await getJson(url);
    const body = (await res.json()) as { _embedded: { records: MockPayment[] } };

    expect(res.ok).toBe(true);
    expect(body._embedded.records).toHaveLength(1);
    expect(body._embedded.records[0].amount).toBe('12.5000000');
    expect(scope.isDone()).toBe(true);
  });

  it('mockHorizonTransaction intercepts the transaction endpoint', async () => {
    const tx = txRecord();
    const scope = mockHorizonTransaction(tx);

    const url = `${HORIZON_BASE}/transactions/${tx.hash}`;
    const res = await getJson(url);
    const body = (await res.json()) as MockTransaction;

    expect(res.ok).toBe(true);
    expect(body.successful).toBe(true);
    expect(body.memo).toBe('S-000001');
    expect(scope.isDone()).toBe(true);
  });

  it('cleanHorizonMocks removes all active interceptors', async () => {
    mockHorizonPayments(MERCHANT, [paymentRecord()]);
    cleanHorizonMocks();

    // After cleaning, nock should not intercept — the real network would be hit,
    // but nock.disableNetConnect guards this in CI. We just check no pending mocks.
    expect(nock.pendingMocks()).toHaveLength(0);
  });

  it('assertAllHorizonMocksConsumed throws when a mock was not used', () => {
    mockHorizonPayments(MERCHANT, [paymentRecord()]);
    // Do NOT make the HTTP call — mock should remain pending.
    expect(() => assertAllHorizonMocksConsumed()).toThrow('Unused Horizon mock interceptors');
    cleanHorizonMocks(); // clean up so afterEach doesn't double-throw
  });

  it('a failed transaction mock returns successful: false', async () => {
    const tx = txRecord({ successful: false });
    mockHorizonTransaction(tx);

    const url = `${HORIZON_BASE}/transactions/${tx.hash}`;
    const res = await getJson(url);
    const body = (await res.json()) as MockTransaction;

    expect(body.successful).toBe(false);
  });
});
