import Joi from 'joi';
import { checkStellarMemo } from '@/utils/stellarMemo';

/**
 * Joi flavour of the Stellar MEMO_TEXT check. Counts UTF-8 bytes rather than
 * characters so multi-byte scripts cannot exceed the 28-byte protocol limit.
 */
export const stellarTextMemo = Joi.string()
  .allow('')
  .custom((value: string, helpers) => {
    const result = checkStellarMemo(value);
    if (!result.valid) {
      return helpers.error('stellar.memo', { reason: result.reason, bytes: result.bytes });
    }
    return value;
  })
  .messages({
    'stellar.memo': '{{#label}}: {{#reason}}',
  });
