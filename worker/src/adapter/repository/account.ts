import { Account } from '../../domain/account'
import { domainError } from '../../domain/errors'
import type { AccountRepository } from '../../usecase/port'
import { NotFoundError } from '../../usecase/port'
import { isForeignKeyViolation, toInstantOrThrow, toMoney } from './d1'

// 列を明示する。SELECT * にすると、列を足したときに行の型が黙って合わなくなる。
const COLUMNS = 'id, name, kind, balance, updated_at'

export type AccountRow = {
  id: string
  name: string
  kind: string
  balance: number
  updated_at: string
}

/**
 * 行をドメインエンティティに詰め替える。
 *
 * kind は string で戻ってくるため Account.restore が検証する。DB の CHECK 制約が
 * あるので不正な値が入っている見込みは薄いが、ドメイン層に壊れた値を渡さない
 * 最後の関門になる。
 */
export function toAccount(row: AccountRow): Account {
  return Account.restore(
    row.id,
    row.name,
    row.kind,
    toMoney('accounts', 'balance', row.id, row.balance),
    toInstantOrThrow('accounts', 'updated_at', row.id, row.updated_at),
  )
}

/** 口座を作る文。名称・種別・残高・更新日時を書く。 */
export function insertAccountStatement(db: D1Database, a: Account, guarded: boolean): D1PreparedStatement {
  const sql = guarded
    ? `INSERT INTO accounts (id, name, kind, balance, updated_at) SELECT ?, ?, ?, ?, ? WHERE changes() = 1`
    : `INSERT INTO accounts (id, name, kind, balance, updated_at) VALUES (?, ?, ?, ?, ?)`
  return db.prepare(sql).bind(a.id, a.name, a.kind, a.balance, a.updatedAt)
}

/**
 * 口座を更新する文。名称・残高・更新日時だけを書く。kind は含めない。
 *
 * kind を cash から investment に変えられると、その口座が実質資産の計算から
 * 丸ごと消える（不変条件1）。API に無い操作を SQL 側にも残さない。
 */
export function updateAccountStatement(db: D1Database, a: Account, guarded: boolean): D1PreparedStatement {
  const sql = guarded
    ? `UPDATE accounts SET name = ?, balance = ?, updated_at = ? WHERE id = ? AND changes() = 1`
    : `UPDATE accounts SET name = ?, balance = ?, updated_at = ? WHERE id = ?`
  return db.prepare(sql).bind(a.name, a.balance, a.updatedAt, a.id)
}

export class D1AccountRepository implements AccountRepository {
  readonly #db: D1Database

  constructor(db: D1Database) {
    this.#db = db
  }

  async list(): Promise<Account[]> {
    const { results } = await this.#db
      .prepare(`SELECT ${COLUMNS} FROM accounts ORDER BY kind, name`)
      .all<AccountRow>()
    return results.map(toAccount)
  }

  async get(id: string): Promise<Account> {
    const row = await this.#db
      .prepare(`SELECT ${COLUMNS} FROM accounts WHERE id = ?`)
      .bind(id)
      .first<AccountRow>()
    if (row === null) throw new NotFoundError('口座')
    return toAccount(row)
  }

  async create(a: Account): Promise<void> {
    await insertAccountStatement(this.#db, a, false).run()
  }

  async update(a: Account): Promise<void> {
    await updateAccountStatement(this.#db, a, false).run()
  }

  /**
   * 口座を削除する。
   *
   * 取引履歴が残っている口座は ON DELETE RESTRICT で拒まれる。これを
   * ACCOUNT_IN_USE のドメインエラーに翻訳し、handler が 422 に対応させられる
   * ようにする。DB 固有のエラーを知ってよいのはこの層まで。
   */
  async delete(id: string): Promise<void> {
    try {
      await this.#db.prepare('DELETE FROM accounts WHERE id = ?').bind(id).run()
    } catch (err) {
      if (isForeignKeyViolation(err)) throw domainError('ACCOUNT_IN_USE')
      throw err
    }
  }
}
