/**
 * Transactional outbox for emails.
 *
 * The business write and the "email must be sent" record are committed in the
 * same database transaction. A worker delivers committed rows afterwards, so
 * retrying a conflicting transaction cannot produce a second email: the unique
 * dedupe_key collapses retries into a single outbox row, and claiming a row
 * (pending -> processing) is atomic.
 */
import type { DatabaseSync } from 'node:sqlite';
import { config } from '@/config/config';
import { newId } from '@/utils/helpers';
import { getDb, withTransaction } from '@/utils/database';
import { sendEmail, type Email } from '@/services/email.service';
import { logger } from '@/utils/logger';

interface OutboxRow {
  id: string;
  dedupe_key: string;
  recipient: string;
  subject: string;
  payload: string;
  status: 'pending' | 'processing' | 'sent' | 'failed';
  attempts: number;
  locked_at: string | null;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
}

/**
 * Inserts a message into the outbox using the caller's database connection.
 * Call this INSIDE withTransaction(...); no email is sent here.
 * Returns false when a row with the same dedupe key already exists, which is
 * what makes a retried transaction idempotent.
 */
export function enqueueOutboxEmailTx(db: DatabaseSync, email: Email, dedupeKey: string): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO outbox
         (id, dedupe_key, recipient, subject, payload, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
    )
    .run(newId(), dedupeKey, email.to, email.subject, JSON.stringify(email));
  return result.changes === 1;
}

/** Convenience wrapper for callers that are not already in a transaction. */
export function enqueueOutboxEmail(email: Email, dedupeKey: string): boolean {
  return withTransaction((db) => enqueueOutboxEmailTx(db, email, dedupeKey));
}

/**
 * Delivers one batch of pending messages. Exported so tests can drain the
 * outbox deterministically instead of waiting for the interval timer.
 */
export async function processOutboxOnce(limit = 100, now = new Date()): Promise<number> {
  const db = getDb();
  const nowIso = now.toISOString();
  const staleBefore = new Date(
    now.getTime() - config.outbox.staleLockSeconds * 1_000,
  ).toISOString();

  // A worker that crashed mid-send must not strand its row forever.
  db.prepare(
    "UPDATE outbox SET status = 'pending', locked_at = NULL WHERE status = 'processing' AND locked_at < ?",
  ).run(staleBefore);

  const rows = db
    .prepare("SELECT * FROM outbox WHERE status = 'pending' ORDER BY created_at, id LIMIT ?")
    .all(limit) as unknown as OutboxRow[];

  let delivered = 0;
  for (const row of rows) {
    // Atomic claim: only one worker can win, even with multiple processes.
    const claim = db
      .prepare(
        "UPDATE outbox SET status = 'processing', locked_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'pending'",
      )
      .run(nowIso, row.id);
    if (claim.changes !== 1) continue;

    try {
      await sendEmail(JSON.parse(row.payload) as Email);
      db.prepare(
        "UPDATE outbox SET status = 'sent', sent_at = ?, locked_at = NULL WHERE id = ?",
      ).run(nowIso, row.id);
      delivered++;
    } catch (err) {
      const attempts = row.attempts + 1;
      const status = attempts >= config.outbox.maxAttempts ? 'failed' : 'pending';
      logger.warn(
        `Outbox ${row.id} delivery failed (attempt ${attempts}): ${(err as Error).message}`,
      );
      db.prepare('UPDATE outbox SET status = ?, locked_at = NULL, last_error = ? WHERE id = ?').run(
        status,
        (err as Error).message,
        row.id,
      );
    }
  }
  return delivered;
}

/** Drains every pending message, used on graceful shutdown. */
export async function flushOutbox(timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let total = 0;
  for (;;) {
    const delivered = await processOutboxOnce();
    total += delivered;
    const remaining = (
      getDb().prepare("SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'").get() as {
        n: number;
      }
    ).n;
    if (remaining === 0 || Date.now() >= deadline) break;
  }
  return total;
}

/** Outbox delivery status, useful for support/debug routes and tests. */
export function outboxStats(): Record<string, number> {
  const rows = getDb()
    .prepare('SELECT status, COUNT(*) AS n FROM outbox GROUP BY status')
    .all() as { status: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

let timer: NodeJS.Timeout | null = null;

export function startOutboxWorker(): void {
  if (timer) return;
  timer = setInterval(() => {
    processOutboxOnce().catch((err) =>
      logger.error(`Outbox worker failed: ${(err as Error).message}`),
    );
  }, config.outbox.pollIntervalMs);
  timer.unref();
  logger.info(`Transactional outbox worker started (every ${config.outbox.pollIntervalMs}ms)`);
}

export function stopOutboxWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
