import { addMoney, isNegativeMoney, negateMoney, subMoney, ZERO_MONEY, type Money } from './money'
import type { MonthlyBalance } from './monthlyBalance'
import { yearMonthOf } from './time'
import type { Transaction } from './transaction'
import { YearMonth } from './yearMonth'

/**
 * その月の収支がどこから来たか。
 *
 * 明細を打つ運用に切り替える前の月は、手入力の月次収支しか残っていない。
 * どちらの値を見ているのかが画面から読めないと、「明細を打ったのに
 * 反映されない」ように見える。
 */
export type MonthlySource = 'entries' | 'manual'

/**
 * その月の収入・支出・余剰。
 *
 * **ID を持たない。** 明細から導出した値であって、保存された行ではない
 * （不変条件12）。ID を付けると、更新できるように見えてしまう。
 *
 * expense は正で持つ。表示が「支出 230,000円」になるため、符号の反転を
 * surplus() の1箇所に閉じ込める。MonthlyBalance と同じ体裁。
 */
export class MonthlySummary {
  readonly yearMonth: YearMonth
  readonly income: Money
  readonly expense: Money
  readonly source: MonthlySource

  private constructor(yearMonth: YearMonth, income: Money, expense: Money, source: MonthlySource) {
    this.yearMonth = yearMonth
    this.income = income
    this.expense = expense
    this.source = source
  }

  static of(
    yearMonth: YearMonth,
    income: Money,
    expense: Money,
    source: MonthlySource,
  ): MonthlySummary {
    return new MonthlySummary(yearMonth, income, expense, source)
  }

  /**
   * 月間余剰。負値なら赤字。
   *
   * 黒字・赤字の判定メソッドは置かない。画面は符号をそのまま見て色を決めており、
   * 呼ばれないメソッドを増やすと、どちらを使うべきか迷う materials になる。
   */
  surplus(): Money {
    return subMoney(this.income, this.expense)
  }
}

/**
 * 明細を月ごとに足し上げ、**明細が1件も無い月だけ**手入力の月次収支で補う。
 * 年月の降順で返す。引数の配列は変更しない。
 *
 * ## 何を足すか
 *
 * 足すのは手入力の明細（`adjustment`）だけ。ウィッシュの支払いと、過去の
 * 貸し借りの履歴は除く。**ライブ代のような臨時支出を月の余剰に混ぜると、
 * 何か買うたびに他の目標の到達見込みが悪化する。** 生活費とウィッシュ由来の
 * 支出を分けるという不変条件2の考え方を、集計にも引き継いでいる。
 *
 * ## なぜ「1件も無い月だけ」なのか
 *
 * 同じ月について明細と手入力の両方を足すと、二重計上になる。かといって
 * 手入力を一切見ないと、明細を打ち始める前の月がすべて消え、平均月間余剰が
 * 3ヶ月分貯まるまで到達見込みが出せなくなる。
 *
 * **月単位でどちらか一方に決める。** 明細が1件でもあればその月は明細が正で、
 * 手入力の値は使わない。
 */
export function summarizeMonths(
  transactions: readonly Transaction[],
  balances: readonly MonthlyBalance[],
): MonthlySummary[] {
  // 月ごとに1つだけ場所を作る。収入と支出を別々の Map に持つと、
  // 「支出しか無い月」を収入側にも登録し忘れたときに、その月が
  // 「明細が1件も無い月」と区別できなくなる。
  const byMonth = new Map<string, { income: Money; expense: Money }>()

  for (const t of transactions) {
    if (!t.isManualEntry()) continue

    const key = yearMonthOf(t.occurredOn)
    const month = byMonth.get(key) ?? { income: ZERO_MONEY, expense: ZERO_MONEY }
    if (isNegativeMoney(t.amount)) {
      // 出金は負で届く。支出は正で持つので反転する。
      month.expense = addMoney(month.expense, negateMoney(t.amount))
    } else {
      month.income = addMoney(month.income, t.amount)
    }
    byMonth.set(key, month)
  }

  const summaries = [...byMonth].map(([key, month]) =>
    MonthlySummary.of(YearMonth.parse(key), month.income, month.expense, 'entries'),
  )

  for (const b of balances) {
    // 明細が1件でもある月は明細が正。両方足すと二重計上になる。
    if (byMonth.has(b.yearMonth.toString())) continue
    summaries.push(MonthlySummary.of(b.yearMonth, b.income, b.expense, 'manual'))
  }

  return summaries.sort((a, b) => b.yearMonth.compare(a.yearMonth))
}
