import { beforeEach, describe, expect, it } from 'vitest'
import { db, resetDb } from '../../../test/db'
import { id, yen } from '../../../test/support'
import { MonthlyBalance } from '../../domain/monthlyBalance'
import { YearMonth } from '../../domain/yearMonth'
import { D1MonthlyBalanceRepository, toMonthlyBalance } from './monthlyBalance'

const repo = new D1MonthlyBalanceRepository(db)

beforeEach(resetDb)

function mb(year: number, month: number, income: number, expense: number): MonthlyBalance {
  return MonthlyBalance.create(id(), YearMonth.of(year, month), yen(income), yen(expense))
}

describe('upsert', () => {
  it('無ければ作る', async () => {
    const saved = await repo.upsert(mb(2026, 7, 300_000, 230_000))

    expect(saved.yearMonth.toString()).toBe('2026-07')
    expect(saved.surplus()).toBe(70_000)
    expect(await repo.listAll()).toHaveLength(1)
  })

  // PUT /api/monthly-balances/{yearMonth} が冪等であることの土台。
  it('同じ年月なら上書きする', async () => {
    const first = await repo.upsert(mb(2026, 7, 300_000, 230_000))
    const second = await repo.upsert(mb(2026, 7, 310_000, 200_000))

    expect(await repo.listAll()).toHaveLength(1)
    expect(second.income).toBe(310_000)
    expect(second.expense).toBe(200_000)
    // 既存行の id が維持される。渡した id を返すと、DB に無い id を
    // レスポンスへ載せることになる。
    expect(second.id).toBe(first.id)
  })

  it('年月は YYYY-MM の形で格納される（月初日の DATE ではない）', async () => {
    await repo.upsert(mb(2026, 7, 1, 1))
    const row = await db.prepare('SELECT year_month FROM monthly_balances').first<{ year_month: string }>()
    expect(row?.year_month).toBe('2026-07')
  })
})

describe('listRecent / listAll', () => {
  async function seedThreeMonths(): Promise<void> {
    await repo.upsert(mb(2026, 5, 300_000, 240_000))
    await repo.upsert(mb(2026, 7, 300_000, 230_000))
    await repo.upsert(mb(2026, 6, 300_000, 250_000))
  }

  it('年月の降順で返す', async () => {
    await seedThreeMonths()
    expect((await repo.listAll()).map((m) => m.yearMonth.toString())).toEqual([
      '2026-07',
      '2026-06',
      '2026-05',
    ])
  })

  it('listRecent は件数を絞る', async () => {
    await seedThreeMonths()
    expect((await repo.listRecent(2)).map((m) => m.yearMonth.toString())).toEqual(['2026-07', '2026-06'])
  })

  it('limit が0以下なら全件相当', async () => {
    await seedThreeMonths()
    expect(await repo.listRecent(0)).toHaveLength(3)
    expect(await repo.listRecent(-1)).toHaveLength(3)
  })

  it('空なら空配列', async () => {
    expect(await repo.listAll()).toEqual([])
  })
})

describe('CHECK 制約', () => {
  it('YYYY-MM の形をしていない年月は入らない', async () => {
    for (const bad of ['2026-7', '2026-07-01', '202607']) {
      await expect(
        db
          .prepare('INSERT INTO monthly_balances (id, year_month, income, expense) VALUES (?, ?, 1, 1)')
          .bind(id(), bad)
          .run(),
      ).rejects.toThrow(/CHECK constraint failed/)
    }
  })

  it('負の収入・支出は入らない', async () => {
    await expect(
      db
        .prepare("INSERT INTO monthly_balances (id, year_month, income, expense) VALUES (?, '2026-07', -1, 0)")
        .bind(id())
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/)
  })

  it('同じ年月は2行入らない', async () => {
    await repo.upsert(mb(2026, 7, 1, 1))
    await expect(
      db
        .prepare("INSERT INTO monthly_balances (id, year_month, income, expense) VALUES (?, '2026-07', 1, 1)")
        .bind(id())
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/)
  })
})

describe('toMonthlyBalance', () => {
  it('年月の形が壊れていれば投げる', () => {
    expect(() =>
      toMonthlyBalance({ id: 'm1', year_month: '2026-7', income: 1, expense: 1 }),
    ).toThrow()
  })
})
