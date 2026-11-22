/**
 * Processing fees for transactions, derived from FEE_RATE_BPS.
 *
 * All arithmetic is integer-only (cents via BigInt, Stellar amounts via
 * stroops). JavaScript floating point is never used for a monetary amount,
 * which is what previously turned 2.5% of $10.00 into $0.24999999.
 */
import { config } from '@/config/config';
import { feeCents, feeForAmount } from '@/utils/money';

/** Fee for a store-currency amount in integer cents. */
export function processingFeeCents(amountCents: number): number {
  return feeCents(amountCents, config.store.feeRateBps);
}

/** Fee for a Stellar amount string in integer stroops. */
export function processingFeeStroops(amount: string): bigint {
  return feeForAmount(amount, config.store.feeRateBps);
}
