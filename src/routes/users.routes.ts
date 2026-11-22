import { Router, type NextFunction, type Request, type Response } from 'express';
import * as auth from '@/controllers/auth.controller';
import * as gdpr from '@/controllers/gdpr.controller';
import { authenticate, authorize } from '@/middleware/auth.middleware';
import { AppError, notFound } from '@/middleware/error.middleware';
import { validateBody } from '@/middleware/validate.middleware';
import { UserModel } from '@/models/user.model';
import { asyncHandler, sendSuccess } from '@/utils/helpers';
import { createStaffSchema, updateKycSchema, updateRoleSchema } from '@/validation/auth.validation';

const router = Router();
router.use(authenticate);

const adminOnly = authorize('admin');

/** The user named in the path may act on their own data; an admin may act on anyone's. */
const selfOrAdmin = (req: Request, _res: Response, next: NextFunction): void => {
  if (!req.user) return next(new AppError('Authentication required', 401));
  if (req.user.role === 'admin' || req.user.sub === req.params.id) return next();
  next(new AppError('You do not have permission to do that', 403));
};

router.get('/', adminOnly, asyncHandler(auth.listStaff));
router.post('/', adminOnly, validateBody(createStaffSchema), asyncHandler(auth.createStaff));
router.patch(
  '/:id/role',
  adminOnly,
  validateBody(updateRoleSchema),
  asyncHandler(auth.updateStaffRole),
);

/** Compliance decision. Only admins may record a KYC outcome. */
router.patch(
  '/:id/kyc',
  adminOnly,
  validateBody(updateKycSchema),
  asyncHandler(async (req, res) => {
    const user = UserModel.findById(req.params.id);
    if (!user) throw notFound('User');
    UserModel.updateKycStatus(user.id, req.body.status);
    sendSuccess(res, UserModel.findById(user.id));
  }),
);

// GDPR erasure (issue #213). Returns a receipt with a digest over the affected record ids.
router.delete('/:id/data', selfOrAdmin, asyncHandler(gdpr.eraseUser));
router.get('/:id/data/receipts/:receiptId', selfOrAdmin, asyncHandler(gdpr.getErasureReceipt));
router.get('/', asyncHandler(auth.listStaff));
router.post('/', validateBody(createStaffSchema), asyncHandler(auth.createStaff));
router.patch('/:id/role', validateBody(updateRoleSchema), asyncHandler(auth.updateStaffRole));
router.delete('/:id', asyncHandler(auth.deactivateStaff));

export default router;
