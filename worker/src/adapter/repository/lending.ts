import { Lending } from '../../domain/lending'
import type { LendingRepository } from '../../usecase/port'
import { NotFoundError } from '../../usecase/port'
import { SQL_NOW, toIsoDateOrThrow, toMoney } from './d1'

const COLUMNS = 'id, counterparty, description, amount, collected_amount, occurred_on'

export type LendingRow = {
  id: string
  counterparty: string
  description: string
  amount: number
  collected_amount: number
  occurred_on: string
}

export function toLending(row: LendingRow): Lending {
  return Lending.restore(
    row.id,
    row.counterparty,
    row.description,
    toMoney('lendings', 'amount', row.id, row.amount),
    toMoney('lendings', 'collected_amount', row.id, row.collected_amount),
    toIsoDateOrThrow('lendings', 'occurred_on', row.id, row.occurred_on),
  )
}

export function insertLendingStatement(db: D1Database, l: Lending, guarded: boolean): D1PreparedStatement {
  const sql = guarded
    ? `INSERT INTO lendings (${COLUMNS}) SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1`
    : `INSERT INTO lendings (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`
  return db
    .prepare(sql)
    .bind(l.id, l.counterparty, l.description, l.amount, l.collectedAmount, l.occurredOn)
}

/**
 * 回収額だけを書く文。
 *
 * 立替に対する更新操作は回収だけで、内容を編集する API は無い。全カラムを
 * 上書きする文を置くと、回収のついでに amount を書き換えられる経路ができる。
 * amount が動くと未回収残高（amount - collected_amount）の意味が変わる（不変条件4）。
 *
 * 加算（collected_amount + ?）にしないのは、過回収の判定を SQL に持たせないため。
 * 回収後の金額は domain が検証したうえで確定させ、ここはその結果を書くだけにする。
 * DB の CHECK 制約は最後の防波堤として残っている。
 */
export function updateLendingCollectedStatement(
  db: D1Database,
  l: Lending,
  guarded: boolean,
): D1PreparedStatement {
  const sql = guarded
    ? `UPDATE lendings SET collected_amount = ?, updated_at = ${SQL_NOW} WHERE id = ? AND changes() = 1`
    : `UPDATE lendings SET collected_amount = ?, updated_at = ${SQL_NOW} WHERE id = ?`
  return db.prepare(sql).bind(l.collectedAmount, l.id)
}

export class D1LendingRepository implements LendingRepository {
  readonly #db: D1Database

  constructor(db: D1Database) {
    this.#db = db
  }

  async list(outstandingOnly: boolean): Promise<Lending[]> {
    // 未回収の絞り込みは部分インデックス idx_lendings_outstanding に対応する。
    const where = outstandingOnly ? 'WHERE collected_amount < amount' : ''
    const { results } = await this.#db
      .prepare(`SELECT ${COLUMNS} FROM lendings ${where} ORDER BY occurred_on DESC`)
      .all<LendingRow>()
    return results.map(toLending)
  }

  async get(id: string): Promise<Lending> {
    const row = await this.#db
      .prepare(`SELECT ${COLUMNS} FROM lendings WHERE id = ?`)
      .bind(id)
      .first<LendingRow>()
    if (row === null) throw new NotFoundError('立替')
    return toLending(row)
  }

  async delete(id: string): Promise<void> {
    await this.#db.prepare('DELETE FROM lendings WHERE id = ?').bind(id).run()
  }
}
