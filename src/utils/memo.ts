/**
 * Stellar MEMO_TEXT values are limited to 28 bytes. A bare reference (or a
 * random token) is unique but tells a customer nothing when they look at their
 * wallet history. These helpers build a compact, human-readable memo that
 * carries the merchant name and the order total while keeping the uniqueness
 * needed to match an incoming payment back to its checkout.
 */
import { randomToken } from '@/utils/helpers';

export const MAX_MEMO_TEXT_BYTES = 28;

const byteLength = (value: string) => Buffer.byteLength(value, 'utf8');

const ascii = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // drop accents: Café -> Cafe
    .replace(/[^A-Za-z0-9& ]/g, '') // no punctuation/emoji in a memo tag
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();

export interface CheckoutMemoInput {
  merchantName: string;
  /** Store-currency total in cents. */
  totalCents: number;
  /** Human-facing sale reference, e.g. S-000001. */
  reference: string;
  /** Random part that keeps checkouts for the same sale distinct. */
  unique?: string;
}

/**
 * Builds e.g. "CAFE & SONS 12.34 000001-A7KQ" (fits in 28 bytes).
 * Merchant name is trimmed first, then the reference/amount, so the price and
 * a unique suffix always survive; the result is guaranteed <= 28 bytes.
 */
export function buildCheckoutMemo(input: CheckoutMemoInput): string {
  const unique = input.unique ?? randomToken(4);
  let merchant = ascii(input.merchantName) || 'STORE';
  const amount = (Math.max(0, input.totalCents) / 100).toFixed(2);
  let ref = `${ascii(input.reference) || 'ORDER'}`.slice(-5);

  // Reserve space for the unique suffix and separators first.
  const tail = `-${unique}`;
  const minRef = Math.min(ref.length, 4);
  while (true) {
    const suffix = `${ref}${tail}`;
    if (byteLength(`${merchant} ${amount} ${suffix}`) <= MAX_MEMO_TEXT_BYTES) break;
    if (merchant.length > 1) merchant = merchant.slice(0, -1);
    else if (ref.length > minRef) ref = ref.slice(0, -1);
    else if (amount.length > 1)
      break; // amount is already the smallest form
    else break;
  }

  const memo = `${merchant} ${amount} ${ref}${tail}`;
  if (byteLength(memo) > MAX_MEMO_TEXT_BYTES) {
    // Extremely large amounts: keep the unique suffix and fall back to a
    // byte-safe truncation so we never exceed Stellar's 28-byte limit.
    const keep = MAX_MEMO_TEXT_BYTES - byteLength(tail);
    return `${Buffer.from(`${merchant} ${amount}`).subarray(0, Math.max(0, keep)).toString('utf8').trim()}${tail}`;
  }
  return memo;
}
