import { describe, expect, it } from 'vitest'
import { wish, yen } from '../../test/support'
import { calculateShortfall, monthlySavingNeeded, monthsToReach } from './wishProgress'
import { YearMonth } from './yearMonth'

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
