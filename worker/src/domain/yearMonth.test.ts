import { describe, expect, it } from 'vitest'
import { expectDomainError } from '../../test/support'
import { YearMonth } from './yearMonth'

describe('YearMonth.of', () => {
  it('G-1: 2026-07 は作れる', () => {
    expect(YearMonth.of(2026, 7).toString()).toBe('2026-07')
  })

  it('G-2: 13月は作れない', () => {
    expectDomainError(() => YearMonth.of(2026, 13), 'INVALID_YEAR_MONTH')
  })

  it('G-3: 0月は作れない', () => {
    expectDomainError(() => YearMonth.of(2026, 0), 'INVALID_YEAR_MONTH')
  })

  it('範囲外の年は作れない', () => {
    expectDomainError(() => YearMonth.of(1899, 7), 'INVALID_YEAR_MONTH')
    expectDomainError(() => YearMonth.of(10_000, 7), 'INVALID_YEAR_MONTH')
  })
})

describe('YearMonth.parse', () => {
  it('G-4: 2026-07 は解釈できる（往復して一致する）', () => {
    expect(YearMonth.parse('2026-07').toString()).toBe('2026-07')
  })

  it('G-5: 月は2桁固定', () => {
    expectDomainError(() => YearMonth.parse('2026-7'), 'INVALID_YEAR_MONTH')
  })

  it('G-6: 区切りが違えば解釈しない', () => {
    expectDomainError(() => YearMonth.parse('2026/07'), 'INVALID_YEAR_MONTH')
  })

  it('日を含む形式は解釈しない（DATE ではなく YYYY-MM を格納する）', () => {
    expectDomainError(() => YearMonth.parse('2026-07-01'), 'INVALID_YEAR_MONTH')
  })
})

describe('YearMonth.addMonths', () => {
  it('G-7: 2026-12 + 1 = 2027-01（年をまたぐ）', () => {
    expect(YearMonth.of(2026, 12).addMonths(1).toString()).toBe('2027-01')
  })

  it('G-8: 2026-01 - 1 = 2025-12（年を戻る）', () => {
    expect(YearMonth.of(2026, 1).addMonths(-1).toString()).toBe('2025-12')
  })

  it('複数年ぶんの繰り上がり・繰り下がり', () => {
    expect(YearMonth.of(2026, 7).addMonths(25).toString()).toBe('2028-08')
    expect(YearMonth.of(2026, 7).addMonths(-25).toString()).toBe('2024-06')
  })

  it('0ヶ月なら変わらない', () => {
    expect(YearMonth.of(2026, 7).addMonths(0).toString()).toBe('2026-07')
  })
})

describe('YearMonth.monthsUntil', () => {
  it('先の月までの数を返す', () => {
    expect(YearMonth.of(2026, 7).monthsUntil(YearMonth.of(2026, 10))).toBe(3)
  })

  it('同じ月なら0', () => {
    expect(YearMonth.of(2026, 7).monthsUntil(YearMonth.of(2026, 7))).toBe(0)
  })

  it('過去なら負', () => {
    expect(YearMonth.of(2026, 7).monthsUntil(YearMonth.of(2026, 6))).toBe(-1)
  })

  it('年をまたいでも数えられる', () => {
    expect(YearMonth.of(2026, 11).monthsUntil(YearMonth.of(2027, 2))).toBe(3)
    expect(YearMonth.of(2027, 2).monthsUntil(YearMonth.of(2026, 11))).toBe(-3)
  })
})

describe('YearMonth.compare', () => {
  const july = YearMonth.of(2026, 7)
  const august = YearMonth.of(2026, 8)
  const lastDec = YearMonth.of(2025, 12)

  it('G-11: 同じ年なら月で比べる', () => {
    expect(july.compare(august)).toBeLessThan(0)
    expect(august.compare(july)).toBeGreaterThan(0)
    expect(july.compare(july)).toBe(0)
  })

  it('年が違えば年で比べる', () => {
    expect(lastDec.compare(july)).toBeLessThan(0)
    expect(july.compare(lastDec)).toBeGreaterThan(0)
  })

  it('before / after / equals', () => {
    expect(july.before(august)).toBe(true)
    expect(july.after(august)).toBe(false)
    expect(july.equals(YearMonth.of(2026, 7))).toBe(true)
  })

  it('降順の並べ替えに使える', () => {
    const sorted = [july, lastDec, august].sort((a, b) => b.compare(a))
    expect(sorted.map((ym) => ym.toString())).toEqual(['2026-08', '2026-07', '2025-12'])
  })
})
