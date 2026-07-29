import { beforeEach, describe, expect, it } from 'vitest'
import { newFakes } from '../../test/fakes'
import { SOME_DATE, SOME_INSTANT, yen } from '../../test/support'
import { Account, type AccountKind } from '../domain/account'
import { Lending } from '../domain/lending'
import { MonthlyBalance } from '../domain/monthlyBalance'
import { Wish, type WishStatus } from '../domain/wish'
import { YearMonth } from '../domain/yearMonth'
import { DashboardUsecase } from './dashboard'

let fakes: ReturnType<typeof newFakes>
let usecase: DashboardUsecase
let seq = 0

beforeEach(() => {
  fakes = newFakes()
  seq = 0
  usecase = new DashboardUsecase(fakes.accounts, fakes.lendings, fakes.wishes, fakes.balances)
})

const nextId = () => `id-${++seq}`

function seedAccount(kind: AccountKind, balance: number): void {
  fakes.accounts.seed(Account.create(nextId(), 'テスト口座', kind, yen(balance), SOME_INSTANT))
}

function seedLending(amount: number, collected: number): void {
  fakes.lendings.seed(
    Lending.restore(nextId(), 'テスト相手', '', yen(amount), yen(collected), SOME_DATE),
  )
}

function seedWish(amount: number, status: WishStatus, title = 'テスト'): void {
  fakes.wishes.seed(
    Wish.restore(nextId(), {
      title,
      amount: yen(amount),
      category: 'item',
      status,
      priority: 0,
      deadline: null,
    }),
  )
}

function seedBalance(year: number, month: number, income: number, expense: number): void {
  fakes.balances.seed(
    MonthlyBalance.create(nextId(), YearMonth.of(year, month), yen(income), yen(expense)),
  )
}

describe('実質資産', () => {
  it('現金 + 未回収立替 - 確定支出', async () => {
    seedAccount('cash', 910_000)
    seedAccount('investment', 350_000)
    seedLending(12_000, 0)
    seedWish(80_000, 'committed')

    const d = await usecase.get()

    expect(d.breakdown.cashTotal).toBe(910_000)
    expect(d.breakdown.outstandingLendings).toBe(12_000)
    expect(d.breakdown.commitments).toBe(80_000)
    expect(d.netAsset).toBe(842_000)
  })

  it('投資は実質資産に入らず、別枠で返る（不変条件1）', async () => {
    seedAccount('cash', 500_000)
    seedAccount('investment', 350_000)

    const d = await usecase.get()

    expect(d.netAsset).toBe(500_000)
    expect(d.investmentTotal).toBe(350_000)
  })

  it('回収済みの立替は足さない', async () => {
    seedAccount('cash', 500_000)
    seedLending(12_000, 12_000)

    expect((await usecase.get()).breakdown.outstandingLendings).toBe(0)
  })

  it('確定以外のウィッシュは控除しない（不変条件3）', async () => {
    seedAccount('cash', 500_000)
    seedWish(80_000, 'considering')
    seedWish(80_000, 'done')
    seedWish(80_000, 'dropped')

    expect((await usecase.get()).breakdown.commitments).toBe(0)
  })

  it('何も無ければ全部0', async () => {
    const d = await usecase.get()
    expect(d.netAsset).toBe(0)
    expect(d.investmentTotal).toBe(0)
    expect(d.wishes).toEqual([])
  })
})

describe('ウィッシュの一覧', () => {
  it('終わったもの・やめたものは並べない', async () => {
    seedAccount('cash', 500_000)
    seedWish(100_000, 'considering', '検討中')
    seedWish(100_000, 'committed', '確定')
    seedWish(100_000, 'done', '完了')
    seedWish(100_000, 'dropped', '見送り')

    const titles = (await usecase.get()).wishes.map((w) => w.wish.title)
    expect(titles).toEqual(['検討中', '確定'])
  })

  it('不足額と到達見込みを付ける', async () => {
    seedAccount('cash', 500_000)
    seedWish(800_000, 'considering')
    seedBalance(2026, 7, 300_000, 200_000) // 余剰 +100,000

    const [w] = (await usecase.get()).wishes

    expect(w.shortfall).toBe(300_000)
    expect(w.monthsToReach).toBe(3)
  })

  it('すでに手が届くなら不足額は負値で、到達見込みは算出不可', async () => {
    seedAccount('cash', 500_000)
    seedWish(100_000, 'considering')
    seedBalance(2026, 7, 300_000, 200_000)

    const [w] = (await usecase.get()).wishes

    expect(w.shortfall).toBe(-400_000)
    expect(w.monthsToReach).toBeNull()
  })
})

describe('平均月間余剰', () => {
  it('直近3ヶ月で平均する', async () => {
    seedBalance(2026, 4, 300_000, 300_000) // +0（除外されるはず）
    seedBalance(2026, 5, 300_000, 240_000) // +60k
    seedBalance(2026, 6, 300_000, 250_000) // +50k
    seedBalance(2026, 7, 300_000, 230_000) // +70k

    expect((await usecase.get()).averageSurplus).toBe(60_000)
  })

  // null は「算出不可」。0 として出すと「余剰なし」に見え、
  // 到達見込みも「今月中に届く」と読めてしまう。
  it('データが無ければ null', async () => {
    seedAccount('cash', 500_000)
    seedWish(800_000, 'considering')

    const d = await usecase.get()

    expect(d.averageSurplus).toBeNull()
    expect(d.wishes[0].monthsToReach).toBeNull()
  })

  it('余剰が0以下なら到達見込みは算出不可', async () => {
    seedAccount('cash', 500_000)
    seedWish(800_000, 'considering')
    seedBalance(2026, 7, 200_000, 250_000) // 赤字

    const d = await usecase.get()

    expect(d.averageSurplus).toBe(-50_000)
    expect(d.wishes[0].monthsToReach).toBeNull()
  })
})
