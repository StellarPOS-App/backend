import Joi from 'joi';
import { isValidPublicKey } from '@/services/stellar.service';
import { stellarTextMemo } from '@/validation/stellar.validation';

export const createWithdrawalSchema = Joi.object({
  destination: Joi.string()
    .trim()
    .required()
    .custom((value: string, helpers) =>
      isValidPublicKey(value) ? value : helpers.error('stellar.address'),
    )
    .messages({ 'stellar.address': 'destination must be a valid Stellar public key' }),
  assetCode: Joi.string().trim().min(1).max(12).default('XLM'),
  assetIssuer: Joi.string()
    .trim()
    .custom((value: string, helpers) =>
      isValidPublicKey(value) ? value : helpers.error('stellar.address'),
    )
    .messages({ 'stellar.address': 'assetIssuer must be a valid Stellar public key' })
    .when('assetCode', {
      is: 'XLM',
      then: Joi.forbidden(),
      otherwise: Joi.required(),
    }),
  // Stellar amounts have at most seven decimal places.
  amount: Joi.string()
    .pattern(/^(0|[1-9]\d*)(\.\d{1,7})?$/)
    .custom((value: string, helpers) =>
      Number(value) > 0 ? value : helpers.error('number.positive'),
    )
    .required(),
  memo: stellarTextMemo.default(''),
});
