/**
 * Webhook delivery log endpoints (ENH-012, issue #138).
 *
 * Gives admins and managers visibility into outbound webhook attempts —
 * whether they succeeded, what the response was, and how many retries
 * were needed.  All writes happen from the internal webhook dispatcher;
 * these routes are read-only.
 */
import { Router } from 'express';
import { authenticate, authorize } from '@/middleware/auth.middleware';
import { getDb } from '@/utils/database';
import { asyncHandler, paginatedResponse, parsePagination } from '@/utils/helpers';

const router = Router();
router.use(authenticate, authorize('admin', 'manager'));

export type WebhookDeliveryStatus = 'pending' | 'success' | 'failed';

export const WEBHOOK_RETRY_INTERVALS = [60_000, 300_000, 1_800_000]; // 1m, 5m, 30m (#122)

export async function dispatchWebhookWithRetry(
  url: string,
  event: string,
  payload: unknown,
  attempt = 1,
): Promise<void> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, payload }),
    });
    if (!res.ok && attempt <= 3) {
      const delay = WEBHOOK_RETRY_INTERVALS[attempt - 1] ?? 60_000;
      setTimeout(
        () => void dispatchWebhookWithRetry(url, event, payload, attempt + 1),
        delay,
      ).unref();
    }
  } catch {
    if (attempt <= 3) {
      const delay = WEBHOOK_RETRY_INTERVALS[attempt - 1] ?? 60_000;
      setTimeout(
        () => void dispatchWebhookWithRetry(url, event, payload, attempt + 1),
        delay,
      ).unref();
    }
  }
}

export interface WebhookDeliveryLog {
  id: string;
  event: string;
  url: string;
  status: WebhookDeliveryStatus;
  httpStatus: number | null;
  attempt: number;
  durationMs: number | null;
  requestBody: string | null;
  responseBody: string | null;
  error: string | null;
  createdAt: string;
}

/**
 * GET /api/v1/webhooks/deliveries
 * List delivery log entries, newest first. Filterable by event and status.
 */
router.get(
  '/deliveries',
  asyncHandler(async (req, res) => {
    const page = parsePagination(req.query, 200);
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    const params: string[] = [];

    if (req.query.event) {
      clauses.push('event = ?');
      params.push(String(req.query.event));
    }
    if (req.query.status) {
      clauses.push('status = ?');
      params.push(String(req.query.status));
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const db = getDb();

    const total: number = (
      db.prepare(`SELECT COUNT(*) AS n FROM webhook_delivery_logs ${where}`).get(...params) as {
        n: number;
      }
    ).n;

    const rows = db
      .prepare(
        `SELECT id, event, url, status, http_status, attempt, duration_ms,
                request_body, response_body, error, created_at
         FROM webhook_delivery_logs
         ${where}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, page.limit, page.offset) as Array<Record<string, unknown>>;

    const logs: WebhookDeliveryLog[] = rows.map((r) => ({
      id: r.id as string,
      event: r.event as string,
      url: r.url as string,
      status: r.status as WebhookDeliveryStatus,
      httpStatus: r.http_status as number | null,
      attempt: r.attempt as number,
      durationMs: r.duration_ms as number | null,
      requestBody: r.request_body as string | null,
      responseBody: r.response_body as string | null,
      error: r.error as string | null,
      createdAt: r.created_at as string,
    }));

    paginatedResponse(res, logs, total, page);
  }),
);

/**
 * GET /api/v1/webhooks/deliveries/:id
 * Fetch a single delivery log entry by id.
 */
router.get(
  '/deliveries/:id',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT id, event, url, status, http_status, attempt, duration_ms,
                request_body, response_body, error, created_at
         FROM webhook_delivery_logs WHERE id = ?`,
      )
      .get(req.params.id) as Record<string, unknown> | undefined;

    if (!row) {
      res.status(404).json({ success: false, error: 'Delivery log not found' });
      return;
    }

    res.json({
      success: true,
      data: {
        id: row.id,
        event: row.event,
        url: row.url,
        status: row.status,
        httpStatus: row.http_status,
        attempt: row.attempt,
        durationMs: row.duration_ms,
        requestBody: row.request_body,
        responseBody: row.response_body,
        error: row.error,
        createdAt: row.created_at,
      } as WebhookDeliveryLog,
    });
  }),
);

export default router;
