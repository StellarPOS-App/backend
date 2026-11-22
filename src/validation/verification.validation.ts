import Joi from 'joi';

export const confirmVerificationSchema = Joi.object({
  token: Joi.string().min(20).max(200).required(),
});
