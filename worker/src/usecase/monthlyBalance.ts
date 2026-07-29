import type { Money } from '../domain/money'
import { MonthlyBalance } from '../domain/monthlyBalance'
import type { YearMonth } from '../domain/yearMonth'
import type { IDGenerator, MonthlyBalanceRepository } from './port'

export class MonthlyBalanceUsecase {
  readonly #balances: MonthlyBalanceRepository
  readonly #newID: IDGenerator

  constructor(balances: MonthlyBalanceRepository, newID: IDGenerator) {
    this.#balances = balances
    this.#newID = newID
  }

  /** 年月の降順で全件返す。 */
  list(): Promise<MonthlyBalance[]> {
    return this.#balances.listAll()
  }

  /**
   * 同じ年月への再登録を上書きとして扱う（冪等）。
   *
   * 戻り値は保存後の姿。既存の月を上書きした場合、ID は既存行のものになるため、
   * 採番した ID をそのまま返すと DB に無い ID を返すことになる。
   */
  // async にしているのは、検証エラーを同期の throw ではなく reject にするため。
  // 呼び出し側が Promise を受け取る前に投げられると、await で捕まえられない。
  async upsert(yearMonth: YearMonth, income: Money, expense: Money): Promise<MonthlyBalance> {
    const m = MonthlyBalance.create(this.#newID(), yearMonth, income, expense)
    return this.#balances.upsert(m)
  }
}
