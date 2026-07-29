import { describe, expect, it } from 'vitest'
import { acct, lend, mb, wish, yen } from '../../test/support'
import type { Account } from './account'
import type { Lending } from './lending'
import {
  averageSurplus,
  calculateBreakdown,
  calculateInvestmentTotal,
  calculateShortfall,
  monthsToReach,
  netAsset,
} from './netAsset'
import type { Wish } from './wish'

describe('calculateBreakdown', () => {
  const cases: {
    name: string
    accounts?: Account[]
    lendings?: Lending[]
    wishes?: Wish[]
    wantCash?: number
    wantLent?: number
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
      name: 'A-3: outstanding lending added',
      accounts: [acct('cash', 500_000)],
      lendings: [lend(12_000, 0)],
      wantCash: 500_000,
      wantLent: 12_000,
      wantNet: 512_000,
    },
    {
      name: 'A-4: partially collected lending',
      accounts: [acct('cash', 500_000)],
      lendings: [lend(12_000, 5_000)],
      wantCash: 500_000,
      wantLent: 7_000,
      wantNet: 507_000,
    },
    {
      name: 'A-5: fully collected lending',
      accounts: [acct('cash', 500_000)],
      lendings: [lend(12_000, 12_000)],
      wantCash: 500_000,
      wantLent: 0,
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
      lendings: [lend(12_000, 0)],
      wishes: [wish(80_000, 'committed')],
      wantCash: 910_000,
      wantLent: 12_000,
      wantCommit: 80_000,
      wantNet: 842_000,
    },
  ]

  it.each(cases)('$name', (c) => {
    const b = calculateBreakdown(c.accounts ?? [], c.lendings ?? [], c.wishes ?? [])
    expect(b.cashTotal).toBe(c.wantCash ?? 0)
    expect(b.outstandingLendings).toBe(c.wantLent ?? 0)
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
