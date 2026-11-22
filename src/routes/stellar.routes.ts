/**
 * Stellar account management routes (#145).
 *
 * Allows authenticated staff to link or unlink a Stellar public key to their
 * account, and to query live balances via Horizon for a linked or arbitrary
 * public key.
 */
import { Router } from 'express';
import Joi from 'joi';
import { authenticate } from '@/middleware/auth.middleware';
import { AppError } from '@/middleware/error.middleware';
import { validateBody } from '@/middleware/validate.middleware';
import { getAccountBalances, isValidPublicKey } from '@/services/stellar.service';
import { getDb } from '@/utils/database';
import { asyncHandler, sendSuccess } from '@/utils/helpers';

const router = Router();
router.use(authenticate);

const linkSchema = Joi.object({
  publicKey: Joi.string()
    .custom((value, helpers) => {
      if (!isValidPublicKey(value)) return helpers.error('any.invalid');
      return value;
    })
    .required()
    .messages({ 'any.invalid': 'publicKey must be a valid Stellar Ed25519 public key' }),
});

/** GET /api/v1/stellar/account — return the caller's linked Stellar public key and live balances */
router.get(
  '/account',
  asyncHandler(async (req, res) => {
    const row = getDb()
      .prepare('SELECT stellar_public_key FROM user_stellar WHERE user_id = ?')
      .get(req.user!.sub) as { stellar_public_key: string } | undefined;

    if (!row) {
      sendSuccess(res, { linked: false, publicKey: null, balances: [] });
      return;
    }

    const balances = await getAccountBalances(row.stellar_public_key).catch(() => []);
    sendSuccess(res, { linked: true, publicKey: row.stellar_public_key, balances });
  }),
);

/** POST /api/v1/stellar/account/link — link a Stellar public key to the caller's account */
router.post(
  '/account/link',
  validateBody(linkSchema),
  asyncHandler(async (req, res) => {
    const { publicKey } = req.body as { publicKey: string };
    const db = getDb();
    db.prepare(
      `INSERT INTO user_stellar (user_id, stellar_public_key) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET stellar_public_key = excluded.stellar_public_key,
       linked_at = datetime('now')`,
    ).run(req.user!.sub, publicKey);
    sendSuccess(res, { linked: true, publicKey });
  }),
);

/** DELETE /api/v1/stellar/account/link — unlink the caller's Stellar public key */
router.delete(
  '/account/link',
  asyncHandler(async (req, res) => {
    const result = getDb().prepare('DELETE FROM user_stellar WHERE user_id = ?').run(req.user!.sub);
    if (result.changes === 0) throw new AppError('No Stellar account linked', 404);
    sendSuccess(res, { linked: false });
  }),
);

/** GET /api/v1/stellar/balances/:publicKey — query live balances for any public key */
router.get(
  '/balances/:publicKey',
  asyncHandler(async (req, res) => {
    if (!isValidPublicKey(req.params.publicKey)) {
      throw new AppError('Invalid Stellar public key', 400);
    }
    const balances = await getAccountBalances(req.params.publicKey);
    sendSuccess(res, { publicKey: req.params.publicKey, balances });
  }),
);

export default router;
