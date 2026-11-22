import { getDb } from '@/utils/database';
import { newId } from '@/utils/helpers';

export const WITHDRAWAL_STATUSES = ['pending', 'completed', 'failed', 'cancelled'] as const;
export type WithdrawalStatus = (typeof WITHDRAWAL_STATUSES)[number];

interface WithdrawalRow {
  id: string;
  user_id: string;
  destination: string;
  asset_code: string;
  asset_issuer: string | null;
  amount: string;
  memo: string;
  status: WithdrawalStatus;
  tx_hash: string | null;
  created_at: string;
}

export interface Withdrawal {
  id: string;
  userId: string;
  destination: string;
  assetCode: string;
  assetIssuer: string | null;
  amount: string;
  memo: string;
  status: WithdrawalStatus;
  txHash: string | null;
  createdAt: string;
}

const toWithdrawal = (r: WithdrawalRow): Withdrawal => ({
  id: r.id,
  userId: r.user_id,
  destination: r.destination,
  assetCode: r.asset_code,
  assetIssuer: r.asset_issuer,
  amount: r.amount,
  memo: r.memo,
  status: r.status,
  txHash: r.tx_hash,
  createdAt: r.created_at,
});

export const WithdrawalModel = {
  create(input: {
    userId: string;
    destination: string;
    assetCode: string;
    assetIssuer: string | null;
    amount: string;
    memo: string;
  }): Withdrawal {
    const id = newId();
    getDb()
      .prepare(
        `INSERT INTO withdrawals
           (id, user_id, destination, asset_code, asset_issuer, amount, memo, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      )
      .run(
        id,
        input.userId,
        input.destination,
        input.assetCode,
        input.assetIssuer,
        input.amount,
        input.memo,
      );
    return this.findById(id)!;
  },

  findById(id: string): Withdrawal | undefined {
    const row = getDb().prepare('SELECT * FROM withdrawals WHERE id = ?').get(id) as
      WithdrawalRow | undefined;
    return row && toWithdrawal(row);
  },

  listForUser(userId: string): Withdrawal[] {
    const rows = getDb()
      .prepare('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC, id DESC')
      .all(userId) as unknown as WithdrawalRow[];
    return rows.map(toWithdrawal);
  },
};
