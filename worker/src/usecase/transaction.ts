import { negateMoney, type Money } from '../domain/money'
import type { IsoDate } from '../domain/time'
import { Transaction } from '../domain/transaction'
import type {
  AccountRepository,
  AtomicWriter,
  Clock,
  IDGenerator,
  TransactionRepository,
  WriteOperation,
} from './port'

/**
 * 取引履歴の既定の取得件数。
 *
 * 履歴は「残高が動いた理由を後から辿る」ためのもので、古いものまで一度に
 * 見る場面が無い。データ規模は年間数百件なので、上限を設けても実用上は困らない。
 */
export const DEFAULT_TRANSACTION_LIMIT = 100

export class TransactionUsecase {
  readonly #writer: AtomicWriter
  readonly #transactions: TransactionRepository
  readonly #accounts: AccountRepository
  readonly #now: Clock
  readonly #newID: IDGenerator

  constructor(
    writer: AtomicWriter,
    transactions: TransactionRepository,
    accounts: AccountRepository,
    now: Clock,
    newID: IDGenerator,
  ) {
    this.#writer = writer
    this.#transactions = transactions
    this.#accounts = accounts
    this.#now = now
    this.#newID = newID
  }

  /** 発生日の降順で返す。limit が 0 以下なら既定の件数を使う。 */
  list(limit: number): Promise<Transaction[]> {
    return this.#transactions.list(limit <= 0 ? DEFAULT_TRANSACTION_LIMIT : limit)
  }

  /**
   * 入出金の明細を1件打ち、口座残高を同額だけ動かす。
   *
   * amount は符号付き。口座から出るときは負、入るときは正。向きを別の項目で
   * 受けないのは、Transaction.amount がもともと符号付きで確定しており、
   * 一覧も符号付きで返しているため。入口だけ形を変えると表現が2つになる。
   *
   * 種別は adjustment。分類（カテゴリ）は持たない。何に使ったかは note を
   * 読めば分かる（docs/spec-changes.md 3）。
   *
   * **残高の更新と履歴の記録は必ず同じ batch に載せる（不変条件10）。**
   * 片方だけ残ると、残高の裏付けを辿れない行か、裏付けの無い残高ができる。
   */
  async create(
    accountId: string,
    amount: Money,
    occurredOn: IsoDate,
    note: string,
  ): Promise<Transaction> {
    // 先に組み立てるのは、金額0（INVALID_AMOUNT）を口座に触る前に落とすため。
    const t = Transaction.create(this.#newID(), accountId, amount, 'adjustment', null, occurredOn, note)

    const account = await this.#accounts.get(accountId)
    const expectedBalance = account.balance
    account.applyDelta(amount, this.#now())

    const ops: WriteOperation[] = [
      { kind: 'updateAccount', account, expectedBalance },
      { kind: 'createTransaction', transaction: t },
    ]
    await this.#writer.writeAll(ops)
    return t
  }

  /**
   * 明細を消し、動かした分の残高を戻す。
   *
   * 消せるのは手入力の明細だけで、判定は domain の ensureDeletable が持つ
   *（不変条件6）。ウィッシュや貸し借りに紐づく履歴は 422 になる。
   *
   * 打ち消しの明細を足す方式は採っていない。打ち間違いが一覧に残り続け、
   * 1件の誤りが2行に増えるため。
   *
   * 2つのタブから同じ明細を消しても、2度目は残高が食い違って ConflictError に
   * なる。残高を二重に戻すことはない。
   */
  async delete(id: string): Promise<void> {
    const t = await this.#transactions.get(id)
    t.ensureDeletable()

    const account = await this.#accounts.get(t.accountId)
    const expectedBalance = account.balance
    account.applyDelta(negateMoney(t.amount), this.#now())

    const ops: WriteOperation[] = [
      { kind: 'updateAccount', account, expectedBalance },
      { kind: 'deleteTransaction', transaction: t },
    ]
    await this.#writer.writeAll(ops)
  }
}
