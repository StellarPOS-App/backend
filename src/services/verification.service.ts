/**
 * Merchant onboarding email verification.
 *
 * Links now live for 24 hours (they used to expire after 15 minutes). Only a
 * SHA-256 hash of the token is stored. Issuing a new link invalidates any
 * outstanding one, so an old link in a mailbox cannot be reused after a resend.
 */
import { createHash, randomBytes } from 'node:crypto';
import { config } from '@/config/config';
import { AppError } from '@/middleware/error.middleware';
import type { User } from '@/models/user.model';
import { UserModel } from '@/models/user.model';
import { enqueueOutboxEmail } from '@/services/outbox.service';
import { getDb, withTransaction } from '@/utils/database';
import { newId } from '@/utils/helpers';

interface VerificationRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** SQLite `datetime('now')` -> comparable epoch milliseconds. */
const sqliteTime = (value: string) => Date.parse(`${value.replace(' ', 'T')}Z`);

/** Creates a token, invalidating any earlier outstanding link for the user. */
export function issueVerificationToken(user: Pick<User, 'id'>): {
  token: string;
  expiresAt: string;
} {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(
    Date.now() + config.verification.tokenTtlHours * 3_600_000,
  ).toISOString();
  withTransaction((db) => {
    db.prepare(
      "UPDATE email_verifications SET consumed_at = datetime('now') WHERE user_id = ? AND consumed_at IS NULL",
    ).run(user.id);
    db.prepare(
      'INSERT INTO email_verifications (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)',
    ).run(newId(), user.id, hashToken(token), expiresAt);
  });
  return { token, expiresAt };
}

/** Builds and queues a verification email for a merchant. */
export function sendVerificationEmail(user: User): { expiresAt: string } {
  const { token, expiresAt } = issueVerificationToken(user);
  const link = `${config.client.url.replace(/\/$/, '')}/verify-email?token=${encodeURIComponent(token)}`;
  const hours = config.verification.tokenTtlHours;
  enqueueOutboxEmail(
    {
      to: user.email,
      subject: `Verify your ${config.store.name} merchant account`,
      text: [
        `Hello ${user.name},`,
        '',
        'Please verify your merchant email address by opening this link:',
        link,
        '',
        `This link expires in ${hours} hours. If it expires, sign in and request a new one.`,
        '',
        `If you did not create this account, you can ignore this email.`,
      ].join('\n'),
    },
    `verification:${user.id}:${newId()}`,
  );
  return { expiresAt };
}

/** Consumes a token and marks the account verified. Throws 400 if unusable. */
export function confirmVerification(token: string): User {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM email_verifications WHERE token_hash = ?')
    .get(hashToken(token)) as VerificationRow | undefined;
  if (!row || row.consumed_at)
    throw new AppError('This verification link is invalid or already used', 400);
  if (sqliteTime(row.expires_at) <= Date.now()) {
    throw new AppError('This verification link has expired. Please request a new one.', 400);
  }
  db.prepare("UPDATE email_verifications SET consumed_at = datetime('now') WHERE id = ?").run(
    row.id,
  );
  UserModel.markEmailVerified(row.user_id);
  return UserModel.findById(row.user_id)!;
}

export function isEmailVerified(userId: string): boolean {
  const row = getDb().prepare('SELECT email_verified_at FROM users WHERE id = ?').get(userId) as
    { email_verified_at: string | null } | undefined;
  return Boolean(row?.email_verified_at);
}

/** Cooldown guard for the resend endpoint. */
export function canResendVerification(userId: string): boolean {
  const row = getDb()
    .prepare(
      'SELECT created_at FROM email_verifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
    )
    .get(userId) as { created_at: string } | undefined;
  if (!row) return true;
  const elapsed = Date.now() - sqliteTime(row.created_at);
  return elapsed >= config.verification.resendCooldownSeconds * 1_000;
}

/** Exposed for tests: how long a freshly issued link remains valid, in hours. */
export function verificationTtlHours(): number {
  return config.verification.tokenTtlHours;
}
