import { handleIncomingPayment } from '@/services/checkout.service';
import {
  dispatchPaymentConfirmation,
  startPaymentConfirmationWorker,
} from '@/services/paymentConfirmation';
import type { IncomingPayment } from '@/services/horizon';
import { closeQueues, listDeadLetters, setupQueues } from '@/utils/queue';

jest.mock('@/services/checkout.service', () => ({ handleIncomingPayment: jest.fn() }));
const confirm = jest.mocked(handleIncomingPayment);

const payment: IncomingPayment = {
  pagingToken: '100',
  txHash: 'ab'.repeat(32),
  from: 'GCUSTOMER',
  to: 'GMERCHANT',
  amount: '10.0000000',
  assetCode: 'USDC',
  assetIssuer: 'GISSUER',
};

describe('payment confirmation queue', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    confirm.mockReset();
    setupQueues();
    startPaymentConfirmationWorker();
  });

  afterEach(() => {
    closeQueues();
    jest.useRealTimers();
  });

  it('retries a failing confirmation and keeps it for manual review', async () => {
    confirm.mockRejectedValue(new Error('Horizon is down'));

    await dispatchPaymentConfirmation(payment);
    await jest.runAllTimersAsync();
    await Promise.resolve();

    // 1 initial attempt + 3 retries, as required for payment confirmations.
    expect(confirm).toHaveBeenCalledTimes(4);
    const dead = listDeadLetters('payments');
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({
      queue: 'payments',
      data: payment,
      error: 'Horizon is down',
      attempts: 4,
    });
    expect(dead[0].id).toBeDefined();
  });

  it('does not dead-letter a job that settles on a later attempt', async () => {
    confirm.mockRejectedValueOnce(new Error('transient')).mockResolvedValue(true);

    await dispatchPaymentConfirmation(payment);
    await jest.runAllTimersAsync();
    await Promise.resolve();

    expect(confirm).toHaveBeenCalledTimes(2);
    expect(listDeadLetters('payments')).toHaveLength(0);
  });
});
