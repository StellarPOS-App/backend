/**
 * Durable (in-process) confirmation pipeline for incoming Stellar payments.
 *
 * Every payment reported by the watcher goes through the `payments` queue. The
 * queue retries transient Horizon failures with exponential backoff and moves
 * jobs that exhaust their attempts to the dead-letter list, where an admin can
 * inspect and requeue them via /api/v1/queues/dead-letters. Previously a single
 * failure left the customer's sale in `pending` with no trace to act on.
 */
import { handleIncomingPayment } from '@/services/checkout.service';
import type { IncomingPayment } from '@/services/horizon';
import { logger } from '@/utils/logger';
import {
  getQueue,
  PAYMENT_CONFIRMATION_ATTEMPTS,
  PAYMENT_CONFIRMATION_BACKOFF_MS,
  queuesReady,
  type MemoryQueue,
} from '@/utils/queue';

export const PAYMENT_CONFIRMATION_QUEUE = 'payments';

let registeredQueue: MemoryQueue<IncomingPayment> | null = null;

/** Registers the processor. Safe to call more than once. */
export function startPaymentConfirmationWorker(): void {
  const queue = getQueue<IncomingPayment>(PAYMENT_CONFIRMATION_QUEUE);
  if (registeredQueue === queue) return;
  registeredQueue = queue;
  queue.process(async (payment) => {
    const settled = await handleIncomingPayment(payment);
    logger.debug(
      `Payment confirmation for ${payment.txHash} ${settled ? 'settled a checkout' : 'did not match a checkout'}`,
    );
  });
}

/**
 * Hands a payment to the queue, or confirms it inline when the queue subsystem
 * is not running (scripts and unit tests call the watcher directly).
 * Returns whether the payment settled a checkout; in queued mode the real
 * result is known only once the worker runs, so `true` means "accepted".
 */
export async function dispatchPaymentConfirmation(payment: IncomingPayment): Promise<boolean> {
  if (!queuesReady()) return handleIncomingPayment(payment);
  // Never enqueue into a queue with no processor: those jobs would sit in the
  // waiting list forever without ever reaching the dead-letter list.
  startPaymentConfirmationWorker();
  getQueue<IncomingPayment>(PAYMENT_CONFIRMATION_QUEUE).add(payment, {
    attempts: PAYMENT_CONFIRMATION_ATTEMPTS,
    backoffMs: PAYMENT_CONFIRMATION_BACKOFF_MS,
  });
  return true;
}
