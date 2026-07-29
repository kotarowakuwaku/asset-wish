import { beforeEach, describe, expect, it } from 'vitest'
import { newFakes, sequentialIds } from '../../test/fakes'
import { expectRejectedDomainError, yen } from '../../test/support'
import { YearMonth } from '../domain/yearMonth'
import { MonthlyBalanceUsecase } from './monthlyBalance'

let fakes: ReturnType<typeof newFakes>
let usecase: MonthlyBalanceUsecase

beforeEach(() => {
  fakes = newFakes()
  usecase = new MonthlyBalanceUsecase(fakes.balances, sequentialIds('mb'))
})

describe('upsert', () => {
  it('無ければ作る', async () => {
    const m = await usecase.upsert(YearMonth.of(2026, 7), yen(300_000), yen(230_000))
    expect(m.id).toBe('mb-1')
    expect(m.surplus()).toBe(70_000)
  })

  // PUT が冪等であることの土台。既存行の id を返す。
  it('同じ年月への再登録は上書きになり、id は既存のものになる', async () => {
    const first = await usecase.upsert(YearMonth.of(2026, 7), yen(300_000), yen(230_000))
    const second = await usecase.upsert(YearMonth.of(2026, 7), yen(310_000), yen(200_000))

    expect(second.id).toBe(first.id)
    expect(second.income).toBe(310_000)
    expect(await usecase.list()).toHaveLength(1)
  })

  it('負の金額は domain が弾く', async () => {
    await expectRejectedDomainError(
      usecase.upsert(YearMonth.of(2026, 7), yen(-1), yen(0)),
      'NEGATIVE_AMOUNT',
    )
    expect(await usecase.list()).toHaveLength(0)
  })

  it('0円は通す（収入も支出も無い月がありうる）', async () => {
    const m = await usecase.upsert(YearMonth.of(2026, 7), yen(0), yen(0))
    expect(m.surplus()).toBe(0)
  })
})

describe('list', () => {
  it('年月の降順で返す', async () => {
    await usecase.upsert(YearMonth.of(2026, 5), yen(1), yen(0))
    await usecase.upsert(YearMonth.of(2026, 7), yen(1), yen(0))
    await usecase.upsert(YearMonth.of(2026, 6), yen(1), yen(0))

    expect((await usecase.list()).map((m) => m.yearMonth.toString())).toEqual([
      '2026-07',
      '2026-06',
      '2026-05',
    ])
  })
})
