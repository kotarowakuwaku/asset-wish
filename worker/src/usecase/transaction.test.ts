import { beforeEach, describe, expect, it } from 'vitest'
import { newFakes } from '../../test/fakes'
import { SOME_DATE, yen } from '../../test/support'
import { Transaction } from '../domain/transaction'
import { DEFAULT_TRANSACTION_LIMIT, TransactionUsecase } from './transaction'

let fakes: ReturnType<typeof newFakes>
let usecase: TransactionUsecase

beforeEach(() => {
  fakes = newFakes()
  usecase = new TransactionUsecase(fakes.transactions)
})

function seed(count: number): void {
  for (let i = 0; i < count; i++) {
    fakes.transactions.items.push(
      Transaction.create(`t-${i}`, 'acc-1', yen(-100), 'adjustment', null, SOME_DATE),
    )
  }
}

describe('list', () => {
  it('件数を絞れる', async () => {
    seed(5)
    expect(await usecase.list(2)).toHaveLength(2)
  })

  it('0以下なら既定の件数を使う', async () => {
    seed(DEFAULT_TRANSACTION_LIMIT + 10)
    expect(await usecase.list(0)).toHaveLength(DEFAULT_TRANSACTION_LIMIT)
    expect(await usecase.list(-1)).toHaveLength(DEFAULT_TRANSACTION_LIMIT)
  })

  it('空なら空配列', async () => {
    expect(await usecase.list(10)).toEqual([])
  })
})
