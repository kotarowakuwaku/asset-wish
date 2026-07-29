import { domainError } from './errors'
import { isNegativeMoney, isPositiveMoney, subMoney, type Money } from './money'
import type { YearMonth } from './yearMonth'

/**
 * 月次収支。
 *
 * すべて readonly。金額を書き換える操作は API に無く、更新は
 * 同じ年月で作り直す（upsert）形になる。
 */
export class MonthlyBalance {
  readonly id: string
  readonly yearMonth: YearMonth
  readonly income: Money
  readonly expense: Money

  private constructor(id: string, yearMonth: YearMonth, income: Money, expense: Money) {
    this.id = id
    this.yearMonth = yearMonth
    this.income = income
    this.expense = expense
  }

  /**
   * 月次収支を生成する。income または expense が負なら投げる。
   *
   * Go 版にあった「年月がゼロ値なら不正」の検査は移植していない。
   * YearMonth を作る経路がコンストラクタしか無く、型が保証する。
   */
  static create(id: string, yearMonth: YearMonth, income: Money, expense: Money): MonthlyBalance {
    if (isNegativeMoney(income)) throw domainError('NEGATIVE_AMOUNT')
    if (isNegativeMoney(expense)) throw domainError('NEGATIVE_AMOUNT')
    return new MonthlyBalance(id, yearMonth, income, expense)
  }

  /** DB から復元する。検証内容は create と同じ。 */
  static restore(id: string, yearMonth: YearMonth, income: Money, expense: Money): MonthlyBalance {
    return MonthlyBalance.create(id, yearMonth, income, expense)
  }

  /** 月間余剰。負値なら赤字。 */
  surplus(): Money {
    return subMoney(this.income, this.expense)
  }

  isSurplus(): boolean {
    return isPositiveMoney(this.surplus())
  }

  isDeficit(): boolean {
    return isNegativeMoney(this.surplus())
  }
}
