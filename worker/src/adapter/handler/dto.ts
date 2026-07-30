// レスポンスのキーは lowerCamelCase、金額は整数（円）、日付は YYYY-MM-DD。
// 金額を文字列にしないのは、クライアント側で数値として扱うため。
// JavaScript の安全な整数の範囲に十分収まる。
//
// **front/src/api/types.ts と一対一で対応させる。** 片方だけ変えると、
// 型は通るのに実行時に undefined を触ることになる。

import { STALE_BALANCE_THRESHOLD_MS, type Account } from '../../domain/account'
import type { Lending } from '../../domain/lending'
import type { MonthlyBalance } from '../../domain/monthlyBalance'
import type { Instant } from '../../domain/time'
import type { Transaction } from '../../domain/transaction'
import type { Wish } from '../../domain/wish'
import type { Dashboard } from '../../usecase/dashboard'

export function accountResponse(a: Account, now: Instant) {
  return {
    id: a.id,
    name: a.name,
    kind: a.kind,
    balance: a.balance,
    updatedAt: a.updatedAt,
    // 残高の更新を促すための導出値。
    isStale: a.isStale(now, STALE_BALANCE_THRESHOLD_MS),
  }
}

export function lendingResponse(l: Lending) {
  return {
    id: l.id,
    counterparty: l.counterparty,
    description: l.description,
    amount: l.amount,
    // collectedAmount 以外は導出値。DB は持たない（不変条件12）。
    collectedAmount: l.collectedAmount,
    outstanding: l.outstanding(),
    status: l.status(),
    occurredOn: l.occurredOn,
  }
}

export function wishResponse(w: Wish) {
  return {
    id: w.id,
    title: w.title,
    amount: w.amount,
    category: w.category,
    status: w.status,
    priority: w.priority,
    // 未設定なら null。
    deadline: w.deadline,
  }
}

export function monthlyBalanceResponse(m: MonthlyBalance) {
  return {
    id: m.id,
    yearMonth: m.yearMonth.toString(),
    income: m.income,
    expense: m.expense,
    // 導出値。クライアントは符号で黒字・赤字を判定する。
    surplus: m.surplus(),
  }
}

export function transactionResponse(t: Transaction) {
  return {
    id: t.id,
    accountId: t.accountId,
    amount: t.amount,
    kind: t.kind,
    refId: t.refId,
    occurredOn: t.occurredOn,
  }
}

export function dashboardResponse(d: Dashboard) {
  return {
    netAsset: d.netAsset,
    breakdown: {
      cashTotal: d.breakdown.cashTotal,
      commitments: d.breakdown.commitments,
    },
    // investmentTotal と outstandingLendings はどちらも実質資産の外の参考値。
    // breakdown に混ぜないのは、合計に足されない値だと形で示すため
    // （不変条件1・4）。
    investmentTotal: d.investmentTotal,
    outstandingLendings: d.outstandingLendings,
    // 算出不可のときは 0 を返すが、hasAverageSurplus が false なので
    // クライアントは表示しない。
    averageSurplus: d.averageSurplus ?? 0,
    hasAverageSurplus: d.averageSurplus !== null,
    wishes: d.wishes.map((w) => ({
      ...wishResponse(w.wish),
      shortfall: w.shortfall,
      // 算出不可なら null。0 を返すと「今月中に届く」と誤読される。
      monthsToReach: w.monthsToReach,
      // 期限までに毎月いくら貯めればよいか。期限が無ければ null。
      monthlySavingNeeded: w.monthlySavingNeeded,
    })),
  }
}
