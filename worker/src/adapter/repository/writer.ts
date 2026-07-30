import { ConflictError, type AtomicWriter, type WriteOperation } from '../../usecase/port'
import { updateAccountStatement } from './account'
import { insertLoanStatement, updateLoanSettledStatement } from './loan'
import { insertTransactionStatement } from './transaction'
import { updateWishStatusStatement } from './wish'

/**
 * 書き込みを1回の batch にまとめて原子的に流す。
 *
 * ## なぜこの形なのか
 *
 * D1 は BEGIN を受け付けないため、Go 版の RunInTx をそのまま移植できない。
 * 代わりに db.batch() が「1回の呼び出し＝1つのトランザクション」として働く。
 *
 * 素直に「条件付き UPDATE を並べて、更新0件なら競合とみなす」と書くと**壊れる。**
 * 実際に D1 で確かめたところ、条件に合わず0件だった UPDATE の後ろの INSERT は
 * そのまま実行される。貸し借りだけが増えて残高が動かない、という中途半端な状態が残る。
 *
 * そこで、
 *
 *   1. 先頭に「読み取り時の値が今も変わっていないか」だけを見る番人の文を置く
 *   2. 以降のすべての文を `changes() = 1` で塞ぐ
 *
 * とする。SQLite の changes() は直前に完了した文が変更した行数を返し、これが
 * batch の中で文をまたいで引き継がれることも確認済み。番人が0件なら以降の文は
 * すべて素通りし、**1件も書き込まれない。**
 *
 * 番人が「値を変えない UPDATE」なのは、changes() を1にできる文が UPDATE /
 * INSERT / DELETE しか無いため。SELECT では changes() が動かない。
 */
export class D1AtomicWriter implements AtomicWriter {
  readonly #db: D1Database

  constructor(db: D1Database) {
    this.#db = db
  }

  async writeAll(ops: readonly WriteOperation[]): Promise<void> {
    if (ops.length === 0) return

    const preconditions = ops.flatMap(preconditionOf)
    if (preconditions.length === 0) {
      await this.#db.batch(ops.map((op) => this.#statement(op, false)))
      return
    }

    const statements = [
      guardStatement(this.#db, preconditions),
      ...ops.map((op) => this.#statement(op, true)),
    ]
    const results = await this.#db.batch(statements)

    // 番人が0件なら、以降の文は changes() = 1 を満たせず全部素通りしている。
    if (results[0].meta.changes === 0) throw new ConflictError()
  }

  #statement(op: WriteOperation, guarded: boolean): D1PreparedStatement {
    switch (op.kind) {
      case 'createLoan':
        return insertLoanStatement(this.#db, op.loan, guarded)
      case 'updateLoanSettled':
        return updateLoanSettledStatement(this.#db, op.loan, guarded)
      case 'updateWishStatus':
        return updateWishStatusStatement(this.#db, op.wish, guarded)
      case 'updateAccount':
        return updateAccountStatement(this.#db, op.account, guarded)
      case 'createTransaction':
        return insertTransactionStatement(this.#db, op.transaction, guarded)
    }
  }
}

/**
 * 読み取り時の値が今も変わっていないことの確認。
 *
 * table と column は下の関数がそのまま SQL に埋めるため、**呼び出し側から
 * 文字列を受け取ってはならない。** 値は必ずプレースホルダで渡す。
 */
type Precondition = {
  table: string
  column: string
  id: string
  value: string | number
}

function preconditionOf(op: WriteOperation): Precondition[] {
  switch (op.kind) {
    case 'updateAccount':
      return [{ table: 'accounts', column: 'balance', id: op.account.id, value: op.expectedBalance }]
    case 'updateLoanSettled':
      return [
        {
          table: 'loans',
          column: 'settled_amount',
          id: op.loan.id,
          value: op.expectedSettledAmount,
        },
      ]
    case 'updateWishStatus':
      return [{ table: 'wishes', column: 'status', id: op.wish.id, value: op.expectedStatus }]
    case 'createLoan':
    case 'createTransaction':
      return []
  }
}

/**
 * すべての前提条件を1文で確かめる番人。
 *
 * 先頭の条件を「値を変えない UPDATE」の対象にし、残りを EXISTS で足す。
 * 全部そろって初めて1行を更新し、changes() が1になる。
 *
 * 前提条件を後続の文にばらして持たせない理由は、途中の文が先に対象の行を
 * 書き換えてしまい、あとの条件がその新しい値を見てしまうため。判定は必ず
 * 「何も書き換えていない時点」で済ませる。
 */
function guardStatement(db: D1Database, preconditions: Precondition[]): D1PreparedStatement {
  const [head, ...rest] = preconditions
  const exists = rest
    .map((p) => ` AND EXISTS (SELECT 1 FROM ${p.table} WHERE id = ? AND ${p.column} = ?)`)
    .join('')

  return db
    .prepare(
      `UPDATE ${head.table} SET updated_at = updated_at WHERE id = ? AND ${head.column} = ?${exists}`,
    )
    .bind(head.id, head.value, ...rest.flatMap((p) => [p.id, p.value]))
}
