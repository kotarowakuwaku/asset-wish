import { Transaction } from '../../domain/transaction'
import type { TransactionRepository } from '../../usecase/port'
import { limitOrAll, toIsoDateOrThrow, toMoney } from './d1'

const COLUMNS = 'id, account_id, amount, kind, ref_id, occurred_on'

export type TransactionRow = {
  id: string
  account_id: string
  amount: number
  kind: string
  ref_id: string | null
  occurred_on: string
}

export function toTransaction(row: TransactionRow): Transaction {
  return Transaction.restore(
    row.id,
    row.account_id,
    toMoney('transactions', 'amount', row.id, row.amount),
    row.kind,
    row.ref_id,
    toIsoDateOrThrow('transactions', 'occurred_on', row.id, row.occurred_on),
  )
}

export function insertTransactionStatement(
  db: D1Database,
  t: Transaction,
  guarded: boolean,
): D1PreparedStatement {
  const sql = guarded
    ? `INSERT INTO transactions (${COLUMNS}) SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1`
    : `INSERT INTO transactions (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`
  return db.prepare(sql).bind(t.id, t.accountId, t.amount, t.kind, t.refId, t.occurredOn)
}

export class D1TransactionRepository implements TransactionRepository {
  readonly #db: D1Database

  constructor(db: D1Database) {
    this.#db = db
  }

  // 集計はしない。実質資産の計算は domain の純粋関数が持つ（不変条件8）。
  async list(limit: number): Promise<Transaction[]> {
    const { results } = await this.#db
      .prepare(
        `SELECT ${COLUMNS} FROM transactions ORDER BY occurred_on DESC, created_at DESC LIMIT ?`,
      )
      .bind(limitOrAll(limit))
      .all<TransactionRow>()
    return results.map(toTransaction)
  }
}
