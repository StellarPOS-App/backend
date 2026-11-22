/**
 * Compliance gate for money-out endpoints.
 *
 * Withdrawals may only be initiated by a merchant whose KYC verification has
 * been approved. The status is re-read from the database on every request, so
 * an approval (or revocation) takes effect immediately even for a session
 * whose JWT was signed before the change.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError } from '@/middleware/error.middleware';
import { UserModel } from '@/models/user.model';

export const KYC_REQUIRED_MESSAGE =
  "KYC verification is not approved. Withdrawals are blocked until your KYC status is 'approved'.";

export const requireApprovedKyc: RequestHandler = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  if (!req.user) {
    next(new AppError('Authentication required', 401));
    return;
  }

  const status = UserModel.kycStatus(req.user.sub);
  if (status !== 'approved') {
    next(
      new AppError(KYC_REQUIRED_MESSAGE, 403, true, {
        kycStatus: status ?? 'pending',
      }),
    );
    return;
  }

  // Keep the request context in sync with the authoritative database value.
  req.user.kycStatus = status;
  next();
};
