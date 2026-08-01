import { beforeEach, describe, expect, it } from 'vitest'
import { newFakes } from '../../test/fakes'
import { entry, mb, txn } from '../../test/support'
import { MonthlySummaryUsecase } from './monthlySummary'

let fakes: ReturnType<typeof newFakes>
let usecase: MonthlySummaryUsecase

beforeEach(() => {
  fakes = newFakes()
  usecase = new MonthlySummaryUsecase(fakes.transactions, fakes.balances)
})

describe('list', () => {
  it('明細と手入力の両方を材料にして集計を返す', async () => {
    fakes.transactions.seed(entry('2026-06-25', 300_000), entry('2026-06-05', -230_000))
    fakes.balances.seed(mb(2026, 5, 300_000, 240_000))

    const summaries = await usecase.list()

    expect(summaries.map((s) => [s.yearMonth.toString(), s.surplus(), s.source])).toEqual([
      ['2026-06', 70_000, 'entries'],
      ['2026-05', 60_000, 'manual'],
    ])
  })

  // 集計そのものの検証は domain のテストが持つ。ここで見たいのは
  // 「両方のリポジトリから材料を集めているか」だけ。
  it('ウィッシュの支払いは集計に足さない', async () => {
    fakes.transactions.seed(txn('2026-06-10', -80_000, 'wish_paid'))

    expect(await usecase.list()).toEqual([])
  })

  it('材料が無ければ空配列', async () => {
    expect(await usecase.list()).toEqual([])
  })
})

// 手入力の経路を残すと、同じ数字を明細と月次の2箇所に入れることになる。
describe('書き込みの経路', () => {
  it('usecase に書き込むメソッドが無い', () => {
    expect(Object.getOwnPropertyNames(MonthlySummaryUsecase.prototype)).toEqual([
      'constructor',
      'list',
    ])
  })
})
