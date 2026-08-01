import { beforeEach, describe, expect, it } from 'vitest'
import { db, givenMonthlyBalance, resetDb } from '../../../test/db'
import { id } from '../../../test/support'
import { D1MonthlyBalanceRepository, toMonthlyBalance } from './monthlyBalance'

const repo = new D1MonthlyBalanceRepository(db)

beforeEach(resetDb)

describe('listAll', () => {
  async function seedThreeMonths(): Promise<void> {
    await givenMonthlyBalance('2026-05', 300_000, 240_000)
    await givenMonthlyBalance('2026-07', 300_000, 230_000)
    await givenMonthlyBalance('2026-06', 300_000, 250_000)
  }

  it('年月の降順で返す', async () => {
    await seedThreeMonths()
    expect((await repo.listAll()).map((m) => m.yearMonth.toString())).toEqual([
      '2026-07',
      '2026-06',
      '2026-05',
    ])
  })

  it('収入・支出・余剰が復元される', async () => {
    await givenMonthlyBalance('2026-07', 300_000, 230_000)

    const [m] = await repo.listAll()
    expect(m.income).toBe(300_000)
    expect(m.expense).toBe(230_000)
    expect(m.surplus()).toBe(70_000)
  })

  it('空なら空配列', async () => {
    expect(await repo.listAll()).toEqual([])
  })
})

// 月次の収支は明細から集計する形に変えた（docs/spec-changes.md 4）。書ける文が
// 残っていると、同じ月について明細と手入力の2つの真実ができる。
describe('書き込みの経路', () => {
  it('リポジトリに書き込むメソッドが無い', () => {
    expect(Object.getOwnPropertyNames(D1MonthlyBalanceRepository.prototype)).toEqual([
      'constructor',
      'listAll',
    ])
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
    await givenMonthlyBalance('2026-07', 1, 1)
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
