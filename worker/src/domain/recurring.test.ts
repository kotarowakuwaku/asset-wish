import { describe, expect, it } from 'vitest'
import { expectDomainError, id, isoDateOf, yen } from '../../test/support'
import { RecurringEntry } from './recurring'
import { YearMonth } from './yearMonth'

// 値はすべて架空のもの（不変条件17）。

const AUGUST = YearMonth.of(2026, 8)

function entry(dayOfMonth: number, amount = 250_000, appliedThrough = YearMonth.of(2026, 7)) {
  return RecurringEntry.restore(id(), '給料', 'acc-1', yen(amount), dayOfMonth, appliedThrough)
}

describe('RecurringEntry.create', () => {
  // 適用の起点は登録した月。前月を入れておけば、未適用月は常に
  // 「appliedThrough の翌月から」で足りる（null の場合分けが要らない）。
  it('登録月の前月まで適用済みとして作る', () => {
    const e = RecurringEntry.create(id(), '給料', 'acc-1', yen(250_000), 25, AUGUST)
    expect(e.appliedThrough.toString()).toBe('2026-07')
  })

  it('金額は符号付きで、支出は負のまま持つ', () => {
    const e = RecurringEntry.create(id(), '家賃', 'acc-1', yen(-80_000), 27, AUGUST)
    expect(e.amount).toBe(-80_000)
  })

  it('名称が空なら弾く', () => {
    expectDomainError(
      () => RecurringEntry.create(id(), '  ', 'acc-1', yen(250_000), 25, AUGUST),
      'EMPTY_TITLE',
    )
  })

  // 0円は残高が動かない。定期として登録する意味が無い。
  it('金額0なら弾く', () => {
    expectDomainError(
      () => RecurringEntry.create(id(), '給料', 'acc-1', yen(0), 25, AUGUST),
      'INVALID_AMOUNT',
    )
  })

  it.each([0, 32, -1, 1.5])('適用日 %s は弾く', (day) => {
    expectDomainError(
      () => RecurringEntry.create(id(), '給料', 'acc-1', yen(250_000), day, AUGUST),
      'INVALID_DAY_OF_MONTH',
    )
  })

  it.each([1, 15, 31])('適用日 %s は通す', (day) => {
    expect(RecurringEntry.create(id(), '給料', 'acc-1', yen(1), day, AUGUST).dayOfMonth).toBe(day)
  })
})

describe('dueDateIn', () => {
  it('指定した日をその月の日付にする', () => {
    expect(entry(25).dueDateIn(YearMonth.of(2026, 8))).toBe('2026-08-25')
  })

  it('1桁の日は0埋めする', () => {
    expect(entry(5).dueDateIn(YearMonth.of(2026, 8))).toBe('2026-08-05')
  })

  // 翌月に送ると、2月分が3月1日に入って「2月は適用されていない」ように見える。
  it.each([
    [2026, 2, '2026-02-28'],
    [2028, 2, '2028-02-29'], // 閏年
    [2026, 4, '2026-04-30'],
    [2026, 1, '2026-01-31'],
  ])('31日指定の %s-%s は末日に丸める', (year, month, want) => {
    expect(entry(31).dueDateIn(YearMonth.of(year, month))).toBe(want)
  })
})

describe('pendingMonths', () => {
  it('適用日を過ぎていれば当月が入る', () => {
    const months = entry(25).pendingMonths(isoDateOf('2026-08-25'))
    expect(months.map((m) => m.toString())).toEqual(['2026-08'])
  })

  // 8月1日に「毎月25日 給料」を登録しても、その日はまだ来ていない。
  it('適用日の前なら何も入らない', () => {
    expect(entry(25).pendingMonths(isoDateOf('2026-08-24'))).toEqual([])
  })

  // 2ヶ月開かなかったら、開いた時点で2ヶ月分をまとめて適用する。
  it('開かなかった月はまとめて古い順に入る', () => {
    const months = entry(25, 250_000, YearMonth.of(2026, 5)).pendingMonths(isoDateOf('2026-08-25'))
    expect(months.map((m) => m.toString())).toEqual(['2026-06', '2026-07', '2026-08'])
  })

  it('適用済みの月は入らない', () => {
    const months = entry(25, 250_000, YearMonth.of(2026, 8)).pendingMonths(isoDateOf('2026-08-31'))
    expect(months).toEqual([])
  })

  it('末日に丸められた月も判定に使う', () => {
    const months = entry(31, 250_000, YearMonth.of(2026, 1)).pendingMonths(isoDateOf('2026-02-28'))
    expect(months.map((m) => m.toString())).toEqual(['2026-02'])
  })

  // 日付が壊れた値でも無限に回さないための上限。
  it('一度に12ヶ月分までしか返さない', () => {
    const months = entry(1, 250_000, YearMonth.of(2020, 1)).pendingMonths(isoDateOf('2026-08-01'))
    expect(months).toHaveLength(12)
    expect(months[0].toString()).toBe('2020-02')
  })
})

describe('markAppliedThrough', () => {
  it('適用済みの年月を進める', () => {
    const e = entry(25)
    e.markAppliedThrough(YearMonth.of(2026, 8))
    expect(e.appliedThrough.toString()).toBe('2026-08')
  })

  // 巻き戻せると同じ月を二度適用でき、残高が二重に動く。
  it.each([
    [2026, 7], // 同じ月
    [2026, 6], // 過去
  ])('%s-%s へは戻せない', (year, month) => {
    const e = entry(25)
    expectDomainError(() => e.markAppliedThrough(YearMonth.of(year, month)), 'INVALID_TRANSITION')
    expect(e.appliedThrough.toString()).toBe('2026-07')
  })
})
