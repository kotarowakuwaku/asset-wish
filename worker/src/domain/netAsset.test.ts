import { describe, expect, it } from 'vitest'
import { acct, borrow, lend, mb, wish, yen } from '../../test/support'
import type { Account } from './account'
import type { Loan } from './loan'
import {
  averageSurplus,
  calculateBreakdown,
  calculateInvestmentTotal,
  calculateOutstandingLoans,
  calculateShortfall,
  monthlySavingNeeded,
  monthsToReach,
  netAsset,
} from './netAsset'
import { YearMonth } from './yearMonth'
import type { Wish } from './wish'

describe('calculateBreakdown', () => {
  const cases: {
    name: string
    accounts?: Account[]
    wishes?: Wish[]
    wantCash?: number
    wantCommit?: number
    wantNet?: number
  }[] = [
    {
      name: 'A-1: cash only',
      accounts: [acct('cash', 500_000), acct('cash', 300_000)],
      wantCash: 800_000,
      wantNet: 800_000,
    },
    {
      name: 'A-2: investment excluded',
      accounts: [acct('cash', 500_000), acct('investment', 400_000)],
      wantCash: 500_000,
      wantNet: 500_000,
    },
    {
      name: 'A-6: committed wish deducted',
      accounts: [acct('cash', 500_000)],
      wishes: [wish(80_000, 'committed')],
      wantCash: 500_000,
      wantCommit: 80_000,
      wantNet: 420_000,
    },
    {
      name: 'A-7: considering wish NOT deducted',
      accounts: [acct('cash', 500_000)],
      wishes: [wish(80_000, 'considering')],
      wantCash: 500_000,
      wantNet: 500_000,
    },
    {
      name: 'A-8: done wish NOT deducted',
      accounts: [acct('cash', 500_000)],
      wishes: [wish(80_000, 'done')],
      wantCash: 500_000,
      wantNet: 500_000,
    },
    {
      name: 'A-9: dropped wish NOT deducted',
      accounts: [acct('cash', 500_000)],
      wishes: [wish(80_000, 'dropped')],
      wantCash: 500_000,
      wantNet: 500_000,
    },
    { name: 'A-10: all empty' },
    {
      name: 'A-11: combined dashboard example',
      accounts: [acct('cash', 910_000), acct('investment', 350_000)],
      wishes: [wish(80_000, 'committed')],
      wantCash: 910_000,
      wantCommit: 80_000,
      wantNet: 830_000,
    },
  ]

  it.each(cases)('$name', (c) => {
    const b = calculateBreakdown(c.accounts ?? [], c.wishes ?? [])
    expect(b.cashTotal).toBe(c.wantCash ?? 0)
    expect(b.commitments).toBe(c.wantCommit ?? 0)
    expect(netAsset(b)).toBe(c.wantNet ?? 0)
  })
})

describe('calculateInvestmentTotal', () => {
  it('投資区分だけを合計する', () => {
    const accounts = [acct('cash', 500_000), acct('investment', 350_000), acct('investment', 100_000)]
    expect(calculateInvestmentTotal(accounts)).toBe(450_000)
  })

  it('空なら 0', () => {
    expect(calculateInvestmentTotal([])).toBe(0)
  })
})

// 貸し借りは実質資産の外の参考値（不変条件4）。ここが壊れると、カードで
// 立て替えた分だけ資産が多く見える。
describe('calculateOutstandingLoans', () => {
  const cases: {
    name: string
    loans: Loan[]
    wantLent?: number
    wantBorrowed?: number
  }[] = [
    { name: 'A-3: 未精算は全額が残高になる', loans: [lend(12_000, 0)], wantLent: 12_000 },
    { name: 'A-4: 一部精算なら残りだけ', loans: [lend(12_000, 5_000)], wantLent: 7_000 },
    { name: 'A-5: 全額精算なら 0', loans: [lend(12_000, 12_000)] },
    {
      name: 'A-12: 同じ向きは合計する',
      loans: [lend(12_000, 0), lend(8_000, 3_000)],
      wantLent: 17_000,
    },
    { name: 'A-13: 空なら 0', loans: [] },
    { name: 'A-14: 借りた分は borrowed に入る', loans: [borrow(5_000, 0)], wantBorrowed: 5_000 },
    // 差額にすると、誰にいくら貸しているのかが消える。
    {
      name: 'A-15: 貸しと借りを混ぜず、別々に持つ',
      loans: [lend(12_000, 0), borrow(5_000, 1_000)],
      wantLent: 12_000,
      wantBorrowed: 4_000,
    },
  ]

  it.each(cases)('$name', (c) => {
    expect(calculateOutstandingLoans(c.loans)).toEqual({
      lent: c.wantLent ?? 0,
      borrowed: c.wantBorrowed ?? 0,
    })
  })
})

