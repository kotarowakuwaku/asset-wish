import { domainError } from './errors'
import { addMoney, isZeroMoney, ZERO_MONEY, type Money } from './money'
import type { IsoDate } from './time'
import { YearMonth } from './yearMonth'

/** 適用日として指定できる日。月末の無い月は、その月の末日に丸める。 */
const MIN_DAY_OF_MONTH = 1
const MAX_DAY_OF_MONTH = 31

/** 生成と復元に共通の検証。適用済み年月はここでは見ない。 */
function validate(name: string, amount: Money, dayOfMonth: number): void {
  if (name.trim() === '') throw domainError('EMPTY_TITLE')
  // 0 円は残高が動かない。定期として登録する意味が無い。
  if (isZeroMoney(amount)) throw domainError('INVALID_AMOUNT')
  if (
    !Number.isInteger(dayOfMonth) ||
    dayOfMonth < MIN_DAY_OF_MONTH ||
    dayOfMonth > MAX_DAY_OF_MONTH
  ) {
    throw domainError('INVALID_DAY_OF_MONTH')
  }
}

/**
 * 毎月決まった日に口座を増減させるもの。給料・家賃など。
 *
 * **金額は符号付き。** 給料は正、家賃は負。入出金の明細（`Transaction.amount`）
 * と同じ約束にしてある。向きを別の項目にすると、同じ値の表現が2つになる。
 *
 * 適用は「アプリを開いたときにまとめて」行う。背景で勝手に動かない分、何が
 * 起きたかが常に見える（docs/decisions.md 2.5）。2ヶ月開かなければ、開いた
 * 時点で2ヶ月分をまとめて適用する。
 */
export class RecurringEntry {
  readonly id: string
  readonly name: string
  readonly accountId: string
  /** 符号付き。口座から出るときは負、入るときは正。 */
  readonly amount: Money
  /** 毎月の適用日。1〜31。 */
  readonly dayOfMonth: number
  /** この年月までは適用済み。次に適用するのはこの翌月から。 */
  #appliedThrough: YearMonth

  private constructor(
    id: string,
    name: string,
    accountId: string,
    amount: Money,
    dayOfMonth: number,
    appliedThrough: YearMonth,
  ) {
    this.id = id
    this.name = name
    this.accountId = accountId
    this.amount = amount
    this.dayOfMonth = dayOfMonth
    this.#appliedThrough = appliedThrough
  }

  get appliedThrough(): YearMonth {
    return this.#appliedThrough
  }

  /**
   * 定期入出金を作る。
   *
   * **適用の起点は登録した月。** そのため `appliedThrough` には登録月の前月を
   * 入れる。当月の適用日をすでに過ぎていれば、登録直後の適用で当月分が入る。
   * 過ぎていなければ何も起きない。
   *
   * 「未適用」を null で表さないのは、null の場合分けを算出から消すため。
   * 前月を入れておけば、未適用月は常に「appliedThrough の翌月から」で足りる。
   */
  static create(
    id: string,
    name: string,
    accountId: string,
    amount: Money,
    dayOfMonth: number,
    currentMonth: YearMonth,
  ): RecurringEntry {
    validate(name, amount, dayOfMonth)
    return new RecurringEntry(id, name, accountId, amount, dayOfMonth, currentMonth.addMonths(-1))
  }

  /**
   * DB から復元する。
   *
   * `create` と違い `appliedThrough` をそのまま受け取る。起点を決めるのは
   * 登録のときだけで、復元は保存されている進み具合をそのまま持ち上げる。
   * 検証は同じものを通す（CHECK 制約をすり抜けた値の関門）。
   */
  static restore(
    id: string,
    name: string,
    accountId: string,
    amount: Money,
    dayOfMonth: number,
    appliedThrough: YearMonth,
  ): RecurringEntry {
    validate(name, amount, dayOfMonth)
    return new RecurringEntry(id, name, accountId, amount, dayOfMonth, appliedThrough)
  }

  /**
   * その月の適用日を返す。
   *
   * **31 日を指定した2月のように、指定日が存在しない月はその月の末日に丸める。**
   * 翌月に送ると、2月分が3月1日に入って「2月は適用されていない」ように見える。
   */
  dueDateIn(month: YearMonth): IsoDate {
    const day = Math.min(this.dayOfMonth, month.daysInMonth())
    return `${month.toString()}-${String(day).padStart(2, '0')}` as IsoDate
  }

  /**
   * まだ適用していない月を、古い順に返す。
   *
   * 適用日が来ていない月は含めない。8月1日に「毎月25日 給料」を登録しても、
   * その日はまだ来ていないので8月分は入らない。
   *
   * 日付の比較は 'YYYY-MM-DD' の文字列比較で足りる。桁が固定なので、辞書順が
   * そのまま時系列順になる（domain に Date を持ち込まないための約束）。
   */
  pendingMonths(today: IsoDate): YearMonth[] {
    const months: YearMonth[] = []
    let month = this.#appliedThrough.addMonths(1)

    // 上限を置くのは、日付が壊れた値だったときに無限に回さないため。
    // 12ヶ月を超えて開かなかった分は、必要なら明細で手当てする。
    for (let i = 0; i < 12; i++) {
      if (this.dueDateIn(month) > today) break
      months.push(month)
      month = month.addMonths(1)
    }
    return months
  }

  /**
   * 指定した月まで適用済みにする。
   *
   * 巻き戻しは許さない。同じ月を二度適用する経路ができ、残高が二重に動く。
   */
  markAppliedThrough(month: YearMonth): void {
    if (!month.after(this.#appliedThrough)) throw domainError('INVALID_TRANSITION')
    this.#appliedThrough = month
  }
}

/** 適用しようとしている1件。どの定期入出金の、どの月分か。 */
export type PendingApplication = {
  entry: RecurringEntry
  month: YearMonth
}

/**
 * まだ適用していない分を、定期入出金をまたいで集める。
 *
 * ダッシュボードの「2件適用しますか？」と、実際の適用の両方がこれを使う。
 * 数える側と適用する側で判定がずれると、**出ていた件数と実際に動く件数が
 * 食い違う。**
 */
export function pendingApplications(
  entries: readonly RecurringEntry[],
  today: IsoDate,
): PendingApplication[] {
  const pending: PendingApplication[] = []
  for (const entry of entries) {
    for (const month of entry.pendingMonths(today)) {
      pending.push({ entry, month })
    }
  }
  return pending
}

/** 未適用分の合計。符号付きなので、収入と支出は相殺される。 */
export function pendingTotal(pending: readonly PendingApplication[]): Money {
  let total = ZERO_MONEY
  for (const p of pending) total = addMoney(total, p.entry.amount)
  return total
}
