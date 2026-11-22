import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '@/config/config';
import { logger } from '@/utils/logger';
import { backfillSearchIndex, SEARCH_SCHEMA } from '@/utils/searchIndex';

let db: DatabaseSync | null = null;

/**
 * Schema, applied idempotently on every boot. Money is stored as integer
 * minor units (cents) to avoid floating point; Stellar amounts are 7-decimal
 * strings, exactly as Horizon returns them.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'cashier')),
  active INTEGER NOT NULL DEFAULT 1,
  -- Compliance gate: withdrawals are blocked unless this is 'approved'.
  kyc_status TEXT NOT NULL DEFAULT 'pending' CHECK (kyc_status IN ('pending', 'approved', 'rejected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sku TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'General',
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  low_stock_threshold INTEGER NOT NULL DEFAULT 5,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  stellar_address TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id),
  customer_id TEXT REFERENCES customers(id),
  subtotal_cents INTEGER NOT NULL,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'void', 'refunded')),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at);
-- Streaming CSV exports page by (created_at, id) keyset cursors.
CREATE INDEX IF NOT EXISTS idx_transactions_created_id ON transactions(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
-- Analytics filter completed sales by date; customer pages list a customer's sales.
CREATE INDEX IF NOT EXISTS idx_transactions_status_created ON transactions(status, created_at);
CREATE INDEX IF NOT EXISTS idx_transactions_customer ON transactions(customer_id, created_at);
-- Partial index for non-terminal statuses (#157). Dashboard and background jobs
-- that poll for pending orders only ever scan this small working set; a full-status
-- index includes every historical completed/voided row unnecessarily.
CREATE INDEX IF NOT EXISTS idx_transactions_pending ON transactions(created_at)
  WHERE status = 'pending';
-- Merchant (user) dashboard filters by user_id; composite with created_at covers date-range queries.
CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id, created_at);
-- PERF-016: dashboard and reporting queries filter by merchant (user_id), status, and date range
-- together; without this composite index each predicate is applied sequentially on a full scan.
CREATE INDEX IF NOT EXISTS idx_transactions_user_status_created ON transactions(user_id, status, created_at);

CREATE TABLE IF NOT EXISTS transaction_items (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  name TEXT NOT NULL,
  sku TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  line_total_cents INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_tx ON transaction_items(transaction_id);
-- Top-products and archive-on-delete look items up by product.
CREATE INDEX IF NOT EXISTS idx_items_product ON transaction_items(product_id);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  method TEXT NOT NULL CHECK (method IN ('cash', 'card', 'stellar')),
  amount_cents INTEGER NOT NULL,
  tendered_cents INTEGER,
  change_cents INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  stellar_tx_hash TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_tx ON payments(transaction_id);
CREATE INDEX IF NOT EXISTS idx_payments_created_id ON payments(created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS payment_requests (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  destination TEXT NOT NULL,
  asset_code TEXT NOT NULL,
  asset_issuer TEXT,
  amount TEXT NOT NULL,
  memo TEXT NOT NULL UNIQUE,
  uri TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'expired', 'cancelled')),
  tx_hash TEXT UNIQUE,
  payer TEXT,
  expires_at TEXT NOT NULL,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_requests_status ON payment_requests(status);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  user_email TEXT,
  role TEXT,
  action TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, created_at);

CREATE TABLE IF NOT EXISTS user_totp (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_enc TEXT,
  pending_enc TEXT,
  recovery_hashes TEXT NOT NULL DEFAULT '[]',
  last_step INTEGER NOT NULL DEFAULT 0,
  enabled_at TEXT
);

-- Proof of GDPR erasure. Holds record ids, counts and a digest, never personal data.
CREATE TABLE IF NOT EXISTS deletion_receipts (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deletion_receipts_subject ON deletion_receipts(subject_id);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Stellar account links per staff member (#145).
CREATE TABLE IF NOT EXISTS user_stellar (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stellar_public_key TEXT NOT NULL,
  linked_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Transaction dispute workflow (#141).
CREATE TABLE IF NOT EXISTS disputes (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  opened_by TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL CHECK (reason IN ('incorrect_amount','duplicate_charge','item_not_received','other')),
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','under_review','resolved','rejected')),
  resolution_note TEXT,
  resolved_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_disputes_tx ON disputes(transaction_id);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status, created_at);

-- Sessions table with indexed expires_at for efficient cleanup (#126).
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

-- Idempotency keys for mutating endpoints. The response is stored so a retry
-- after a client timeout replays the original result instead of creating a
-- second order. Keys are scoped per user + route (scope) and expire after 24h.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);
CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys(expires_at);

-- Stellar withdrawals (money out). Gated by the KYC middleware in app.ts.
CREATE TABLE IF NOT EXISTS withdrawals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  destination TEXT NOT NULL,
  asset_code TEXT NOT NULL,
  asset_issuer TEXT,
  amount TEXT NOT NULL,
  memo TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'cancelled')),
  tx_hash TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id, created_at);
`;

let sessionCleanupTimer: NodeJS.Timeout | null = null;

export function startSessionCleanup(): void {
  // Clean up expired sessions every 15 minutes (#126)
  sessionCleanupTimer = setInterval(
    () => {
      try {
        getDb().prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
      } catch (err) {
        logger.error('Session cleanup failed', err);
      }
    },
    15 * 60 * 1000,
  );
  sessionCleanupTimer.unref();
}

export async function connectDatabase(path: string = config.database.path): Promise<DatabaseSync> {
  if (db) return db;
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  // Under load, a writer can find the database briefly locked. Wait up to 5s
  // for the lock instead of failing immediately with SQLITE_BUSY.
  db.exec('PRAGMA busy_timeout = 5000;');
  if (path !== ':memory:') {
    // WAL lets reads continue during writes; NORMAL sync is safe with WAL
    // and avoids an fsync on every commit.
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
  }
  db.exec(SCHEMA);
  // Older databases predate the KYC gate; add the column idempotently (#compliance).
  addColumnWithDefault('users', 'kyc_status', 'TEXT NOT NULL', "'pending'");
  db.exec(SEARCH_SCHEMA);
  backfillSearchIndex(db);
  logger.debug(`Database ready at ${path}`);
  return db;
}

export function getDb(): DatabaseSync {
  if (!db) throw new Error('Database not connected. Call connectDatabase() first.');
  return db;
}

/** True when the database answers a trivial query. Used by /health. */
export function isDatabaseHealthy(): boolean {
  try {
    return db?.prepare('SELECT 1 AS ok').get()?.ok === 1;
  } catch {
    return false;
  }
}

