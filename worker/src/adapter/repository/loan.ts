import { Loan } from '../../domain/loan'
import type { LoanRepository } from '../../usecase/port'
import { NotFoundError } from '../../usecase/port'
import { SQL_NOW, toIsoDateOrThrow, toMoney } from './d1'

const COLUMNS = 'id, direction, counterparty, description, amount, settled_amount, occurred_on'

export type LoanRow = {
  id: string
  direction: string
  counterparty: string
  description: string
  amount: number
  settled_amount: number
  occurred_on: string
}

/**
 * 行をドメイン型に詰め替える（不変条件7）。
 *
 * direction は `string` のまま渡し、妥当性の判定は `Loan.restore` に任せる。
 * ここで `as LoanDirection` と書くと、CHECK 制約をすり抜けた値がそのまま
 * ドメインに入る。行の型は「DB がこう言っている」までしか表さない。
 */
export function toLoan(row: LoanRow): Loan {
  return Loan.restore(
    row.id,
    row.direction,
    row.counterparty,
    row.description,
    toMoney('loans', 'amount', row.id, row.amount),
    toMoney('loans', 'settled_amount', row.id, row.settled_amount),
    toIsoDateOrThrow('loans', 'occurred_on', row.id, row.occurred_on),
  )
}

export function insertLoanStatement(db: D1Database, l: Loan, guarded: boolean): D1PreparedStatement {
  const sql = guarded
    ? `INSERT INTO loans (${COLUMNS}) SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`
    : `INSERT INTO loans (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`
  return db
    .prepare(sql)
    .bind(
      l.id,
      l.direction,
      l.counterparty,
      l.description,
      l.amount,
      l.settledAmount,
      l.occurredOn,
    )
}

/**
 * 精算額だけを書く文。
 *
 * 貸し借りに対する更新操作は精算だけで、内容を編集する API は無い。全カラムを
 * 上書きする文を置くと、精算のついでに amount を書き換えられる経路ができる。
 * amount が動くと未精算残高（amount - settled_amount）の意味が変わる（不変条件4）。
 *
 * 加算（settled_amount + ?）にしないのは、過精算の判定を SQL に持たせないため。
 * 精算後の金額は domain が検証したうえで確定させ、ここはその結果を書くだけにする。
 * DB の CHECK 制約は最後の防波堤として残っている。
 */
export function updateLoanSettledStatement(
  db: D1Database,
  l: Loan,
  guarded: boolean,
): D1PreparedStatement {
  const sql = guarded
    ? `UPDATE loans SET settled_amount = ?, updated_at = ${SQL_NOW} WHERE id = ? AND changes() = 1`
    : `UPDATE loans SET settled_amount = ?, updated_at = ${SQL_NOW} WHERE id = ?`
  return db.prepare(sql).bind(l.settledAmount, l.id)
}

export class D1LoanRepository implements LoanRepository {
  readonly #db: D1Database

  constructor(db: D1Database) {
    this.#db = db
  }

  async list(outstandingOnly: boolean): Promise<Loan[]> {
    // 未精算の絞り込みは部分インデックス idx_loans_outstanding に対応する。
    const where = outstandingOnly ? 'WHERE settled_amount < amount' : ''
    const { results } = await this.#db
      .prepare(`SELECT ${COLUMNS} FROM loans ${where} ORDER BY occurred_on DESC`)
      .all<LoanRow>()
    return results.map(toLoan)
  }

  async get(id: string): Promise<Loan> {
    const row = await this.#db
      .prepare(`SELECT ${COLUMNS} FROM loans WHERE id = ?`)
      .bind(id)
      .first<LoanRow>()
    if (row === null) throw new NotFoundError('貸し借り')
    return toLoan(row)
  }

  async delete(id: string): Promise<void> {
    await this.#db.prepare('DELETE FROM loans WHERE id = ?').bind(id).run()
  }
}
