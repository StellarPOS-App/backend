/**
 * Order (sale) creation. `POST /api/orders` is the merchant-facing alias of
 * `POST /api/transactions`; a retry after a client timeout must not create a
 * second order or bill the customer twice.
 */
import { Router } from 'express';
import { authenticate } from '@/middleware/auth.middleware';
import { idempotency } from '@/middleware/idempotency.middleware';
import { validateBody } from '@/middleware/validate.middleware';
import { TransactionModel } from '@/models/transaction.model';
import { asyncHandler, sendSuccess } from '@/utils/helpers';
import { createSaleSchema } from '@/validation/transaction.validation';

const router = Router();
router.use(authenticate);

router.post(
  '/',
  validateBody(createSaleSchema),
  idempotency({ scope: 'orders:create' }),
  asyncHandler(async (req, res) => {
    const order = TransactionModel.createSale({ ...req.body, userId: req.user!.sub });
    sendSuccess(res, { ...order, items: TransactionModel.findItemsByTransactionId(order.id) }, 201);
  }),
);

export default router;
