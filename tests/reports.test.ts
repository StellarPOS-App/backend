import { getDb } from '@/utils/database';
import { api, bearer, signUp, useDatabase } from './helpers';

useDatabase();

let adminToken: string;
let adminId: string;
let batch = 0;

beforeAll(async () => {
  // The first user registered in a fresh database gets the admin role.
  const admin = await signUp();
  adminToken = admin.token;
  adminId = admin.id;
});

function insertTransactions(userId: string, count: number): void {
  const prefix = `B${++batch}`;
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO transactions
       (id, reference, user_id, subtotal_cents, discount_cents, tax_cents, total_cents,
        status, created_at)
     VALUES (?, ?, ?, 1000, 0, 0, 1000, 'completed', '2026-01-01 00:00:00')`,
  );
  db.exec('BEGIN');
  try {
    for (let i = 0; i < count; i++) {
      insert.run(`${prefix}-tx-${String(i).padStart(6, '0')}`, `${prefix}-REF-${i}`, userId);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

describe('GET /api/v1/reports/export', () => {
  it('requires an authenticated manager or admin', async () => {
    await api().get('/api/v1/reports/export').expect(401);
  });

  it('rejects an unknown report type before starting a stream', async () => {
    const res = await api()
      .get('/api/v1/reports/export?type=secrets')
      .set(bearer(adminToken))
      .expect(400);
    expect(res.body.success).toBe(false);
  });

  it('streams more than 10,000 transactions in bounded batches', async () => {
    insertTransactions(adminId, 10_500);

    const res = await api()
      .get('/api/v1/reports/export?type=transactions&batchSize=500')
      .set(bearer(adminToken))
      .expect(200);

    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="transactions-/);
    const lines = res.text.split('\r\n').filter(Boolean);
    expect(lines[0]).toBe(
      'id,reference,created_at,status,subtotal_cents,discount_cents,tax_cents,total_cents,processing_fee_cents,customer_id',
    );
    expect(lines).toHaveLength(10_501);
    // Fee is calculated with integer arithmetic (FEE_RATE_BPS defaults to 0).
    expect(lines).toContain(
      'B1-tx-000000,B1-REF-0,2026-01-01 00:00:00,completed,1000,0,0,1000,0,',
    );
  }, 30_000);

  it('escapes spreadsheet formulas in string cells', async () => {
    insertTransactions(adminId, 1);
    getDb()
      .prepare('UPDATE transactions SET reference = ? WHERE user_id = ? AND reference LIKE ?')
      .run('=HYPERLINK("http://evil.example")', adminId, 'B2-%');

    const res = await api()
      .get('/api/v1/reports/export?type=transactions')
      .set(bearer(adminToken))
      .expect(200);

    expect(res.text).toContain("'=HYPERLINK(\"\"http://evil.example\"\")");
  });

  it('exports payments as CSV too', async () => {
    insertTransactions(adminId, 1);
    const tx = getDb()
      .prepare('SELECT id FROM transactions WHERE user_id = ? AND reference LIKE ?')
      .get(adminId, 'B3-%') as { id: string };
    getDb()
      .prepare(
        `INSERT INTO payments (id, transaction_id, method, amount_cents, status, created_at)
         VALUES ('p1', ?, 'cash', 1000, 'completed', '2026-01-01 00:00:00')`,
      )
      .run(tx.id);

    const res = await api()
      .get('/api/v1/reports/export?type=payments')
      .set(bearer(adminToken))
      .expect(200);

    expect(res.text.split('\r\n')[0]).toBe(
      'id,transaction_id,method,amount_cents,status,stellar_tx_hash,created_at',
    );
    expect(res.text).toContain('p1,');
    expect(res.text).toContain(',cash,1000,completed');
  });

  it('rejects a malformed resume cursor', async () => {
    await api()
      .get('/api/v1/reports/export?cursor=not-base64')
      .set(bearer(adminToken))
      .expect(400);
  });
});
