import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { randomBytes, randomUUID } from 'node:crypto';

export const newId = (): string => randomUUID();

/** Wraps an async handler so rejections reach the error middleware. */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

function formatDatesToIso(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (obj instanceof Date) return obj.toISOString();
  if (Array.isArray(obj)) return obj.map(formatDatesToIso);
  if (typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (
        (k.endsWith('At') ||
          k.endsWith('Date') ||
          k === 'created_at' ||
          k === 'updated_at' ||
          k === 'completed_at') &&
        typeof v === 'number'
      ) {
        out[k] = new Date(v > 1_000_000_000_000 ? v : v * 1000).toISOString();
      } else {
        out[k] = formatDatesToIso(v);
      }
    }
    return out;
  }
  return obj;
}

export function sendSuccess<T>(res: Response, data: T, statusCode = 200): Response {
  return res.status(statusCode).json({ success: true, data: formatDatesToIso(data) });
}

export function sendError(res: Response, message: string, statusCode = 400): Response {
  return res.status(statusCode).json({ success: false, error: message });
}

export interface Pagination {
  page: number;
  limit: number;
  offset: number;
}

export function parsePagination(query: Request['query'], maxLimit = 100): Pagination {
  const page = Math.max(1, Number.parseInt(String(query.page ?? '1'), 10) || 1);
  const rawLimit = Number.parseInt(String(query.limit ?? '20'), 10) || 20;
  const limit = Math.min(Math.max(1, rawLimit), maxLimit);
  return { page, limit, offset: (page - 1) * limit };
}

export function paginatedResponse<T>(
  res: Response,
  items: T[],
  total: number,
  { page, limit }: Pagination,
  /** Optional keyset metadata so clients can switch to cursor pagination. */
  extra: { nextCursor?: string | null; hasMore?: boolean } = {},
): Response {
  return res.json({
    success: true,
    data: items,
    pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)), ...extra },
  });
}

/** Cursor-based pagination using created_at + a stable tie-breaker (#130). */
export function encodeCursor(item: {
  createdAt?: string;
  created_at?: string;
  id: string;
  /** Used as tie-breaker when the ordering is by reference (transactions). */
  reference?: string;
}): string {
  const ts = item.createdAt ?? item.created_at ?? '';
  const tieBreaker = item.reference ?? item.id;
  return Buffer.from(`${ts}:${tieBreaker}`).toString('base64');
}

export function decodeCursor(cursorStr?: string): { createdAt: string; id: string } | undefined {
  if (!cursorStr) return undefined;
  try {
    const raw = Buffer.from(cursorStr, 'base64').toString('utf8');
    // SQLite datetime strings contain ':' (HH:MM:SS), so split on the *last*
    // separator instead of the first one.
    const separator = raw.lastIndexOf(':');
    if (separator <= 0 || separator === raw.length - 1) return undefined;
    return { createdAt: raw.slice(0, separator), id: raw.slice(separator + 1) };
  } catch {
    return undefined;
  }
}

export function cursorPaginatedResponse<
  T extends { id: string; createdAt?: string; created_at?: string },
>(res: Response, items: T[], limit: number, page = 1): Response {
  const hasNext = items.length > limit;
  const sliced = hasNext ? items.slice(0, limit) : items;
  const nextCursor = hasNext && sliced.length > 0 ? encodeCursor(sliced[sliced.length - 1]) : null;
  return res.json({
    success: true,
    data: sliced,
    pagination: {
      page,
      limit,
      nextCursor,
      hasMore: hasNext,
    },
  });
}

/** Clamps an optional numeric query param into [min, max]. */
export function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** Uppercase base32 token without ambiguous characters (no 0/O, 1/I/L). */
export function randomToken(length: number): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/** SQL LIKE pattern with %, _ and \ escaped. Use with ESCAPE '\'. */
export const likePattern = (term: string): string => `%${term.replace(/[\\%_]/g, '\\$&')}%`;
