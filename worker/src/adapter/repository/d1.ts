// D1 アクセスの共通部分。
//
// この層の責務は2つに尽きる。
//
//   - D1 が返す行とドメインエンティティの相互変換
//   - 書き込みの原子性（writer.ts）
//
// 計算はしない。実質資産・不足額・到達見込みは domain の純粋関数が持つ
// （不変条件8）。SQL に集計を書かないのも同じ理由で、データ規模が年間
// 数百件のため全件取得で足りる。

import { money, type Money } from '../../domain/money'
import { parseInstant, parseIsoDate, type Instant, type IsoDate } from '../../domain/time'

/**
 * 取得件数を SQL に渡せる値に丸める。
 *
 * 負値や極端な値は「全件相当」にする。呼び出し側の都合で LIMIT が壊れるより、
 * 多めに返すほうが害が小さい。データ規模は年間数百件（不変条件8）。
 */
const MAX_LIMIT = 1 << 30

export function limitOrAll(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_LIMIT) return MAX_LIMIT
  return limit
}

/**
 * 外部キー制約違反かどうかを判定する。
 *
 * D1 は外部キーを既定で強制する。取引履歴が残っている口座の削除がこれに当たる。
 * DB 固有のエラーを知ってよいのはこの層まで。
 */
export function isForeignKeyViolation(err: unknown): boolean {
  return err instanceof Error && err.message.includes('FOREIGN KEY constraint failed')
}

/** DB の値が壊れていることを表す。ドメイン層に壊れた値を渡さないための最後の関門。 */
export function corrupted(table: string, column: string, id: string, value: unknown): Error {
  return new Error(`${table}.${column} が不正: id=${id} value=${JSON.stringify(value)}`)
}

export function toMoney(table: string, column: string, id: string, value: number): Money {
  if (!Number.isSafeInteger(value)) throw corrupted(table, column, id, value)
  return money(value)
}

export function toInstantOrThrow(table: string, column: string, id: string, value: string): Instant {
  const v = parseInstant(value)
  if (v === null) throw corrupted(table, column, id, value)
  return v
}

export function toIsoDateOrThrow(table: string, column: string, id: string, value: string): IsoDate {
  const v = parseIsoDate(value)
  if (v === null) throw corrupted(table, column, id, value)
  return v
}

/** created_at / updated_at の既定値と同じ形式で「いま」を入れる SQL 片。 */
export const SQL_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
