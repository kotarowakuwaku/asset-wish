import type { Account } from '../domain/account'
import type { Money } from '../domain/money'
import { pendingApplications, RecurringEntry, type PendingApplication } from '../domain/recurring'
import { dateOf, yearMonthOf } from '../domain/time'
import { Transaction } from '../domain/transaction'
import { YearMonth } from '../domain/yearMonth'
import type {
  AccountRepository,
  AtomicWriter,
  Clock,
  IDGenerator,
  RecurringRepository,
  WriteOperation,
} from './port'

export class RecurringUsecase {
  readonly #writer: AtomicWriter
  readonly #recurring: RecurringRepository
  readonly #accounts: AccountRepository
  readonly #now: Clock
  readonly #newID: IDGenerator

  constructor(
    writer: AtomicWriter,
    recurring: RecurringRepository,
    accounts: AccountRepository,
    now: Clock,
    newID: IDGenerator,
  ) {
    this.#writer = writer
    this.#recurring = recurring
    this.#accounts = accounts
    this.#now = now
    this.#newID = newID
  }

  list(): Promise<RecurringEntry[]> {
    return this.#recurring.list()
  }

  /**
   * 定期入出金を登録する。**この時点では口座を触らない。**
   *
   * 適用の起点は登録した月で、当月の適用日をすでに過ぎていれば次の apply で
   * 当月分が入る。登録と適用を同じ操作にしないのは、「登録しただけのつもりが
   * 残高が動いた」を避けるため。適用は必ず明示的に行う。
   */
  async create(
    name: string,
    accountId: string,
    amount: Money,
    dayOfMonth: number,
  ): Promise<RecurringEntry> {
    // 口座の存在をここで確かめる。存在しなければ 404。
    await this.#accounts.get(accountId)

    const e = RecurringEntry.create(
      this.#newID(),
      name,
      accountId,
      amount,
      dayOfMonth,
      YearMonth.parse(yearMonthOf(this.#now())),
    )
    await this.#recurring.create(e)
    return e
  }

  async delete(id: string): Promise<void> {
    await this.#recurring.get(id)
    await this.#recurring.delete(id)
  }

  /**
   * まだ適用していない分を、古い順に並べて返す。
   *
   * 適用日が来ていない月は含まない。ダッシュボードで「2件適用しますか？」と
   * 出すための材料で、**この呼び出しでは何も書き込まない。**
   */
  async pending(): Promise<PendingApplication[]> {
    // 集めるのは domain の純粋関数。数える側と適用する側で判定がずれると、
    // 画面に出ていた件数と実際に動く件数が食い違う。
    return pendingApplications(await this.#recurring.list(), dateOf(this.#now()))
  }

  /**
   * 未適用の分をまとめて適用する。適用した件数を返す。
   *
   * 口座残高の増減・取引履歴の記録・適用済み年月の更新を**1回の書き込みに
   * まとめる**（不変条件10）。途中で切れると、残高だけ動いて「適用済み」に
   * ならず、次に開いたときに二重に適用される。
   *
   * **口座ごとに updateAccount を1本にまとめている。** 同じ口座に対する更新を
   * 2本並べると、2本目の「読み取り時の残高」が1本目の適用後の値と食い違い、
   * 番人（楽観ロック）が必ず失敗する。増減を先に合算してから1本にする。
   */
  async apply(): Promise<number> {
    const pending = await this.pending()
    if (pending.length === 0) return 0

    const ops: WriteOperation[] = []
    const touched = new Map<string, { account: Account; expectedBalance: Money }>()

    for (const { entry, month } of pending) {
      let target = touched.get(entry.accountId)
      if (target === undefined) {
        const account = await this.#accounts.get(entry.accountId)
        target = { account, expectedBalance: account.balance }
        touched.set(entry.accountId, target)
      }
      target.account.applyDelta(entry.amount, this.#now())

      ops.push({
        kind: 'createTransaction',
        transaction: Transaction.create(
          this.#newID(),
          entry.accountId,
          entry.amount,
          'recurring_applied',
          entry.id,
          entry.dueDateIn(month),
          // 名称を写しておく。定期入出金を消しても、履歴が何だったか読める。
          entry.name,
        ),
      })
    }

    // 適用済み年月は、その定期入出金の最後の月まで一度に進める。月ごとに
    // 1本ずつ更新すると、同じ行への更新が並んで口座と同じ問題が起きる。
    for (const entry of new Set(pending.map((p) => p.entry))) {
      const expectedAppliedThrough = entry.appliedThrough.toString()
      const months = pending.filter((p) => p.entry === entry).map((p) => p.month)
      entry.markAppliedThrough(months[months.length - 1])
      ops.push({ kind: 'updateRecurringApplied', entry, expectedAppliedThrough })
    }

    for (const { account, expectedBalance } of touched.values()) {
      ops.push({ kind: 'updateAccount', account, expectedBalance })
    }

    await this.#writer.writeAll(ops)
    return pending.length
  }
}
