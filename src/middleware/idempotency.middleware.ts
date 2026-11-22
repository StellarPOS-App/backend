/**
 * Idempotency keys for mutating endpoints (notably order creation).
 *
 * A client that times out and retries `POST /api/orders` with the same
 * `Idempotency-Key` gets the original response replayed instead of creating a
 * second order (and charging the customer twice). Keys are scoped to the
 * authenticated user and route, and expire after 24 hours.
 *
 * The store is SQLite rather than a process-local Map so dedup also survives
 * a server restart, and the primary key makes concurrent retries safe.
 */
import { createHash } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError } from '@/middleware/error.middleware';
import { getDb } from '@/utils/database';
import { logger } from '@/utils/logger';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
const REPLAY_HEADER = 'Idempotency-Replayed';
const MAX_KEY_LENGTH = 255;

interface StoredResponse {
  request_hash: string;
  status: number;
  body: string;
  expires_at: string;
}

export interface IdempotencyOptions {
  /** Additional namespace; defaults to the request path. */
  scope?: string;
  /** Reject requests with no header instead of passing them through. */
  required?: boolean;
}

function header(req: Request): string | undefined {
  const value = req.headers[IDEMPOTENCY_HEADER];
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' ? raw.trim() : undefined;
}

function fingerprint(req: Request): string {
  return createHash('sha256')
    .update(`${req.method} ${req.originalUrl.split('?')[0]}\0`)
    .update(JSON.stringify(req.body ?? null))
    .digest('hex');
}

export function idempotency(options: IdempotencyOptions = {}): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = header(req);
    if (!key) {
      if (options.required) {
        next(new AppError('Idempotency-Key header is required', 400));
        return;
      }
      next();
      return;
    }
    if (!key || key.length > MAX_KEY_LENGTH || /[\r\n]/.test(key)) {
      next(new AppError('Invalid Idempotency-Key header', 400));
      return;
    }

    const scope = `${req.user?.sub ?? 'anonymous'}|${options.scope ?? req.originalUrl.split('?')[0]}`;
    const hash = fingerprint(req);
    const db = getDb();
    const now = new Date().toISOString();

    // Opportunistic cleanup; the table stays tiny and the index makes it cheap.
    db.prepare('DELETE FROM idempotency_keys WHERE expires_at <= ?').run(now);

    const existing = db
      .prepare(
        'SELECT request_hash, status, body FROM idempotency_keys WHERE scope = ? AND key = ?',
      )
      .get(scope, key) as Omit<StoredResponse, 'expires_at'> | undefined;

    if (existing) {
      if (existing.request_hash !== hash) {
        next(new AppError('Idempotency-Key was already used with a different request body', 409));
        return;
      }
      res.setHeader(REPLAY_HEADER, 'true');
      res.setHeader('Idempotency-Key', key);
      // Replay as 200: the original operation already succeeded.
      res.status(200).json(JSON.parse(existing.body) as unknown);
      return;
    }

    // Capture the handler's response so the exact body can be replayed later.
    const originalJson = res.json.bind(res);
    let captured = false;
    res.json = ((body: unknown) => {
      if (!captured) {
        captured = true;
        try {
          if (res.statusCode < 400) {
            const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_SECONDS * 1000).toISOString();
            db.prepare(
              `INSERT OR IGNORE INTO idempotency_keys
                 (scope, key, request_hash, status, body, expires_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
            ).run(scope, key, hash, res.statusCode, JSON.stringify(body), expiresAt);

            // A concurrent retry won the insert: replay the stored result.
            const winner = db
              .prepare('SELECT body FROM idempotency_keys WHERE scope = ? AND key = ?')
              .get(scope, key) as { body: string } | undefined;
            if (winner) {
              res.setHeader(REPLAY_HEADER, 'true');
              return originalJson(JSON.parse(winner.body) as unknown);
            }
          }
        } catch (err) {
          // Dedup storage must never turn a successful order into a 500.
          logger.warn(`Could not store idempotency result: ${(err as Error).message}`);
        }
      }
      return originalJson(body);
    }) as Response['json'];

    res.setHeader(REPLAY_HEADER, 'false');
    next();
  };
}
