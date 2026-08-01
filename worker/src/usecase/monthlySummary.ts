import { summarizeMonths, type MonthlySummary } from '../domain/monthlySummary'
import type { MonthlyBalanceRepository, TransactionRepository } from './port'

/**
 * 月次の収支を明細から組み立てる。
 *
 * **手入力の経路は無い。** 入出金の明細を打てば、その月の収支は自動で出る。
 * 同じ数字を2箇所に入れさせないため、月次収支の登録 API と画面は廃止した
 *（docs/spec-changes.md 4）。
 *
 * 明細が1件も無い月に限り、廃止前に手入力された `monthly_balances` の値を
 * 使う。**テーブルを残しているのは過去の記録のためで、新しく書く経路は無い。**
 */
export class MonthlySummaryUsecase {
  readonly #transactions: TransactionRepository
  readonly #balances: MonthlyBalanceRepository

  constructor(transactions: TransactionRepository, balances: MonthlyBalanceRepository) {
    this.#transactions = transactions
    this.#balances = balances
  }

  /**
   * 年月の降順で全件返す。
   *
   * 集計は domain の純粋関数が持つ（不変条件8）。SQL で GROUP BY せず全件を
   * 取ってくるのは、集計をテストするのに DB が要らなくなるため。データ規模は
   * 年間数百件なので全件取得で足りる。
   */
  async list(): Promise<MonthlySummary[]> {
    const [transactions, balances] = await Promise.all([
      this.#transactions.listAll(),
      this.#balances.listAll(),
    ])
    return summarizeMonths(transactions, balances)
  }
}
