import { Wish, type WishStatus } from '../../domain/wish'
import type { WishRepository } from '../../usecase/port'
import { NotFoundError } from '../../usecase/port'
import { SQL_NOW, toIsoDateOrThrow, toMoney } from './d1'

const COLUMNS = 'id, title, amount, category, status, priority, deadline'

export type WishRow = {
  id: string
  title: string
  amount: number
  category: string
  status: string
  priority: number
  deadline: string | null
}

export function toWish(row: WishRow): Wish {
  return Wish.restore(row.id, {
    title: row.title,
    amount: toMoney('wishes', 'amount', row.id, row.amount),
    category: row.category,
    status: row.status,
    priority: row.priority,
    deadline: row.deadline === null ? null : toIsoDateOrThrow('wishes', 'deadline', row.id, row.deadline),
  })
}

export function insertWishStatement(db: D1Database, w: Wish, guarded: boolean): D1PreparedStatement {
  const sql = guarded
    ? `INSERT INTO wishes (${COLUMNS}) SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`
    : `INSERT INTO wishes (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`
  return db
    .prepare(sql)
    .bind(w.id, w.title, w.amount, w.category, w.status, w.priority, w.deadline)
}

/**
 * 内容だけを書く文。status は含めない。
 *
 * 1本の UPDATE で status も書けるようにすると、handler が「PATCH で status を
 * 渡せば済む」経路を作れてしまい、遷移の可否を判定する domain のメソッドを
 * 迂回できる（不変条件6）。SQL で書けなければ、そもそも間違えようがない。
 *
 * category は含める。もの・体験・目標の付け替えはどの不変条件にも触れない
 * 単なる分類の変更なので、status と同じ扱いにする理由が無い。
 */
export function updateWishContentStatement(db: D1Database, w: Wish, guarded: boolean): D1PreparedStatement {
  const set = `title = ?, amount = ?, category = ?, priority = ?, deadline = ?, updated_at = ${SQL_NOW}`
  const sql = guarded
    ? `UPDATE wishes SET ${set} WHERE id = ? AND changes() = 1`
    : `UPDATE wishes SET ${set} WHERE id = ?`
  return db.prepare(sql).bind(w.title, w.amount, w.category, w.priority, w.deadline, w.id)
}

/**
 * 状態だけを書く文。/commit /pay /drop が共通で使う。
 * 遷移してよいかは domain の Wish が判定済みである前提で、結果だけを書く。
 */
export function updateWishStatusStatement(db: D1Database, w: Wish, guarded: boolean): D1PreparedStatement {
  const sql = guarded
    ? `UPDATE wishes SET status = ?, updated_at = ${SQL_NOW} WHERE id = ? AND changes() = 1`
    : `UPDATE wishes SET status = ?, updated_at = ${SQL_NOW} WHERE id = ?`
  return db.prepare(sql).bind(w.status, w.id)
}

export class D1WishRepository implements WishRepository {
  readonly #db: D1Database

  constructor(db: D1Database) {
    this.#db = db
  }

  async list(status: WishStatus | null): Promise<Wish[]> {
    const stmt =
      status === null
        ? this.#db.prepare(`SELECT ${COLUMNS} FROM wishes ORDER BY priority, created_at`)
        : this.#db
            .prepare(`SELECT ${COLUMNS} FROM wishes WHERE status = ? ORDER BY priority, created_at`)
            .bind(status)
    const { results } = await stmt.all<WishRow>()
    return results.map(toWish)
  }

  async get(id: string): Promise<Wish> {
    const row = await this.#db
      .prepare(`SELECT ${COLUMNS} FROM wishes WHERE id = ?`)
      .bind(id)
      .first<WishRow>()
    if (row === null) throw new NotFoundError('ウィッシュ')
    return toWish(row)
  }

  async create(w: Wish): Promise<void> {
    await insertWishStatement(this.#db, w, false).run()
  }

  async updateContent(w: Wish): Promise<void> {
    await updateWishContentStatement(this.#db, w, false).run()
  }

  async delete(id: string): Promise<void> {
    await this.#db.prepare('DELETE FROM wishes WHERE id = ?').bind(id).run()
  }
}
