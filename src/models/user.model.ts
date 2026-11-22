import { getDb } from '@/utils/database';
import { newId } from '@/utils/helpers';

export const ROLES = ['admin', 'manager', 'cashier'] as const;
export type Role = (typeof ROLES)[number];

interface UserRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: Role;
  active?: number;
  email_verified_at?: string | null;
  created_at: string;
}

export interface User {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  role: Role;
  active: boolean;
  emailVerified: boolean;
  createdAt: string;
}

export type PublicUser = Omit<User, 'passwordHash'>;

const toUser = (r: UserRow): User => ({
  id: r.id,
  name: r.name,
  email: r.email,
  passwordHash: r.password_hash,
  role: r.role,
  active: r.active !== 0,
  emailVerified: Boolean(r.email_verified_at),
  createdAt: r.created_at,
});

export const toPublicUser = ({ passwordHash: _omit, ...rest }: User): PublicUser => rest;

export const UserModel = {
  create(input: { name: string; email: string; passwordHash: string; role: Role }): User {
    const id = newId();
    getDb()
      .prepare('INSERT INTO users (id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)')
      .run(id, input.name, input.email.toLowerCase(), input.passwordHash, input.role);
    return this.findById(id)!;
  },

  findById(id: string): User | undefined {
    const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row && toUser(row);
  },

  findByEmail(email: string): User | undefined {
    const row = getDb().prepare('SELECT * FROM users WHERE email = ?').get(email) as
      UserRow | undefined;
    return row && toUser(row);
  },

  list(): PublicUser[] {
    const rows = getDb()
      .prepare('SELECT * FROM users ORDER BY created_at')
      .all() as unknown as UserRow[];
    return rows.map((r) => toPublicUser(toUser(r)));
  },

  listPaged(offset: number, limit: number): PublicUser[] {
    const rows = getDb()
      .prepare('SELECT * FROM users ORDER BY created_at LIMIT ? OFFSET ?')
      .all(limit, offset) as unknown as UserRow[];
    return rows.map((r) => toPublicUser(toUser(r)));
  },

  count(): number {
    return (getDb().prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  },

  /** Number of sales recorded by this user. Those sales stay; only the user row is anonymised. */
  countSales(id: string): number {
    return (
      getDb().prepare('SELECT COUNT(*) AS n FROM transactions WHERE user_id = ?').get(id) as {
        n: number;
      }
    ).n;
  },

  updateRole(id: string, role: Role): void {
    getDb().prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  },

  updateProfile(id: string, fields: { name?: string; passwordHash?: string }): void {
    if (fields.name !== undefined) {
      getDb().prepare('UPDATE users SET name = ? WHERE id = ?').run(fields.name, id);
    }
    if (fields.passwordHash !== undefined) {
      getDb()
        .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
        .run(fields.passwordHash, id);
    }
  },

  /**
   * Replaces the personal fields of a user row. The row itself stays so that
   * sales, audit entries and other references keep pointing at a valid user.
   * The caller passes an email no one can sign in with and an unguessable hash.
   */
  anonymise(id: string, placeholderEmail: string, unusableHash: string): void {
    getDb()
      .prepare(
        "UPDATE users SET name = '[deleted user]', email = ?, password_hash = ? WHERE id = ?",
      )
      .run(placeholderEmail, unusableHash, id);
  },

  /** Soft-deactivate: sets active = 0, preventing login (#148). */
  deactivate(id: string): void {
    getDb().prepare('UPDATE users SET active = 0 WHERE id = ?').run(id);
  },

  isActive(id: string): boolean {
    const row = getDb().prepare('SELECT active FROM users WHERE id = ?').get(id) as
      { active: number } | undefined;
    return row?.active === 1;
  },

  /** Marks a merchant's email as verified (idempotent). */
  markEmailVerified(id: string): void {
    getDb()
      .prepare(
        "UPDATE users SET email_verified_at = COALESCE(email_verified_at, datetime('now')) WHERE id = ?",
      )
      .run(id);
  },
};
