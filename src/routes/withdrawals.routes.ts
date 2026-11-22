/**
 * Stellar withdrawals (money out). Every route here is gated by KYC: a merchant
 * may not move funds off the platform until compliance has approved them.
 */
import { Router } from 'express';
import { authenticate, authorize } from '@/middleware/auth.middleware';
import { requireApprovedKyc } from '@/middleware/kyc.middleware';
import { notFound } from '@/middleware/error.middleware';
import { validateBody } from '@/middleware/validate.middleware';
import { WithdrawalModel } from '@/models/withdrawal.model';
import { asyncHandler, sendSuccess } from '@/utils/helpers';
import { createWithdrawalSchema } from '@/validation/withdrawal.validation';

const router = Router();
// Order matters: authenticate first, then the compliance gate.
router.use(authenticate, authorize('admin', 'manager'), requireApprovedKyc);

router.post(
  '/',
  validateBody(createWithdrawalSchema),
  asyncHandler(async (req, res) => {
    const withdrawal = WithdrawalModel.create({
      userId: req.user!.sub,
      destination: req.body.destination,
      assetCode: req.body.assetCode,
      assetIssuer: req.body.assetIssuer ?? null,
      amount: req.body.amount,
      memo: req.body.memo,
    });
    sendSuccess(res, withdrawal, 201);
  }),
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    sendSuccess(res, WithdrawalModel.listForUser(req.user!.sub));
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const withdrawal = WithdrawalModel.findById(req.params.id);
    if (!withdrawal || withdrawal.userId !== req.user!.sub) throw notFound('Withdrawal');
    sendSuccess(res, withdrawal);
  }),
);

export default router;
