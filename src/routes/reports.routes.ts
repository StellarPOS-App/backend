/**
 * Streaming report exports (#OOM).
 *
 * A single `SELECT ... .all()` over the whole transactions table used to build
 * the entire CSV in memory: past ~10k rows Node ran out of heap, the response
 * never completed and the client only saw a timeout. This endpoint instead
 * walks a keyset cursor `(created_at, id)` in small batches and writes each
 * batch straight to the response, honouring backpressure. Peak memory is one
 * batch, regardless of how many transactions exist.
 */
import { Router, type Response } from 'express';
import { authenticate, authorize } from '@/middleware/auth.middleware';
import { badRequest } from '@/middleware/error.middleware';
import { processingFeeCents } from '@/services/fees.service';
import { getDb } from '@/utils/database';
import { csvLine } from '@/utils/csv';
import { asyncHandler, boundedInt } from '@/utils/helpers';
import { logger } from '@/utils/logger';

const router = Router();
router.use(authenticate, authorize('admin', 'manager'));

const BATCH_SIZE = 500;
const MAX_ROWS = 1_000_000;

type ReportType = 'transactions' | 'payments';

interface Cursor {
  createdAt: string;
  id: string;
}

interface ExportRow {
  id: string;
  created_at: string;
  [column: string]: unknown;
}

interface ReportSpec {
  columns: string[];
  sql: string;
  cells: (row: ExportRow) => unknown[];
}

const REPORTS: Record<ReportType, ReportSpec> = {
  transactions: {
    columns: [
      'id',
      'reference',
      'created_at',
      'status',
      'subtotal_cents',
      'discount_cents',
      'tax_cents',
      'total_cents',
      'processing_fee_cents',
      'customer_id',
    ],
    sql: `SELECT id, reference, created_at, status, subtotal_cents, discount_cents,
                 tax_cents, total_cents, customer_id
          FROM transactions
          WHERE (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
    cells: (r) => [
      r.id,
      r.reference,
      r.created_at,
      r.status,
      r.subtotal_cents,
      r.discount_cents,
      r.tax_cents,
      r.total_cents,
      processingFeeCents(Number(r.total_cents)),
      r.customer_id,
    ],
  },
  payments: {
    columns: ['id', 'transaction_id', 'method', 'amount_cents', 'status', 'stellar_tx_hash', 'created_at'],
    sql: `SELECT id, transaction_id, method, amount_cents, status, stellar_tx_hash, created_at
          FROM payments
          WHERE (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
    cells: (r) => [
      r.id,
      r.transaction_id,
      r.method,
      r.amount_cents,
      r.status,
      r.stellar_tx_hash,
      r.created_at,
    ],
  },
};

function parseCursor(raw: unknown): Cursor | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !raw) throw badRequest('cursor is invalid');
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as Cursor).createdAt !== 'string' ||
      typeof (parsed as Cursor).id !== 'string'
    ) {
      throw new Error('malformed cursor');
    }
    return parsed as Cursor;
  } catch {
    throw badRequest('cursor is invalid');
  }
}

function fetchRows(spec: ReportSpec, cursor: Cursor | undefined, limit: number): ExportRow[] {
  const ts = cursor?.createdAt ?? null;
  return getDb()
    .prepare(spec.sql)
    .all(ts, ts, ts, cursor?.id ?? null, limit) as ExportRow[];
}

/** Resolves when the socket accepts more data, or immediately if it closes. */
function waitForDrain(res: Response): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
  });
}

/** GET /reports/export?type=transactions|payments[&limit=500][&cursor=...] */
router.get(
  '/export',
  asyncHandler(async (req, res) => {
    const rawType = String(req.query.type ?? 'transactions');
    if (!Object.prototype.hasOwnProperty.call(REPORTS, rawType)) {
      throw badRequest(`type must be one of: ${Object.keys(REPORTS).join(', ')}`);
    }
    const type = rawType as ReportType;
    const spec = REPORTS[type];
    // `batchSize` is the memory bound per read (not a row cap — the whole
    // report is always streamed). `limit` is accepted as an alias.
    const batchSize = boundedInt(req.query.batchSize ?? req.query.limit, BATCH_SIZE, 1, 1_000);
    let cursor = parseCursor(req.query.cursor);

    // Read the first batch before sending headers: an early failure can still
    // be reported as a normal JSON error with a meaningful status code.
    let rows = fetchRows(spec, cursor, batchSize);

    res.status(200);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${type}-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.setHeader('Cache-Control', 'no-store');
    // Do not let a reverse proxy buffer the whole response and reintroduce the
    // memory problem this endpoint exists to avoid.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(csvLine(spec.columns));

    let finished = false;
    let aborted = false;
    res.on('close', () => {
      if (!finished) aborted = true;
    });

    let exported = 0;
    try {
      while (rows.length > 0) {
        if (aborted || res.destroyed) return;

        const chunk = rows.map((row) => csvLine(spec.cells(row))).join('');
        if (!res.write(chunk)) await waitForDrain(res);
        if (aborted || res.destroyed) return;

        exported += rows.length;
        if (exported >= MAX_ROWS) {
          res.write(csvLine([`# export truncated at ${MAX_ROWS} rows`]));
          break;
        }

        const last = rows[rows.length - 1];
        cursor = { createdAt: String(last.created_at), id: String(last.id) };
        if (rows.length < batchSize) break;
        rows = fetchRows(spec, cursor, batchSize);
      }

      finished = true;
      res.end();
      logger.info(`CSV export: streamed ${exported} ${type} row(s)`);
    } catch (err) {
      logger.error(`CSV export failed (${type}) after ${exported} rows`, { err });
      if (aborted || res.destroyed) return;
      finished = true;
      // Headers are already on the wire, so a 500 is impossible here. Write
      // an in-band error row and close the stream: the client gets an explicit
      // failure instead of a hung connection that times out with no message.
      const message = (err as Error).message.replace(/[\r\n]+/g, ' ');
      res.write(csvLine([`# export failed after ${exported} rows: ${message}`]));
      res.end();
    }
  }),
);

export default router;
