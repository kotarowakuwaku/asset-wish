import type { Account } from './account'
import type { Loan } from './loan'
import { addMoney, subMoney, ZERO_MONEY, type Money } from './money'
import type { Wish } from './wish'

// 実質資産と、**実質資産の外に置く参考値**（投資・貸借）を出す。
//
// 参考値をここに同居させているのは、「実質資産に足すか足さないか」が
// 対で読めるようにするため。**足さないものを足さないと決めているのも
// 実質資産の定義の一部**（不変条件1・4）。
//
// ウィッシュの到達（不足額・何ヶ月）は wishProgress.ts、月次の平均は
// monthlySummary.ts。名前と中身をずらさない。

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