describe('averageSurplus', () => {
  it('B-1: 3ヶ月を平均する', () => {
    const bals = [
      mb(2026, 5, 300_000, 240_000), // +60k
      mb(2026, 6, 300_000, 250_000), // +50k
      mb(2026, 7, 300_000, 230_000), // +70k
    ]
    expect(averageSurplus(bals, 3)).toBe(60_000)
  })

  it('B-2: 2件しか無ければ2件で平均する', () => {
    const bals = [mb(2026, 6, 300_000, 250_000), mb(2026, 7, 300_000, 230_000)]
    expect(averageSurplus(bals, 3)).toBe(60_000)
  })

  it('B-3: 空なら null（算出不可。0 ではない）', () => {
    expect(averageSurplus([], 3)).toBeNull()
  })

  it('B-4: 4件あっても直近3件だけを見る', () => {
    const bals = [
      mb(2026, 4, 300_000, 300_000), // +0 （除外されるはず）
      mb(2026, 5, 300_000, 240_000), // +60k
      mb(2026, 6, 300_000, 250_000), // +50k
      mb(2026, 7, 300_000, 230_000), // +70k
    ]
    expect(averageSurplus(bals, 3)).toBe(60_000)
  })

  it('B-5: 順不同で渡しても内部で整列する', () => {
    const bals = [
      mb(2026, 7, 300_000, 230_000),
      mb(2026, 5, 300_000, 240_000),
      mb(2026, 6, 300_000, 250_000),
    ]
    expect(averageSurplus(bals, 3)).toBe(60_000)
  })

  it('B-6: 赤字1ヶ月なら負値を返す', () => {
    expect(averageSurplus([mb(2026, 7, 200_000, 250_000)], 3)).toBe(-50_000)
  })

  it('B-7: 割り切れないときは0方向に切り捨てる', () => {
    const bals = [
      mb(2026, 5, 300_000, 239_000), // +61k
      mb(2026, 6, 300_000, 250_000), // +50k
      mb(2026, 7, 300_000, 230_000), // +70k
    ]
    // 合計 181000 / 3 = 60333.33... → 60333
    expect(averageSurplus(bals, 3)).toBe(60_333)
  })

  it('B-8: 引数の配列を変更しない', () => {
    const bals = [
      mb(2026, 7, 300_000, 230_000),
      mb(2026, 5, 300_000, 240_000),
      mb(2026, 6, 300_000, 250_000),
    ]
    const before = bals.map((b) => b.yearMonth.toString())
    averageSurplus(bals, 3)
    expect(bals.map((b) => b.yearMonth.toString())).toEqual(before)
  })
})

describe('monthsToReach', () => {
  const cases: { name: string; shortfall: number; avgSurplus: number; want: number | null }[] = [
    { name: 'C-1: 割り切れる', shortfall: 600_000, avgSurplus: 100_000, want: 6 },
    { name: 'C-2: 割り切れないので切り上げ', shortfall: 620_000, avgSurplus: 100_000, want: 7 },
    { name: 'C-3: 不足額1円', shortfall: 1, avgSurplus: 100_000, want: 1 },
    { name: 'C-4: ちょうど1ヶ月', shortfall: 100_000, avgSurplus: 100_000, want: 1 },
    { name: 'C-5: 1ヶ月をわずかに超える', shortfall: 100_001, avgSurplus: 100_000, want: 2 },
    { name: 'C-6: 不足額0（達成済み）', shortfall: 0, avgSurplus: 100_000, want: null },
    { name: 'C-7: 不足額が負（達成済み）', shortfall: -50_000, avgSurplus: 100_000, want: null },
    { name: 'C-8: 平均余剰0', shortfall: 600_000, avgSurplus: 0, want: null },
    { name: 'C-9: 平均余剰が負', shortfall: 600_000, avgSurplus: -30_000, want: null },
  ]

  it.each(cases)('$name', (c) => {
    expect(monthsToReach(yen(c.shortfall), yen(c.avgSurplus))).toBe(c.want)
  })
})

describe('monthlySavingNeeded', () => {
  const july = YearMonth.of(2026, 7)

  const cases: {
    name: string
    shortfall: number
    deadline: YearMonth | null
    want: number | null
  }[] = [
    { name: '4ヶ月で割る（当月を含める）', shortfall: 300_000, deadline: YearMonth.of(2026, 10), want: 75_000 },
    { name: '期限が当月なら全額', shortfall: 300_000, deadline: july, want: 300_000 },
    { name: '割り切れないときは切り上げる', shortfall: 100_000, deadline: YearMonth.of(2026, 9), want: 33_334 },
    { name: '期限が無ければ算出不可', shortfall: 300_000, deadline: null, want: null },
    { name: '期限が過ぎていれば算出不可', shortfall: 300_000, deadline: YearMonth.of(2026, 6), want: null },
    { name: '不足額0なら算出不可（達成済み）', shortfall: 0, deadline: YearMonth.of(2026, 10), want: null },
    { name: '不足額が負なら算出不可', shortfall: -1, deadline: YearMonth.of(2026, 10), want: null },
  ]

  it.each(cases)('$name', (c) => {
    expect(monthlySavingNeeded(yen(c.shortfall), c.deadline, july)).toBe(c.want)
  })

  // 切り上げるのは、割り切れない分を毎月少しずつ多く積まないと期限に届かないため。
  it('切り上げた額を残り月数ぶん積めば不足額に届く', () => {
    const perMonth = monthlySavingNeeded(yen(100_000), YearMonth.of(2026, 9), july)
    expect(perMonth).not.toBeNull()
    expect((perMonth ?? 0) * 3).toBeGreaterThanOrEqual(100_000)
  })
})

describe('calculateShortfall', () => {
  const cases: { name: string; amount: number; netAsset: number; want: number }[] = [
    { name: 'D-1: 不足している', amount: 1_200_000, netAsset: 842_000, want: 358_000 },
    { name: 'D-2: すでに手が届く（負値）', amount: 500_000, netAsset: 842_000, want: -342_000 },
    { name: 'D-3: ちょうど届く（0）', amount: 842_000, netAsset: 842_000, want: 0 },
  ]

  it.each(cases)('$name', (c) => {
    expect(calculateShortfall(wish(c.amount, 'considering'), yen(c.netAsset))).toBe(c.want)
  })
})
