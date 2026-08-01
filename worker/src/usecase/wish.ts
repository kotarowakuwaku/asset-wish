import { negateMoney, type Money } from '../domain/money'
import type { IsoDate } from '../domain/time'
import { Transaction } from '../domain/transaction'
import { Wish, type WishCategory, type WishStatus } from '../domain/wish'
import type {
  AccountRepository,
  AtomicWriter,
  Clock,
  IDGenerator,
  WishRepository,
  WriteOperation,
} from './port'

/** PATCH の部分更新を表す。undefined の項目は変更しない。 */
export type UpdateWishInput = {
  title?: string
  amount?: Money
  category?: WishCategory
  priority?: number
  /** 期限。null を渡すと期限を外す。undefined は「変更しない」。 */
  deadline?: IsoDate | null
}
// status が無いのは、状態を動かせるのが commit / pay / drop だけのため（不変条件6）。

export class WishUsecase {
  readonly #writer: AtomicWriter
  readonly #wishes: WishRepository
  readonly #accounts: AccountRepository
  readonly #now: Clock
  readonly #newID: IDGenerator

  constructor(
    writer: AtomicWriter,
    wishes: WishRepository,
    accounts: AccountRepository,
    now: Clock,
    newID: IDGenerator,
  ) {
    this.#writer = writer
    this.#wishes = wishes
    this.#accounts = accounts
    this.#now = now
    this.#newID = newID
  }

  list(status: WishStatus | null): Promise<Wish[]> {
    return this.#wishes.list(status)
  }

  async create(
    title: string,
    amount: Money,
    category: WishCategory,
    priority: number,
    deadline: IsoDate | null,
  ): Promise<Wish> {
    const w = Wish.create(this.#newID(), { title, amount, category, priority, deadline })
    await this.#wishes.create(w)
    return w
  }

  /** 内容を更新する。状態は動かさない。検証は domain の updateContent が持つ。 */
  async updateContent(id: string, input: UpdateWishInput): Promise<Wish> {
    const w = await this.#wishes.get(id)
    w.updateContent({
      title: input.title ?? w.title,
      amount: input.amount ?? w.amount,
      category: input.category ?? w.category,
      priority: input.priority ?? w.priority,
      // null は「期限を外す」、undefined は「変更しない」。
      deadline: input.deadline === undefined ? w.deadline : input.deadline,
    })
    await this.#wishes.updateContent(w)
    return w
  }

  /** 検討中 → 確定。確定した時点で実質資産から控除される（不変条件3）。 */
  commit(id: string): Promise<Wish> {
    return this.#transit(id, (w) => w.commit())
  }

  /** 検討中 または 確定 → 見送り。 */
  drop(id: string): Promise<Wish> {
    return this.#transit(id, (w) => w.drop())
  }

  /**
   * 遷移して良いかの判定は domain の Wish が持つ。usecase は「どの遷移を
   * 起こしたいか」だけを知る（不変条件6）。
   *
   * 読み取り時の状態を条件に書き込むため、2つのタブから同時に確定しても
   * 2度目は競合として弾かれる。
   */
  async #transit(id: string, transition: (w: Wish) => void): Promise<Wish> {
    const w = await this.#wishes.get(id)
    const expectedStatus = w.status
    transition(w)
    await this.#writer.writeAll([{ kind: 'updateWishStatus', wish: w, expectedStatus }])
    return w
  }

  /**
   * 確定 → 完了に遷移させ、口座残高を減らして履歴を残す。
   *
   * 支払い後、そのウィッシュは確定支出から外れ、同額だけ残高が減る。
   * **実質資産は支払いの前後で変わらない。** これが正しい挙動になる。
   */
  async pay(id: string, accountId: string, occurredOn: IsoDate): Promise<Wish> {
    const wish = await this.#wishes.get(id)
    const expectedStatus = wish.status
    wish.pay()

    const account = await this.#accounts.get(accountId)
    const expectedBalance = account.balance
    account.applyDelta(negateMoney(wish.amount), this.#now())

    const ops: WriteOperation[] = [
      { kind: 'updateWishStatus', wish, expectedStatus },
      { kind: 'updateAccount', account, expectedBalance },
      {
        kind: 'createTransaction',
        transaction: Transaction.create(
          this.#newID(),
          accountId,
          negateMoney(wish.amount),
          'wish_paid',
          wish.id,
          occurredOn,
          // メモは手入力の明細のためのもの。参照先をたどれば何の支払いか分かる。
          '',
        ),
      },
    ]
    await this.#writer.writeAll(ops)
    return wish
  }

  async delete(id: string): Promise<void> {
    await this.#wishes.get(id)
    await this.#wishes.delete(id)
  }
}
