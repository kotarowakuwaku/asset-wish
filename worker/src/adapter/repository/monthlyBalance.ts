import { MonthlyBalance } from '../../domain/monthlyBalance'
import { YearMonth } from '../../domain/yearMonth'
import type { MonthlyBalanceRepository } from '../../usecase/port'
import { toMoney } from './d1'

const COLUMNS = 'id, year_month, income, expense'

export type MonthlyBalanceRow = {
  id: string
  year_month: string
  income: number
  expense: number
}

export function toMonthlyBalance(row: MonthlyBalanceRow): MonthlyBalance {
  return MonthlyBalance.restore(
    row.id,
    // 'YYYY-MM' 形式。不正なら YearMonth が投げる（CHECK 制約の裏をかいた値の関門）。
    YearMonth.parse(row.year_month),
    toMoney('monthly_balances', 'income', row.id, row.income),
    toMoney('monthly_balances', 'expense', row.id, row.expense),
  )
}

/**
 * 手入力の月次収支を読むだけのリポジトリ。
 *
 * **書き込む文を持たない。** 月次の収支は明細から集計する形に変えたため、
 * この表に新しく書く経路は無い（docs/spec-changes.md 4）。upsert を消して
 * あるのは、書ける文が残っていると、同じ月について明細と手入力の2つの真実が
 * できるため。**SQL に無い操作は、上の層がどう間違えても起こせない。**
 *
 * 表そのものを落としていないのは、明細を打ち始める前の月の記録だから。
 * 明細が1件も無い月に限って、この値が集計に混ざる。
 */
export class D1MonthlyBalanceRepository implements MonthlyBalanceRepository {
  readonly #db: D1Database

  constructor(db: D1Database) {
    this.#db = db
  }

  async listAll(): Promise<MonthlyBalance[]> {
    const { results } = await this.#db
      .prepare(`SELECT ${COLUMNS} FROM monthly_balances ORDER BY year_month DESC`)
      .all<MonthlyBalanceRow>()
    return results.map(toMonthlyBalance)
  }
}
