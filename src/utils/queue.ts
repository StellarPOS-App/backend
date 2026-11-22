import { randomUUID } from 'node:crypto';
import { logger } from '@/utils/logger';

type Handler<T> = (data: T) => Promise<void> | void;

export interface JobOptions {
  /** Total tries including the first. */
  attempts?: number;
  /** Delay before the first retry; doubles each time. */
  backoffMs?: number;
}

export interface FailedJob<T> {
  /** Stable id used to inspect and requeue the entry. */
  id: string;
  /** Name of the queue the job failed in. */
  queue: string;
  data: T;
  error: string;
  /** Stack trace of the final failure, when the thrown value had one. */
  stack?: string;
  attempts: number;
  failedAt: string;
}

interface Waiting<T> {
  data: T;
  opts: Required<JobOptions>;
}

interface Scheduled<T> extends Waiting<T> {
  /** The attempt number the retry will run as. */
  attempt: number;
}

const DEFAULTS: Required<JobOptions> = { attempts: 5, backoffMs: 1_000 };
const MAX_DEAD = 100;
const FLUSH_POLL_MS = 10;

/**
 * In-process job queue with Bull's add/process shape, so a Redis-backed Bull
 * queue can replace it later without call-site changes.
 *
 * - Retries failed jobs with exponential backoff (1s, 2s, 4s, ... by default).
 * - Jobs added before a processor registers wait instead of being dropped.
 * - Jobs that exhaust their attempts go to a bounded dead-letter list for
 *   inspection, and are logged; nothing ever throws to the caller.
 */
export class MemoryQueue<T = unknown> {
  private handler: Handler<T> | null = null;
  private waiting: Waiting<T>[] = [];
  private scheduled = new Map<NodeJS.Timeout, Scheduled<T>>();
  readonly dead: FailedJob<T>[] = [];
  private active = 0;

  constructor(
    readonly name: string,
    private readonly defaults: Required<JobOptions> = DEFAULTS,
  ) {}

  process(handler: Handler<T>): void {
    this.handler = handler;
    const queued = this.waiting.splice(0);
    for (const job of queued) this.run(job.data, job.opts, 1);
  }

  add(data: T, opts: JobOptions = {}): void {
    const full = { ...this.defaults, ...opts };
    if (!this.handler) {
      this.waiting.push({ data, opts: full });
      return;
    }
    this.run(data, full, 1);
  }

  /** Jobs still running, waiting for a processor, or scheduled for a retry. */
  /**
   * Moves a dead-letter entry back onto the queue with a fresh attempt budget.
   * Returns false when no entry has that id.
   */
  requeue(id: string): boolean {
    const index = this.dead.findIndex((job) => job.id === id);
    if (index === -1) return false;
    const [job] = this.dead.splice(index, 1);
    logger.info(`Queue ${this.name}: requeued dead-letter job ${id}`);
    this.add(job.data);
    return true;
  }

  /** Jobs still running or scheduled for a retry. */
  get pending(): number {
    return this.active + this.scheduled.size + this.waiting.length;
  }

  /** Cancels scheduled retries without running them (tests). See `flush` for shutdown. */
  close(): void {
    for (const timer of this.scheduled.keys()) clearTimeout(timer);
    this.scheduled.clear();
  }

