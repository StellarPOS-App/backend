/**
 * Merchant email verification. The frontend links to
 * `${CLIENT_URL}/verify-email?token=...` and then posts the token to
 * /api/v1/verification/confirm. A signed-in merchant can request a fresh link
 * with /send or /resend when the original expires or is lost.
 */
import { Router } from 'express';
import { authenticate } from '@/middleware/auth.middleware';
import { AppError, notFound } from '@/middleware/error.middleware';
import { validateBody } from '@/middleware/validate.middleware';
import { UserModel } from '@/models/user.model';
import {
  canResendVerification,
  confirmVerification,
  isEmailVerified,
  sendVerificationEmail,
} from '@/services/verification.service';
import { asyncHandler, sendSuccess } from '@/utils/helpers';
import { confirmVerificationSchema } from '@/validation/verification.validation';

const router = Router();

const signedInUser = (userId: string) => {
  const user = UserModel.findById(userId);
  if (!user) throw notFound('User');
  return user;
};

/** Issues a verification link immediately (onboarding / manual reissue). */
router.post(
  '/send',
  authenticate,
  asyncHandler(async (req, res) => {
    const { expiresAt } = sendVerificationEmail(signedInUser(req.user!.sub));
    sendSuccess(res, { sent: true, expiresAt }, 202);
  }),
);

/** Resend endpoint with a short cooldown so the mail endpoint cannot be abused. */
router.post(
  '/resend',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = signedInUser(req.user!.sub);
    if (!canResendVerification(user.id)) {
      throw new AppError('Please wait before requesting another verification link', 429);
    }
    const { expiresAt } = sendVerificationEmail(user);
    sendSuccess(res, { sent: true, expiresAt }, 202);
  }),
);

/** Public: consumes a token from the email link. */
router.post(
  '/confirm',
  validateBody(confirmVerificationSchema),
  asyncHandler(async (req, res) => {
    const user = confirmVerification((req.body as { token: string }).token);
    sendSuccess(res, { verified: true, email: user.email });
  }),
);

router.get(
  '/status',
  authenticate,
  asyncHandler(async (req, res) => {
    sendSuccess(res, { verified: isEmailVerified(req.user!.sub) });
  }),
);

export default router;
