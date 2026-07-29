import { MonthlyBalance } from '../../domain/monthlyBalance'
import { YearMonth } from '../../domain/yearMonth'
import type { MonthlyBalanceRepository } from '../../usecase/port'
import { limitOrAll, SQL_NOW, toMoney } from './d1'

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

export class D1MonthlyBalanceRepository implements MonthlyBalanceRepository {
  readonly #db: D1Database

  constructor(db: D1Database) {
    this.#db = db
  }

  async listRecent(limit: number): Promise<MonthlyBalance[]> {
    const { results } = await this.#db
      .prepare(`SELECT ${COLUMNS} FROM monthly_balances ORDER BY year_month DESC LIMIT ?`)
      .bind(limitOrAll(limit))
      .all<MonthlyBalanceRow>()
    return results.map(toMonthlyBalance)
  }

  async listAll(): Promise<MonthlyBalance[]> {
    const { results } = await this.#db
      .prepare(`SELECT ${COLUMNS} FROM monthly_balances ORDER BY year_month DESC`)
      .all<MonthlyBalanceRow>()
    return results.map(toMonthlyBalance)
  }

  /**
   * ON CONFLICT により PUT /api/monthly-balances/{yearMonth} が冪等になる。
   *
   * id を返すのは、競合したときに渡した id が採用されないため。既存行の id は
   * そのまま維持されるので、呼び出し側が採番した UUID は捨てられる。それに
   * 気付かずレスポンスへ載せると、DB に存在しない id を返すことになる。
   */
  async upsert(m: MonthlyBalance): Promise<MonthlyBalance> {
    const row = await this.#db
      .prepare(
        `INSERT INTO monthly_balances (${COLUMNS}) VALUES (?, ?, ?, ?)
         ON CONFLICT (year_month) DO UPDATE
         SET income = excluded.income, expense = excluded.expense, updated_at = ${SQL_NOW}
         RETURNING id`,
      )
      .bind(m.id, m.yearMonth.toString(), m.income, m.expense)
      .first<{ id: string }>()
    if (row === null) throw new Error('月次収支の保存が行を返さなかった')
    return MonthlyBalance.restore(row.id, m.yearMonth, m.income, m.expense)
  }
}