  /**
   * Graceful shutdown: runs every scheduled retry now instead of after its
   * backoff, then waits for running jobs to finish, up to `timeoutMs`.
   * Resolves with the number of jobs still unfinished (0 on a clean flush).
   * Jobs waiting for a processor that never registered cannot run, so they
   * are reported as remaining.
   */
  async flush(timeoutMs: number): Promise<{ remaining: number }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      this.runScheduledNow();
      if (this.active === 0 && this.scheduled.size === 0) break;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, FLUSH_POLL_MS));
    }
    if (!this.handler && this.waiting.length) {
      logger.warn(`Queue ${this.name}: ${this.waiting.length} job(s) have no processor`);
    }
    return { remaining: this.pending };
  }

  /**
   * Removes every job (waiting, scheduled for retry, or dead-lettered) whose
   * data matches. Used to erase personal data from queued emails. A job that
   * is running at the moment cannot be removed and is not counted.
   */
  purgeWhere(predicate: (data: T) => boolean): number {
    let removed = 0;
    const kept = this.waiting.filter((job) => {
      if (!predicate(job.data)) return true;
      removed++;
      return false;
    });
    this.waiting = kept;

    for (const [timer, job] of this.scheduled) {
      if (!predicate(job.data)) continue;
      clearTimeout(timer);
      this.scheduled.delete(timer);
      removed++;
    }

    const deadKept = this.dead.filter((job) => !predicate(job.data));
    removed += this.dead.length - deadKept.length;
    this.dead.splice(0, this.dead.length, ...deadKept);
    return removed;
  }

  private runScheduledNow(): void {
    for (const [timer, job] of [...this.scheduled]) {
      clearTimeout(timer);
      this.scheduled.delete(timer);
      this.run(job.data, job.opts, job.attempt);
    }
  }

  private run(data: T, opts: Required<JobOptions>, attempt: number): void {
    this.active++;
    setImmediate(async () => {
      try {
        await this.handler!(data);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        if (attempt < opts.attempts) {
          const delay = opts.backoffMs * 2 ** (attempt - 1);
          logger.warn(
            `Queue ${this.name}: attempt ${attempt} failed (${error}); retrying in ${delay}ms`,
          );
          const timer = setTimeout(() => {
            this.scheduled.delete(timer);
            this.run(data, opts, attempt + 1);
          }, delay);
          timer.unref();
          this.scheduled.set(timer, { data, opts, attempt: attempt + 1 });
        } else {
          logger.error(`Queue ${this.name}: job failed after ${attempt} attempts`, { error });
          this.dead.unshift({
            id: randomUUID(),
            queue: this.name,
            data,
            error,
            stack,
            attempts: attempt,
            failedAt: new Date().toISOString(),
          });
          this.dead.length = Math.min(this.dead.length, MAX_DEAD);
        }
      } finally {
        this.active--;
      }
    });
  }
}

export const QUEUE_NAMES = ['notifications', 'receipts', 'payments'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

/**
 * Payment confirmations get one initial try plus three retries before they are
 * moved to the dead-letter list for manual review. A confirmation that fails
 * must never be silently dropped — that would leave a customer's sale stuck in
 * `pending` forever.
 */
export const PAYMENT_CONFIRMATION_ATTEMPTS = 4;
export const PAYMENT_CONFIRMATION_BACKOFF_MS = 1_000;

/** Per-queue overrides of the generic defaults. */
const QUEUE_DEFAULTS: Partial<Record<QueueName, Required<JobOptions>>> = {
  payments: {
    attempts: PAYMENT_CONFIRMATION_ATTEMPTS,
    backoffMs: PAYMENT_CONFIRMATION_BACKOFF_MS,
  },
};

let queues: Map<QueueName, MemoryQueue> | null = null;

export function setupQueues(): void {
  queues = new Map(
    QUEUE_NAMES.map((name) => [name, new MemoryQueue(name, QUEUE_DEFAULTS[name] ?? DEFAULTS)]),
  );
}

/** True once setupQueues() has run (scripts and unit tests may skip it). */
export function queuesReady(): boolean {
  return queues !== null;
}

export function getQueue<T = unknown>(name: QueueName): MemoryQueue<T> {
  if (!queues) throw new Error('Queues not initialized. Call setupQueues() first.');
  const queue = queues.get(name);
  if (!queue) throw new Error(`Unknown queue: ${name}`);
  return queue as MemoryQueue<T>;
}

/** Every named queue; empty before setupQueues() has run. */
export function allQueues(): MemoryQueue[] {
  return queues ? [...queues.values()] : [];
}

/** Flushes all queues in parallel. Resolves with the total number of unfinished jobs. */
export async function flushQueues(timeoutMs: number): Promise<number> {
  const results = await Promise.all(allQueues().map((q) => q.flush(timeoutMs)));
  return results.reduce((total, r) => total + r.remaining, 0);
}

export function closeQueues(): void {
  queues?.forEach((q) => q.close());
}

/** Dead-letter entries across all queues (or one), newest first. */
export function listDeadLetters(queue?: QueueName): FailedJob<unknown>[] {
  if (!queues) return [];
  const sources = queue ? [queues.get(queue)] : [...queues.values()];
  return sources
    .flatMap((q) => (q ? q.dead : []))
    .sort((a, b) => b.failedAt.localeCompare(a.failedAt));
}

/** Requeues a dead-letter entry on its owning queue. False when the id is unknown. */
export function requeueDeadLetter(id: string): boolean {
  if (!queues) return false;
  for (const q of queues.values()) {
    if (q.requeue(id)) return true;
  }
  return false;
}
