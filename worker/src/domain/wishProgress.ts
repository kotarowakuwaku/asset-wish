import { isPositiveMoney, subMoney, type Money } from './money'
import type { Wish } from './wish'
import type { YearMonth } from './yearMonth'

// ウィッシュに「あといくら足りないか」「あと何ヶ月で届くか」を出す。
//
// **実質資産そのものの計算はここに置かない**（netAsset.ts の担当）。
// 材料として実質資産の額を受け取るだけで、その出し方は知らない。

/**
 * 不足額を返す。負値ならすでに達成可能。
 * ウィッシュごとに独立して算出する。複数ウィッシュの合計とは比較しない。
 */
export function calculateShortfall(wish: Wish, currentNetAsset: Money): Money {
  return subMoney(wish.amount, currentNetAsset)
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
