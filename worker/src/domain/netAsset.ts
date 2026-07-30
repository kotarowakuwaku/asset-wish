import type { Account } from './account'
import type { Loan } from './loan'
import { addMoney, isPositiveMoney, subMoney, ZERO_MONEY, type Money } from './money'
import type { MonthlyBalance } from './monthlyBalance'
import type { Wish } from './wish'
import type { YearMonth } from './yearMonth'

/** 平均月間余剰の算出に用いる遡及月数。 */
export const AVERAGE_SURPLUS_MONTHS = 3

/**
 * 実質資産の内訳。
 * ダッシュボードで内訳表示するため、合計値だけでなく構成要素も保持する。
 *
 * **未精算の貸し借りはここに入れない。** 貸し借りは実質資産の外の参考値になった
 * （不変条件4）。この型に持たせたまま netAsset() で無視すると、「内訳に
 * あるのに合計に入っていない項目」ができ、あとから足し戻されうる。
 * 全フィールドを必ず使う形にしておけば、その事故が起こらない。
 */
export type NetAssetBreakdown = {
  /** 現金・預金の残高合計。 */
  cashTotal: Money
  /** 確定支出の合計（正の値で保持）。 */
  commitments: Money
}

/**
 * 実質資産。cashTotal - commitments。
 *
 * commitments を正で保持して減算するのは、表示時に「確定支出: 80,000円」と
 * 出したいため。符号反転を1箇所に閉じ込める。
 */
export function netAsset(b: NetAssetBreakdown): Money {
  return subMoney(b.cashTotal, b.commitments)
}

/**
 * 実質資産の内訳を算出する。引数の配列は変更しない。
 *
 * 不変条件:
 *   - kind が investment の口座は cashTotal に含めない（不変条件1）
 *   - status が committed 以外のウィッシュは commitments に含めない（不変条件3）
 *
 * 貸し借りを受け取らないのは、実質資産に一切関与しなくなったため。引数に残すと
 * 「使わない引数」ができ、読む側が関与を疑う。参考値は
 * calculateOutstandingLoans が別に出す。
 */
export function calculateBreakdown(
  accounts: readonly Account[],
  wishes: readonly Wish[],
): NetAssetBreakdown {
  let cashTotal = ZERO_MONEY
  let commitments = ZERO_MONEY

  for (const a of accounts) {
    if (a.countsTowardNetAsset()) cashTotal = addMoney(cashTotal, a.balance)
  }
  for (const w of wishes) {
    if (w.isCommitment()) commitments = addMoney(commitments, w.amount)
  }

  return { cashTotal, commitments }
}

/**
 * 投資区分の口座の合計を返す。
 * これは実質資産には含めず、参考値として別枠で表示する（不変条件1）。
 */
export function calculateInvestmentTotal(accounts: readonly Account[]): Money {
  let total = ZERO_MONEY
  for (const a of accounts) {
    if (a.kind === 'investment') total = addMoney(total, a.balance)
  }
  return total
}

/** 未精算残高を向きごとに分けた合計。 */
export type OutstandingLoans = {
  /** 貸していて、まだ返ってきていない額。 */
  lent: Money
  /** 借りていて、まだ返していない額。 */
  borrowed: Money
}

/**
 * 未精算の貸し借りを向きごとに合計して返す。
 *
 * **実質資産には含めない。投資資産と同じ、別枠の参考値である（不変条件4）。**
 * 立て替えた時点で現金が出たとは限らない（カード払いなら引き落としはまだ）。
 * 「貸した ＝ 現金が出た」と決め打ちできないため、残高にも実質資産にも触らせず、
 * 「返ってくる／返す予定の額」として横に置くだけにする。
 *
 * **差額にまとめない。** 貸しと借りを引き算すると、誰にいくら貸しているのかが
 * 消える。どちらも正の値で持ち、表示側が2行に並べる。
 */
export function calculateOutstandingLoans(loans: readonly Loan[]): OutstandingLoans {
  let lent = ZERO_MONEY
  let borrowed = ZERO_MONEY

  for (const l of loans) {
    if (l.direction === 'lent') lent = addMoney(lent, l.outstanding())
    else borrowed = addMoney(borrowed, l.outstanding())
  }

  return { lent, borrowed }
}

/**
 * 不足額を返す。負値ならすでに達成可能。
 * ウィッシュごとに独立して算出する。複数ウィッシュの合計とは比較しない。
 */
export function calculateShortfall(wish: Wish, currentNetAsset: Money): Money {
  return subMoney(wish.amount, currentNetAsset)
}

/**
 * 直近 months ヶ月の月間余剰の平均を返す。件数が 0 なら null。
 *
 * balances は年月の昇降順を問わない。内部でコピーして降順に整列するため、
 * 引数の配列は変更しない。件数が months 未満なら存在する分だけで平均する。
 * 平均は0方向への切り捨て。
 *
 * null は「算出不可」であって 0 ではない。0 として扱うと「余剰なし」に見える。
 */
export function averageSurplus(balances: readonly MonthlyBalance[], months: number): Money | null {
  if (balances.length === 0 || months <= 0) return null

  const sorted = [...balances].sort((a, b) => b.yearMonth.compare(a.yearMonth)) // 降順
  const n = Math.min(months, sorted.length)

  let sum = ZERO_MONEY
  for (const m of sorted.slice(0, n)) {
    sum = addMoney(sum, m.surplus())
  }
  return Math.trunc(sum / n) as Money
}

/**
 * 目標到達までの月数を返す。切り上げ。
 *
 *   shortfall  <= 0 → null（すでに達成可能）
 *   avgSurplus <= 0 → null（積み上がらないため到達しない）
 *
 * null は「算出不可」。0 として出すと「今月中に届く」と読める。
 *
 * Go 版は整数の切り上げ除算 (a + b - 1) / b だった。JavaScript の除算は必ず
 * 浮動小数点を経由するため同じ式は再現できない。Money は安全整数の範囲に
 * 収まる円額であり（不変条件11）、この規模では ceil の結果は整数除算と一致する。
 */
export function monthsToReach(shortfall: Money, avgSurplus: Money): number | null {
  if (!isPositiveMoney(shortfall) || !isPositiveMoney(avgSurplus)) return null
  return Math.ceil(shortfall / avgSurplus)
}

/**
 * 期限までに毎月いくら貯めればよいかを返す。
 *
 * `monthsToReach`（この余剰なら何ヶ月かかるか）とちょうど逆向きの計算で、
 * 「いつまでに欲しいか」が決まっているウィッシュに対して使う。
 *
 *   shortfall <= 0 → null（すでに達成可能）
 *   deadline が無い → null（期限が無ければ「毎月いくら」も決まらない）
 *   期限が過ぎている → null（間に合わない。0 を返すと達成済みに見える）
 *
 * 期限が当月なら残り1ヶ月として扱う。**今月中に全額、という意味になる。**
 * 0ヶ月で割ると無限大になるうえ、「今月が期限」は「今月払う」であって
 * 「もう間に合わない」ではない。
 */
export function monthlySavingNeeded(
  shortfall: Money,
  deadline: YearMonth | null,
  current: YearMonth,
): Money | null {
  if (!isPositiveMoney(shortfall) || deadline === null) return null

  const remaining = current.monthsUntil(deadline)
  if (remaining < 0) return null

  return Math.ceil(shortfall / (remaining + 1)) as Money
}
