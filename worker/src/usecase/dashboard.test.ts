import { beforeEach, describe, expect, it } from 'vitest'
import { fixedClock, newFakes } from '../../test/fakes'
import { instantOf, isoDateOf, SOME_DATE, SOME_INSTANT, yen } from '../../test/support'

const NOW = instantOf('2026-07-29T00:00:00Z')
import { Account, type AccountKind } from '../domain/account'
import { Loan, type LoanDirection } from '../domain/loan'
import { MonthlyBalance } from '../domain/monthlyBalance'
import { Transaction } from '../domain/transaction'
import { Wish, type WishStatus } from '../domain/wish'
import { YearMonth } from '../domain/yearMonth'
import { DashboardUsecase } from './dashboard'

let fakes: ReturnType<typeof newFakes>
let usecase: DashboardUsecase
let seq = 0

beforeEach(() => {
  fakes = newFakes()
  seq = 0
  usecase = new DashboardUsecase(
    fakes.accounts,
    fakes.loans,
    fakes.wishes,
    fakes.transactions,
    fakes.balances,
    fixedClock(NOW),
  )
})

const nextId = () => `id-${++seq}`

function seedAccount(kind: AccountKind, balance: number): void {
  fakes.accounts.seed(Account.create(nextId(), 'テスト口座', kind, yen(balance), SOME_INSTANT))
}

function seedLoan(direction: LoanDirection, amount: number, settled: number): void {
  fakes.loans.seed(
    Loan.restore(nextId(), direction, 'テスト相手', '', yen(amount), yen(settled), SOME_DATE),
  )
}

function seedWish(
  amount: number,
  status: WishStatus,
  title = 'テスト',
  deadline: string | null = null,
): void {
  fakes.wishes.seed(
    Wish.restore(nextId(), {
      title,
      amount: yen(amount),
      category: 'item',
      status,
      priority: 0,
      deadline: deadline === null ? null : isoDateOf(deadline),
    }),
  )
}

/**
 * 明細を打ち始める前の月を用意する。
 *
 * 月次の収支は明細から集計するようになったが、明細が1件も無い月に限って
 * この手入力の値が使われる（docs/spec-changes.md 4）。
 */
function seedBalance(year: number, month: number, income: number, expense: number): void {
  fakes.balances.seed(
    MonthlyBalance.create(nextId(), YearMonth.of(year, month), yen(income), yen(expense)),
  )
}

/** 手入力の入出金の明細。金額は符号付きで、出金は負。 */
function seedEntry(occurredOn: string, amount: number): void {
  fakes.transactions.seed(
    Transaction.create(nextId(), 'acc-1', yen(amount), 'adjustment', null, isoDateOf(occurredOn), ''),
  )
}

describe('実質資産', () => {
  it('現金 - 確定支出', async () => {
    seedAccount('cash', 910_000)
    seedAccount('investment', 350_000)
    seedWish(80_000, 'committed')

    const d = await usecase.get()

    expect(d.breakdown.cashTotal).toBe(910_000)
    expect(d.breakdown.commitments).toBe(80_000)
    expect(d.netAsset).toBe(830_000)
  })

  it('投資は実質資産に入らず、別枠で返る（不変条件1）', async () => {
    seedAccount('cash', 500_000)
    seedAccount('investment', 350_000)

    const d = await usecase.get()

    expect(d.netAsset).toBe(500_000)
    expect(d.investmentTotal).toBe(350_000)
  })

  it('貸し借りは実質資産に入らず、別枠で返る（不変条件4）', async () => {
    seedAccount('cash', 500_000)
    seedLoan('lent', 12_000, 0)
    seedLoan('borrowed', 5_000, 0)

    const d = await usecase.get()

    // 貸しも借りも実質資産を動かさない。
    expect(d.netAsset).toBe(500_000)
    expect(d.outstanding.lent).toBe(12_000)
    expect(d.outstanding.borrowed).toBe(5_000)
  })

  // 差額にすると、誰にいくら貸しているのかが消える。
  it('貸しと借りを混ぜず、向きごとに合計する', async () => {
    seedLoan('lent', 12_000, 2_000)
    seedLoan('lent', 3_000, 0)
    seedLoan('borrowed', 5_000, 1_000)

    const d = await usecase.get()

    expect(d.outstanding.lent).toBe(13_000)
    expect(d.outstanding.borrowed).toBe(4_000)
  })

  it('精算済みの貸し借りは参考値にも足さない', async () => {
    seedAccount('cash', 500_000)
    seedLoan('lent', 12_000, 12_000)

    expect((await usecase.get()).outstanding.lent).toBe(0)
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
    expect(d.outstanding).toEqual({ lent: 0, borrowed: 0 })
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
    seedBalance(2026, 6, 300_000, 200_000) // 余剰 +100,000

    const [w] = (await usecase.get()).wishes

    expect(w.shortfall).toBe(300_000)
    expect(w.monthsToReach).toBe(3)
  })

  it('すでに手が届くなら不足額は負値で、到達見込みは算出不可', async () => {
    seedAccount('cash', 500_000)
    seedWish(100_000, 'considering')
    seedBalance(2026, 6, 300_000, 200_000)

    const [w] = (await usecase.get()).wishes

    expect(w.shortfall).toBe(-400_000)
    expect(w.monthsToReach).toBeNull()
  })
})

