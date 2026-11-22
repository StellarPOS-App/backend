/**
 * Stellar MEMO_TEXT is capped at 28 bytes (not 28 characters) and must be
 * valid UTF-8. Enforcing that at the API boundary avoids a cryptic failure
 * later, when a wallet builds and submits the transaction envelope.
 */
import { AppError } from '@/middleware/error.middleware';

export const MEMO_TEXT_MAX_BYTES = 28;

export const memoByteLength = (memo: string): number => Buffer.byteLength(memo, 'utf8');

export interface MemoValidation {
  valid: boolean;
  bytes: number;
  reason?: string;
}

/** Non-throwing check, used by Joi custom validators. */
export function checkStellarMemo(memo: unknown): MemoValidation {
  if (typeof memo !== 'string') {
    return { valid: false, bytes: 0, reason: 'memo must be a string' };
  }
  const bytes = memoByteLength(memo);
  if (bytes > MEMO_TEXT_MAX_BYTES) {
    return {
      valid: false,
      bytes,
      reason: `memo is ${bytes} bytes; Stellar MEMO_TEXT allows at most ${MEMO_TEXT_MAX_BYTES} bytes`,
    };
  }
  for (const ch of memo) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      return { valid: false, bytes, reason: 'memo contains control characters' };
    }
  }
  return { valid: true, bytes };
}

/** Throwing guard for the point where a memo is put into a Stellar payment URI. */
export function validateStellarMemo(memo: string, label = 'Memo'): string {
  const result = checkStellarMemo(memo);
  if (!result.valid) {
    throw new AppError(`${label}: ${result.reason}`, 400, true, {
      bytes: result.bytes,
      maxBytes: MEMO_TEXT_MAX_BYTES,
    });
  }
  return memo;
}
