import type { Account } from './account'
import type { Lending } from './lending'
import { addMoney, isPositiveMoney, subMoney, ZERO_MONEY, type Money } from './money'
import type { MonthlyBalance } from './monthlyBalance'
import type { Wish } from './wish'

/** 平均月間余剰の算出に用いる遡及月数。 */
export const AVERAGE_SURPLUS_MONTHS = 3

/**
 * 実質資産の内訳。
 * ダッシュボードで内訳表示するため、合計値だけでなく構成要素も保持する。
 */
export type NetAssetBreakdown = {
  /** 現金・預金の残高合計。 */
  cashTotal: Money
  /** 未回収立替の合計。 */
  outstandingLendings: Money
  /** 確定支出の合計（正の値で保持）。 */
  commitments: Money
}

/**
 * 実質資産。cashTotal + outstandingLendings - commitments。
 *
 * commitments を正で保持して減算するのは、表示時に「確定支出: 80,000円」と
 * 出したいため。符号反転を1箇所に閉じ込める。
 */
export function netAsset(b: NetAssetBreakdown): Money {
  return subMoney(addMoney(b.cashTotal, b.outstandingLendings), b.commitments)
}

/**
 * 実質資産の内訳を算出する。引数の配列は変更しない。
 *
 * 不変条件:
 *   - kind が investment の口座は cashTotal に含めない（不変条件1）
 *   - status が committed 以外のウィッシュは commitments に含めない（不変条件3）
 *   - 立替は回収済みの分を除いた未回収残高のみを加算する（不変条件4）
 */
export function calculateBreakdown(
  accounts: readonly Account[],
  lendings: readonly Lending[],
  wishes: readonly Wish[],
): NetAssetBreakdown {
  let cashTotal = ZERO_MONEY
  let outstandingLendings = ZERO_MONEY
  let commitments = ZERO_MONEY

  for (const a of accounts) {
    if (a.countsTowardNetAsset()) cashTotal = addMoney(cashTotal, a.balance)
  }
  for (const l of lendings) {
    outstandingLendings = addMoney(outstandingLendings, l.outstanding())
  }
  for (const w of wishes) {
    if (w.isCommitment()) commitments = addMoney(commitments, w.amount)
  }

  return { cashTotal, outstandingLendings, commitments }
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
