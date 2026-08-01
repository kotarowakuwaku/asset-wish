import { RecurringEntry } from '../../domain/recurring'
import { YearMonth } from '../../domain/yearMonth'
import type { RecurringRepository } from '../../usecase/port'
import { NotFoundError } from '../../usecase/port'
import { SQL_NOW, toMoney } from './d1'

const COLUMNS = 'id, name, account_id, amount, day_of_month, applied_through'

export type RecurringEntryRow = {
  id: string
  name: string
  account_id: string
  amount: number
  day_of_month: number
  applied_through: string
}

/**
 * 行をドメイン型に詰め替える（不変条件7）。
 *
 * `applied_through` は 'YYYY-MM' 形式。不正なら `YearMonth` が投げる。
 * CHECK 制約の裏をかいた値をドメインに入れないための関門。
 */
export function toRecurringEntry(row: RecurringEntryRow): RecurringEntry {
  return RecurringEntry.restore(
    row.id,
    row.name,
    row.account_id,
    toMoney('recurring_entries', 'amount', row.id, row.amount),
    row.day_of_month,
    YearMonth.parse(row.applied_through),
  )
}

export function insertRecurringStatement(
  db: D1Database,
  e: RecurringEntry,
  guarded: boolean,
): D1PreparedStatement {
  const sql = guarded
    ? `INSERT INTO recurring_entries (${COLUMNS}) SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1`
    : `INSERT INTO recurring_entries (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`
  return db
    .prepare(sql)
    .bind(e.id, e.name, e.accountId, e.amount, e.dayOfMonth, e.appliedThrough.toString())
}

/**
 * 適用済みの年月だけを書く文。
 *
 * 金額・適用日・口座を書ける文は置かない。適用のついでにそれらが変わると、
 * 「どの条件で適用されたか」と履歴が食い違う。内容を直したいときは消して
 * 作り直す（更新は操作別に分ける。CLAUDE.md の設計上の決定）。
 */
export function updateRecurringAppliedStatement(
  db: D1Database,
  e: RecurringEntry,
  guarded: boolean,
): D1PreparedStatement {
  const sql = guarded
    ? `UPDATE recurring_entries SET applied_through = ?, updated_at = ${SQL_NOW} WHERE id = ? AND changes() = 1`
    : `UPDATE recurring_entries SET applied_through = ?, updated_at = ${SQL_NOW} WHERE id = ?`
  return db.prepare(sql).bind(e.appliedThrough.toString(), e.id)
}

export class D1RecurringRepository implements RecurringRepository {
  readonly #db: D1Database

  constructor(db: D1Database) {
    this.#db = db
  }

  async list(): Promise<RecurringEntry[]> {
    const { results } = await this.#db
      .prepare(`SELECT ${COLUMNS} FROM recurring_entries ORDER BY name`)
      .all<RecurringEntryRow>()
    return results.map(toRecurringEntry)
  }

  async get(id: string): Promise<RecurringEntry> {
    const row = await this.#db
      .prepare(`SELECT ${COLUMNS} FROM recurring_entries WHERE id = ?`)
      .bind(id)
      .first<RecurringEntryRow>()
    if (row === null) throw new NotFoundError('定期入出金')
    return toRecurringEntry(row)
  }

  async create(e: RecurringEntry): Promise<void> {
    await insertRecurringStatement(this.#db, e, false).run()
  }

  async delete(id: string): Promise<void> {
    await this.#db.prepare('DELETE FROM recurring_entries WHERE id = ?').bind(id).run()
  }
}
