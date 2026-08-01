import { domainError } from './errors'

const MIN_YEAR = 1900
const MAX_YEAR = 9999
const YEAR_MONTH_PATTERN = /^\d{4}-\d{2}$/

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

/**
 * 年月。日・時刻・タイムゾーンを持たない。
 *
 * 生成経路はコンストラクタだけなので、Go 版にあった IsZero()（ゼロ値の検出）は
 * 移植していない。型が「必ず検証を通っている」ことを保証する。
 *
 * FirstDay() も移植していない。DATE 列との変換専用のメソッドであり、
 * year_month を TEXT 'YYYY-MM' にした時点で変換先が消えた
 *（docs/architecture.md 5章）。
 */
export class YearMonth {
  readonly year: number
  /** 1〜12。 */
  readonly month: number

  private constructor(year: number, month: number) {
    this.year = year
    this.month = month
  }

  /** year が 1900〜9999 の範囲外、month が 1〜12 の範囲外なら投げる。 */
  static of(year: number, month: number): YearMonth {
    if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) {
      throw domainError('INVALID_YEAR_MONTH')
    }
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw domainError('INVALID_YEAR_MONTH')
    }
    return new YearMonth(year, month)
  }

  /** '2026-07' 形式を解釈する。月は2桁固定。 */
  static parse(s: string): YearMonth {
    if (!YEAR_MONTH_PATTERN.test(s)) {
      throw domainError('INVALID_YEAR_MONTH')
    }
    return YearMonth.of(Number(s.slice(0, 4)), Number(s.slice(5)))
  }

  /** '2026-07' 形式を返す。月は必ず2桁。D1 への格納形式でもある。 */
  toString(): string {
    return `${String(this.year).padStart(4, '0')}-${String(this.month).padStart(2, '0')}`
  }

  /**
   * n ヶ月後を返す。n は負でもよい。
   *
   * 通算月数に直してから戻すことで、12月+1 = 翌年1月、1月-1 = 前年12月の
   * 繰り上がり・繰り下がりが自然に扱える。
   */
  addMonths(n: number): YearMonth {
    const total = this.year * 12 + (this.month - 1) + n
    const year = Math.floor(total / 12)
    return YearMonth.of(year, total - year * 12 + 1)
  }

  /**
   * this から other までの月数を返す。other が過去なら負。
   *
   * 「期限まであと何ヶ月あるか」を出すのに使う。同じ月なら 0。
   */
  monthsUntil(other: YearMonth): number {
    return (other.year - this.year) * 12 + (other.month - this.month)
  }

  /**
   * その月の日数を返す。
   *
   * `Date` を使わずに求めているのは、domain に時刻とタイムゾーンを持ち込まない
   * ため。`new Date(year, month, 0)` は動作環境のタイムゾーンで解釈され、
   * 月末の判定が環境によってずれる余地が残る。
   */
  daysInMonth(): number {
    if (this.month === 2) return isLeapYear(this.year) ? 29 : 28
    return DAYS_IN_MONTH[this.month - 1]
  }

  /** this < other なら負、等しければ 0、this > other なら正。並べ替えに使う。 */
  compare(other: YearMonth): number {
    if (this.year !== other.year) return this.year - other.year
    return this.month - other.month
  }

  equals(other: YearMonth): boolean {
    return this.compare(other) === 0
  }

  before(other: YearMonth): boolean {
    return this.compare(other) < 0
  }

  after(other: YearMonth): boolean {
    return this.compare(other) > 0
  }
}