// 平均月間余剰に依存しない。期限が決まっていれば必ず出せる。
describe('期限までに毎月いくら貯めればよいか', () => {
  it('残り月数で不足額を割る（当月を含める）', async () => {
    seedAccount('cash', 500_000)
    seedWish(800_000, 'considering', 'テスト', '2026-10-31')

    // 不足額 300,000。2026-07 から 2026-10 まで残り3ヶ月＋当月＝4ヶ月。
    expect((await usecase.get()).wishes[0].monthlySavingNeeded).toBe(75_000)
  })

  it('期限が当月なら全額（今月中に払う、という意味）', async () => {
    seedAccount('cash', 500_000)
    seedWish(800_000, 'considering', 'テスト', '2026-07-31')

    expect((await usecase.get()).wishes[0].monthlySavingNeeded).toBe(300_000)
  })

  it('期限が無ければ null', async () => {
    seedAccount('cash', 500_000)
    seedWish(800_000, 'considering')

    expect((await usecase.get()).wishes[0].monthlySavingNeeded).toBeNull()
  })

  it('期限が過ぎていれば null（0 を返すと達成済みに見える）', async () => {
    seedAccount('cash', 500_000)
    seedWish(800_000, 'considering', 'テスト', '2026-06-30')

    expect((await usecase.get()).wishes[0].monthlySavingNeeded).toBeNull()
  })

  it('すでに手が届くなら null', async () => {
    seedAccount('cash', 900_000)
    seedWish(800_000, 'considering', 'テスト', '2026-12-31')

    expect((await usecase.get()).wishes[0].monthlySavingNeeded).toBeNull()
  })

  it('月次収支が無くても出せる（到達見込みは算出不可でも）', async () => {
    seedAccount('cash', 500_000)
    seedWish(800_000, 'considering', 'テスト', '2026-10-31')

    const [w] = (await usecase.get()).wishes
    expect(w.monthsToReach).toBeNull()
    expect(w.monthlySavingNeeded).toBe(75_000)
  })
})

describe('平均月間余剰', () => {
  // 月次の収支は明細から出る。手入力の経路はもう無い。
  it('明細を月ごとに足し上げて平均する', async () => {
    seedEntry('2026-06-25', 300_000)
    seedEntry('2026-06-05', -230_000) // +70k
    seedEntry('2026-05-25', 300_000)
    seedEntry('2026-05-05', -250_000) // +50k
    seedEntry('2026-04-25', 300_000)
    seedEntry('2026-04-05', -240_000) // +60k

    expect((await usecase.get()).averageSurplus).toBe(60_000)
  })

  // ライブ代のような臨時支出を混ぜると、何か買うたびに他の目標の到達見込みが
  // 悪化する（不変条件2の考え方）。
  it('ウィッシュの支払いは平均に足さない', async () => {
    seedEntry('2026-06-25', 300_000)
    seedEntry('2026-06-05', -230_000) // +70k
    fakes.transactions.seed(
      Transaction.create(nextId(), 'acc-1', yen(-80_000), 'wish_paid', 'w-1', isoDateOf('2026-06-10'), ''),
    )

    expect((await usecase.get()).averageSurplus).toBe(70_000)
  })

  // まだ終わっていない月を混ぜると、余剰が実態より小さく見える。
  it('当月は平均に含めない', async () => {
    seedEntry('2026-06-25', 300_000)
    seedEntry('2026-06-05', -230_000) // +70k
    seedEntry('2026-07-05', -80_000) // 当月。まだ給料が入っていない

    expect((await usecase.get()).averageSurplus).toBe(70_000)
  })

  it('当月の明細しか無ければ算出不可', async () => {
    seedEntry('2026-07-25', 300_000)

    expect((await usecase.get()).averageSurplus).toBeNull()
  })

  // 明細が1件でもある月は明細が正。両方足すと二重計上になる。
  it('明細のある月は手入力の値を使わない', async () => {
    seedBalance(2026, 6, 300_000, 100_000) // +200k（使われないはず）
    seedEntry('2026-06-25', 300_000)
    seedEntry('2026-06-05', -230_000) // +70k

    expect((await usecase.get()).averageSurplus).toBe(70_000)
  })

  it('明細が無い月は手入力の値で平均する', async () => {
    seedBalance(2026, 3, 300_000, 300_000) // +0（除外されるはず）
    seedBalance(2026, 4, 300_000, 240_000) // +60k
    seedBalance(2026, 5, 300_000, 250_000) // +50k
    seedBalance(2026, 6, 300_000, 230_000) // +70k

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
    seedBalance(2026, 6, 200_000, 250_000) // 赤字

    const d = await usecase.get()

    expect(d.averageSurplus).toBe(-50_000)
    expect(d.wishes[0].monthsToReach).toBeNull()
  })
})
