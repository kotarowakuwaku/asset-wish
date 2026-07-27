import { describe, expect, it } from 'vitest'
import {
  currentYearMonth,
  formatDate,
  formatMoney,
  formatMonths,
  formatShortfall,
  formatSurplus,
  parseAmount,
  todayISO,
} from './format'

// 値はすべて架空のもの（CLAUDE.md 不変条件17）。

describe('formatMoney', () => {
  it.each([
    [0, '¥0'],
    [1, '¥1'],
    [100, '¥100'],
    [1000, '¥1,000'],
    [12000, '¥12,000'],
    [1234567, '¥1,234,567'],
    [-1234, '-¥1,234'],
    [-1000000, '-¥1,000,000'],
  ])('formatMoney(%i) = %s', (amount, want) => {
    expect(formatMoney(amount)).toBe(want)
  })
})

describe('formatMonths', () => {
  // null は「算出不可」。0 と混同すると「今月中に届く」と誤読される。
  it('算出不可は null で表す', () => {
    expect(formatMonths(null)).toBe('算出不可')
  })

  it('月数はそのまま出す', () => {
    expect(formatMonths(6)).toBe('あと6ヶ月')
    expect(formatMonths(1)).toBe('あと1ヶ月')
  })

  it('0 を算出不可と取り違えない', () => {
    expect(formatMonths(0)).toBe('あと0ヶ月')
    expect(formatMonths(0)).not.toBe(formatMonths(null))
  })
})

describe('formatShortfall', () => {
  it('不足しているぶんを出す', () => {
    expect(formatShortfall(358000)).toBe('あと¥358,000')
  })

  // 不足額が 0 以下なら、すでに手が届いている。
  it.each([0, -1, -750000])('%i は到達済み', (shortfall) => {
    expect(formatShortfall(shortfall)).toBe('到達済み')
  })
})

describe('formatSurplus', () => {
  // 黒字・赤字が一目で分かること（要件 F-17）。
  it('黒字は符号を付ける', () => {
    expect(formatSurplus(65000)).toBe('+¥65,000')
  })

  it('赤字は負の表記になる', () => {
    expect(formatSurplus(-15000)).toBe('-¥15,000')
  })

  it('収支ゼロは符号を付けない', () => {
    expect(formatSurplus(0)).toBe('¥0')
  })
})

describe('formatDate', () => {
  it('YYYY-MM-DD を読みやすくする', () => {
    expect(formatDate('2026-07-12')).toBe('2026/07/12')
  })
})

describe('todayISO / currentYearMonth', () => {
  // 実時刻に依存させない。日付が変わった瞬間に落ちるテストを作らないため。
  const fixed = new Date(2026, 6, 5) // 2026-07-05（月は0始まり）

  it('日付を0埋めして返す', () => {
    expect(todayISO(fixed)).toBe('2026-07-05')
  })

  it('今月を YYYY-MM で返す', () => {
    expect(currentYearMonth(fixed)).toBe('2026-07')
  })
})

describe('parseAmount', () => {
  it.each([
    ['0', 0],
    ['1200', 1200],
    [' 1200 ', 1200],
  ])('parseAmount(%s) = %i', (input, want) => {
    expect(parseAmount(input)).toBe(want)
  })

  // 円未満は存在しない。負値も入力させない（符号は操作の種類で決まる）。
  it.each(['', '   ', 'abc', '1.5', '-100', '1,000', '1e3'])(
    'parseAmount(%s) は受け付けない',
    (input) => {
      expect(parseAmount(input)).toBeNull()
    },
  )
})
