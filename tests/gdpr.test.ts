import { getDb } from '@/utils/database';
import { verifyErasureReceipt, type ErasureReceipt } from '@/services/gdpr.service';
import { UserModel } from '@/models/user.model';
import { getQueue, setupQueues } from '@/utils/queue';
import { api, bearer, createProduct, createSale, signUp, useDatabase } from './helpers';

useDatabase();
beforeAll(() => setupQueues());

const PASSWORD = 'correct-horse-1';
const emailOf = async (token: string): Promise<string> =>
  (await api().get('/api/v1/auth/me').set(bearer(token)).expect(200)).body.data.email;

describe('DELETE /api/v1/users/:id/data', () => {
  let admin: { token: string; id: string };
  let cashier: { token: string; id: string };
  let other: { token: string; id: string };
  let cashierEmail: string;
  let saleId: string;

  beforeAll(async () => {
    admin = await signUp('Ada Admin');
    cashier = await signUp('Chidi Cashier');
    other = await signUp('Other Cashier');
    cashierEmail = await emailOf(cashier.token);

    // The cashier makes a sale, so there is audit history and a sale to keep.
    const product = await createProduct(admin.token, { priceCents: 300, stock: 5 });
    const sale = await createSale(cashier.token, [{ productId: product.id, quantity: 1 }]);
    saleId = sale.id;
  });

  it('requires authentication', async () => {
    await api().delete(`/api/v1/users/${cashier.id}/data`).expect(401);
  });

  it('refuses a cashier erasing someone else', async () => {
    await api().delete(`/api/v1/users/${cashier.id}/data`).set(bearer(other.token)).expect(403);
    expect(UserModel.findById(cashier.id)!.name).toBe('Chidi Cashier');
  });

  it('lets the subject erase their own data, keeping sales and purging queued email', async () => {
    getQueue('notifications').add({ to: cashierEmail, subject: 'Receipt', text: 'hello' });
    getQueue('notifications').add({ to: 'someone-else@example.com', subject: 'x', text: 'y' });

    const res = await api()
      .delete(`/api/v1/users/${cashier.id}/data`)
      .set(bearer(cashier.token))
      .expect(200);
    const receipt: ErasureReceipt = res.body.data;

    expect(receipt).toMatchObject({
      subjectId: cashier.id,
      requestedBy: cashier.id,
      algorithm: 'sha256',
      counts: { users: 1, sales_retained: 1, queued_emails_purged: 1 },
    });
    expect(receipt.counts.audit_log).toBeGreaterThan(0);
    expect(verifyErasureReceipt(receipt)).toBe(true);

    // The user row stays, with personal fields replaced.
    const row = UserModel.findById(cashier.id)!;
    expect(row.name).toBe('[deleted user]');
    expect(row.email).toBe(`deleted-${cashier.id}@anonymised.invalid`);

    // Sales keep their link to the (anonymised) cashier.
    const list = await api().get('/api/v1/transactions').set(bearer(admin.token)).expect(200);
    const kept = list.body.data.find((t: { id: string }) => t.id === saleId);
    expect(kept.cashierName).toBe('[deleted user]');

    // The old email cannot sign in any more.
    await api()
      .post('/api/v1/auth/login')
      .send({ email: cashierEmail, password: PASSWORD })
      .expect(401);

    // No audit row keeps the old email.
    const left = getDb()
      .prepare('SELECT COUNT(*) AS n FROM audit_log WHERE user_email = ?')
      .get(cashierEmail) as { n: number };
    expect(left.n).toBe(0);

    // Only the email addressed to the erased user was removed from the queue.
    expect(getQueue('notifications').pending).toBe(1);
  });

  it('issues a receipt that can be retrieved later by the subject and by an admin', async () => {
    const issued = await api()
      .delete(`/api/v1/users/${other.id}/data`)
      .set(bearer(admin.token))
      .expect(200);
    const id = issued.body.data.id;

    const own = await api()
      .get(`/api/v1/users/${other.id}/data/receipts/${id}`)
      .set(bearer(other.token))
      .expect(200);
    expect(own.body.data.digest).toBe(issued.body.data.digest);
    expect(verifyErasureReceipt(own.body.data)).toBe(true);

    await api()
      .get(`/api/v1/users/${cashier.id}/data/receipts/${id}`)
      .set(bearer(admin.token))
      .expect(404);
    await api()
      .get(`/api/v1/users/${other.id}/data/receipts/${id}`)
      .set(bearer(cashier.token))
      .expect(403);
  });

  it('lets an admin erase any user, and returns 404 for an unknown id', async () => {
    const third = await signUp('Third Staff');
    await api().delete(`/api/v1/users/${third.id}/data`).set(bearer(admin.token)).expect(200);
    await api()
      .delete('/api/v1/users/00000000-0000-4000-8000-000000000000/data')
      .set(bearer(admin.token))
      .expect(404);
  });

  it('detects a receipt whose record ids or timestamp were altered', async () => {
    const res = await api()
      .delete(`/api/v1/users/${cashier.id}/data`)
      .set(bearer(admin.token))
      .expect(200);
    const receipt: ErasureReceipt = res.body.data;

    // `users` always contains the subject id; audit_log can legitimately be empty.
    const dropped = { ...receipt, records: { ...receipt.records, users: [] as string[] } };
    expect(verifyErasureReceipt(dropped)).toBe(false);
    expect(verifyErasureReceipt({ ...receipt, timestamp: '2001-01-01T00:00:00.000Z' })).toBe(false);
  });
});
