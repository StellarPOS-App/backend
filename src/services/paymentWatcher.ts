/**
 * Polls Horizon for payments to the merchant account and settles matching
 * QR checkouts, so a sale completes on its own seconds after the customer
 * pays, with nobody re-typing a hash. The cursor is persisted, so a restart
 * picks up where it left off and never double-processes a payment.
 */
import { config } from '@/config/config';
import { expireStaleRequests } from '@/services/checkout.service';
import * as horizon from '@/services/horizon';
import { dispatchPaymentConfirmation } from '@/services/paymentConfirmation';
import { getDb } from '@/utils/database';
import { logger } from '@/utils/logger';

const CURSOR_KEY = 'horizon_payments_cursor';

function readCursor(): string | null {
  const row = getDb().prepare('SELECT value FROM kv WHERE key = ?').get(CURSOR_KEY) as
    { value: string } | undefined;
  return row?.value ?? null;
}

function writeCursor(cursor: string): void {
  getDb()
    .prepare(
      'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(CURSOR_KEY, cursor);
}

/** One polling pass. Exported for tests and for manual triggering. */
export async function pollOnce(account: string, retries = 3): Promise<number> {
  let cursor = readCursor();
  if (!cursor) {
    cursor = await horizon.latestCursor(account);
    writeCursor(cursor);
  }
  let page;
  let attempt = 0;
  while (true) {
    try {
      page = await horizon.fetchPaymentsSince(account, cursor);
      break;
    } catch (err) {
      attempt++;
      if (attempt >= retries) throw err;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  let settled = 0;
  for (const payment of page.payments) {
    // Each confirmation is queued independently. Retries and the dead-letter
    // queue live in MemoryQueue, so one flaky Horizon call cannot strand a sale.
    if (await dispatchPaymentConfirmation(payment)) settled++;
  }
  if (page.cursor !== cursor) writeCursor(page.cursor);
  expireStaleRequests();
  return settled;
}

let timer: NodeJS.Timeout | null = null;

export function startPaymentWatcher(): void {
  const account = config.stellar.merchantPublicKey;
  if (!config.stellar.watcher.enabled || !account) {
    logger.info('Stellar payment watcher disabled (set STELLAR_MERCHANT_PUBLIC_KEY to enable)');
    return;
  }
  let running = false;
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 5;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await pollOnce(account);
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      logger.warn(
        `Payment watcher poll failed (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${(err as Error).message}`,
      );
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        logger.error(
          `Payment watcher exceeded max consecutive errors (${MAX_CONSECUTIVE_ERRORS}). Continuing retry on next cycle.`,
        );
      }
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, config.stellar.watcher.intervalMs);
  void tick();
  logger.info(
    `Watching ${account} for Stellar payments every ${config.stellar.watcher.intervalMs}ms`,
  );
}

export function stopPaymentWatcher(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
