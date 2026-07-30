import type { Money } from '../domain/money'
import {
  AVERAGE_SURPLUS_MONTHS,
  averageSurplus,
  calculateBreakdown,
  calculateInvestmentTotal,
  calculateOutstandingLoans,
  calculateShortfall,
  monthlySavingNeeded,
  monthsToReach,
  netAsset,
  type NetAssetBreakdown,
  type OutstandingLoans,
} from '../domain/netAsset'
import { yearMonthOf } from '../domain/time'
import { isTerminalWishStatus, type Wish } from '../domain/wish'
import { YearMonth } from '../domain/yearMonth'
import type {
  AccountRepository,
  Clock,
  LoanRepository,
  MonthlyBalanceRepository,
  WishRepository,
} from './port'

/** ウィッシュ1件と、それに対する導出値。 */
export type DashboardWish = {
  wish: Wish
  shortfall: Money
  /** 平均月間余剰が 0 以下、またはデータが無い場合は null（算出不可）。0 と混同しない。 */
  monthsToReach: number | null
  /** 期限までに毎月いくら貯めればよいか。期限が無い・過ぎている・達成済みなら null。 */
  monthlySavingNeeded: Money | null
}

/** トップ画面に必要な値をまとめたもの。ラウンドトリップを減らすため1本にまとめる。 */
export type Dashboard = {
  breakdown: NetAssetBreakdown
  netAsset: Money
  /** 実質資産の外の参考値（不変条件1）。 */
  investmentTotal: Money
  /**
   * 未精算の貸し借りを向きごとに分けた合計。**実質資産の外の参考値**（不変条件4）。
   * breakdown ではなくここに置いてあるのは、合計に足されない値だから。
   */
  outstanding: OutstandingLoans
  /** データが無ければ null（算出不可）。 */
  averageSurplus: Money | null
  wishes: DashboardWish[]
}

export class DashboardUsecase {
  readonly #accounts: AccountRepository
  readonly #loans: LoanRepository
  readonly #wishes: WishRepository
  readonly #balances: MonthlyBalanceRepository
  // 「期限まであと何ヶ月あるか」を出すのに現在の年月が要る。実時刻を直に
  // 読むとテストが月をまたいだ瞬間に落ちる。
  readonly #now: Clock

  constructor(
    accounts: AccountRepository,
    loans: LoanRepository,
    wishes: WishRepository,
    balances: MonthlyBalanceRepository,
    now: Clock,
  ) {
    this.#accounts = accounts
    this.#loans = loans
    this.#wishes = wishes
    this.#balances = balances
    this.#now = now
  }

  /**
   * ダッシュボードを組み立てる。
   *
   * 計算は必ず domain の関数を呼ぶ。ここで式を再実装しない（不変条件8）。
   */
  async get(): Promise<Dashboard> {
    const [accounts, loans, wishes, balances] = await Promise.all([
      this.#accounts.list(),
      // 未精算のみ。精算済みの貸し借りは返ってくる予定の額に含めない。
      this.#loans.list(true),
      this.#wishes.list(null),
      this.#balances.listRecent(AVERAGE_SURPLUS_MONTHS),
    ])

    const currentMonth = YearMonth.parse(yearMonthOf(this.#now()))
    const breakdown = calculateBreakdown(accounts, wishes)
    const total = netAsset(breakdown)
    const avgSurplus = averageSurplus(balances, AVERAGE_SURPLUS_MONTHS)

    const dashboardWishes: DashboardWish[] = []
    for (const wish of wishes) {
      // 終わったもの・やめたものは並べない。
      if (isTerminalWishStatus(wish.status)) continue

      const shortfall = calculateShortfall(wish, total)
      dashboardWishes.push({
        wish,
        shortfall,
        // 平均が出せないなら到達見込みも出せない。
        monthsToReach: avgSurplus === null ? null : monthsToReach(shortfall, avgSurplus),
        // こちらは平均余剰に依存しない。期限があれば必ず出せる。
        monthlySavingNeeded: monthlySavingNeeded(
          shortfall,
          wish.deadline === null ? null : YearMonth.parse(yearMonthOf(wish.deadline)),
          currentMonth,
        ),
      })
    }

    return {
      breakdown,
      netAsset: total,
      investmentTotal: calculateInvestmentTotal(accounts),
      outstanding: calculateOutstandingLoans(loans),
      averageSurplus: avgSurplus,
      wishes: dashboardWishes,
    }
  }
}
