import { describe, expect, it } from 'vitest'
import { expectDomainError, id, mb, yen } from '../../test/support'
import { MonthlyBalance } from './monthlyBalance'
import { YearMonth } from './yearMonth'

describe('MonthlyBalance', () => {
  it('月間余剰は income - expense', () => {
    const m = mb(2026, 7, 300_000, 230_000)
    expect(m.surplus()).toBe(70_000)
  })

  it('支出が上回れば赤字', () => {
    const m = mb(2026, 7, 200_000, 250_000)
    expect(m.surplus()).toBe(-50_000)
  })

  // 0 は黒字でも赤字でもない。画面は符号をそのまま見る。
  it('収支が同額なら余剰は0', () => {
    expect(mb(2026, 7, 250_000, 250_000).surplus()).toBe(0)
  })

  it('収入が負なら作れない', () => {
    expectDomainError(
      () => MonthlyBalance.create(id(), YearMonth.of(2026, 7), yen(-1), yen(0)),
      'NEGATIVE_AMOUNT',
    )
  })

  it('支出が負なら作れない', () => {
    expectDomainError(
      () => MonthlyBalance.create(id(), YearMonth.of(2026, 7), yen(0), yen(-1)),
      'NEGATIVE_AMOUNT',
    )
  })

  it('0円は通す（収入も支出も無い月がありうる）', () => {
    expect(MonthlyBalance.create(id(), YearMonth.of(2026, 7), yen(0), yen(0)).surplus()).toBe(0)
  })
})
