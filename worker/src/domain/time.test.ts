import { describe, expect, it } from 'vitest'
import { instantDiffMillis, parseInstant, parseIsoDate, toInstant, toIsoDate } from './time'

describe('parseIsoDate', () => {
  it('YYYY-MM-DD を通す', () => {
    expect(parseIsoDate('2026-07-12')).toBe('2026-07-12')
  })

  it('形式が違えば null', () => {
    for (const s of ['2026-7-12', '2026/07/12', '20260712', '2026-07', '', '2026-07-12T00:00:00Z']) {
      expect(parseIsoDate(s)).toBeNull()
    }
  })

  // Postgres の DATE 型が担っていた検査。TEXT には無いので自前で持つ。
  it('形式は正しくても存在しない日付なら null', () => {
    expect(parseIsoDate('2026-02-31')).toBeNull()
    expect(parseIsoDate('2026-13-01')).toBeNull()
    expect(parseIsoDate('2026-00-10')).toBeNull()
  })

  it('うるう年の2月29日は年によって結果が変わる', () => {
    expect(parseIsoDate('2024-02-29')).toBe('2024-02-29')
    expect(parseIsoDate('2026-02-29')).toBeNull()
  })
})

describe('toIsoDate', () => {
  it('UTC の日付部分を取り出す', () => {
    expect(toIsoDate(new Date('2026-07-12T15:30:00Z'))).toBe('2026-07-12')
  })

  // タイムゾーンを持つ値を日付にする場所はここだけ。必ず UTC で切る。
  it('UTC で日をまたぐ時刻でも UTC 基準で切る', () => {
    expect(toIsoDate(new Date('2026-07-12T23:59:59Z'))).toBe('2026-07-12')
    expect(toIsoDate(new Date('2026-07-13T00:00:00Z'))).toBe('2026-07-13')
  })
})

describe('parseInstant / toInstant', () => {
  it('ISO8601 を UTC 表記に正規化する', () => {
    expect(parseInstant('2026-07-12T09:00:00+09:00')).toBe('2026-07-12T00:00:00.000Z')
  })

  it('解釈できなければ null', () => {
    expect(parseInstant('いつか')).toBeNull()
  })

  it('Date から作ると必ず UTC 表記になる', () => {
    expect(toInstant(new Date(0))).toBe('1970-01-01T00:00:00.000Z')
  })
})

describe('instantDiffMillis', () => {
  it('差をミリ秒で返す', () => {
    const a = toInstant(new Date('2026-07-12T00:00:01Z'))
    const b = toInstant(new Date('2026-07-12T00:00:00Z'))
    expect(instantDiffMillis(a, b)).toBe(1_000)
    expect(instantDiffMillis(b, a)).toBe(-1_000)
  })
})