export function closeDatabase(): void {
  db?.close();
  db = null;
}

/**
 * Runs `fn` inside a transaction. Any thrown error rolls everything back,
 * which is what keeps stock and sales consistent.
 */
export function withTransaction<T>(fn: (db: DatabaseSync) => T): T {
  const conn = getDb();
  conn.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(conn);
    conn.exec('COMMIT');
    return result;
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
}

// Database query performance monitoring (#133)
const queryLatencies: number[] = [];

export function recordQueryDuration(sql: string, durationMs: number): void {
  queryLatencies.push(durationMs);
  if (queryLatencies.length > 1000) queryLatencies.shift();

  if (durationMs > 100) {
    logger.warn(`Slow database query detected (${durationMs}ms): ${sql.slice(0, 100)}`);
  }

  if (queryLatencies.length >= 20) {
    const sorted = [...queryLatencies].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    if (p95 > 500) {
      logger.error(`Database P95 latency alert: ${p95}ms exceeds 500ms threshold`);
    }
  }
}

/**
 * Migration helper ensuring any NOT NULL column additions provide a DEFAULT value (#123).
 */
export function addColumnWithDefault(
  table: string,
  column: string,
  typeDef: string,
  defaultValue?: string,
): void {
  const defaultClause = defaultValue !== undefined ? `DEFAULT ${defaultValue}` : "DEFAULT ''";
  const def =
    typeDef.toUpperCase().includes('NOT NULL') && !typeDef.toUpperCase().includes('DEFAULT')
      ? `${typeDef} ${defaultClause}`
      : typeDef;
  try {
    getDb().exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  } catch (err: any) {
    if (!err?.message?.includes('duplicate column name')) {
      throw err;
    }
  }
}
