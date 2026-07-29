import { describe, expect, it } from 'vitest'
import {
  addMoney,
  isNegativeMoney,
  isPositiveMoney,
  isZeroMoney,
  money,
  negateMoney,
  subMoney,
  ZERO_MONEY,
} from './money'

describe('money', () => {
  it('円単位の整数を通す', () => {
    expect(money(1_234_567)).toBe(1_234_567)
    expect(money(-1_234)).toBe(-1_234)
    expect(ZERO_MONEY).toBe(0)
  })

  // 円に小数は無い。ここを通すと、四則演算のたびに端数が増殖する。
  it('小数は通さない', () => {
    expect(() => money(100.5)).toThrow(TypeError)
  })

  it('安全整数の外は通さない', () => {
    expect(() => money(Number.MAX_SAFE_INTEGER + 1)).toThrow(TypeError)
    expect(() => money(Number.NaN)).toThrow(TypeError)
    expect(() => money(Number.POSITIVE_INFINITY)).toThrow(TypeError)
  })
})

describe('加減算と符号の判定', () => {
  it('加算・減算', () => {
    expect(addMoney(money(500_000), money(300_000))).toBe(800_000)
    expect(subMoney(money(12_000), money(5_000))).toBe(7_000)
  })

  it('符号の反転', () => {
    expect(negateMoney(money(12_000))).toBe(-12_000)
    expect(negateMoney(money(-12_000))).toBe(12_000)
    expect(negateMoney(ZERO_MONEY)).toBe(0)
  })

  it('符号の判定', () => {
    expect(isPositiveMoney(money(1))).toBe(true)
    expect(isPositiveMoney(ZERO_MONEY)).toBe(false)
    expect(isNegativeMoney(money(-1))).toBe(true)
    expect(isNegativeMoney(ZERO_MONEY)).toBe(false)
    expect(isZeroMoney(ZERO_MONEY)).toBe(true)
    expect(isZeroMoney(money(1))).toBe(false)
  })
})
