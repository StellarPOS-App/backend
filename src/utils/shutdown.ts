import type { Server } from 'node:http';

/** The slice of http.Server the shutdown sequence needs. */
export type ShutdownServer = Pick<Server, 'close' | 'closeIdleConnections' | 'closeAllConnections'>;

export interface ShutdownOptions {
  server: ShutdownServer;
  /** Deadline for in-flight HTTP requests to finish after shutdown starts. */
  timeoutMs: number;
  /** Deadline for the job queue flush. */
  flushTimeoutMs: number;
  /** Stops timers that create new work (payment watcher, backups). Runs first. */
  stopBackground: () => void;
  /** Runs queued and scheduled jobs; resolves with the number left unfinished. */
  flushJobs: (timeoutMs: number) => Promise<number>;
  /** Closes sockets and the database. Runs last. */
  release: () => Promise<void>;
  exit: (code: number) => void;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

/**
 * Builds the SIGTERM/SIGINT handler. The sequence is:
 *   1. stop background timers,
 *   2. stop accepting connections and wait for in-flight requests (up to timeoutMs),
 *      then cut whatever is still open,
 *   3. flush the job queue (up to flushTimeoutMs),
 *   4. release resources and exit.
 *
 * The handler is idempotent: a second signal while shutdown is running is logged
 * and ignored, and gets the same promise back. Exit code is 0 on a clean stop,
 * 1 if requests were cut or jobs were left behind.
 */
export function createShutdown(options: ShutdownOptions): (signal: string) => Promise<number> {
  const log = options.log ?? (() => undefined);
  const warn = options.warn ?? log;
  let running: Promise<number> | null = null;

  async function run(signal: string): Promise<number> {
    log(`${signal} received, shutting down (request deadline ${options.timeoutMs}ms)`);

    try {
      options.stopBackground();
    } catch (err) {
      warn(`Stopping background work failed: ${(err as Error).message}`);
    }

    const httpClean = await drainHttp(options.server, options.timeoutMs);
    if (!httpClean) warn(`Cut open connections after ${options.timeoutMs}ms`);

    let left = 0;
    try {
      left = await options.flushJobs(options.flushTimeoutMs);
    } catch (err) {
      warn(`Job queue flush failed: ${(err as Error).message}`);
      left = 1;
    }
    if (left > 0) warn(`${left} job(s) left unfinished at shutdown`);

    try {
      await options.release();
    } catch (err) {
      warn(`Releasing resources failed: ${(err as Error).message}`);
    }

    const code = httpClean && left === 0 ? 0 : 1;
    log(`Shutdown complete (exit ${code})`);
    options.exit(code);
    return code;
  }

  return (signal: string) => {
    if (running) {
      warn(`${signal} received while already shutting down; ignoring`);
      return running;
    }
    running = run(signal);
    return running;
  };
}

/**
 * Stops the listener and waits for open requests. Resolves true when every
 * connection closed before the deadline, false when the deadline cut them.
 */
function drainHttp(server: ShutdownServer, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    function finish(clean: boolean): void {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(clean);
    }
    const timer = setTimeout(() => {
      server.closeAllConnections();
      finish(false);
    }, timeoutMs);

    // Stops new connections. Node also closes idle keep-alive sockets here, so
    // only requests that are actually running keep the server open.
    server.close(() => finish(true));
    server.closeIdleConnections();
  });
}
