import { beforeEach, describe, expect, it } from 'vitest'
import { fixedClock, newFakes, sequentialIds } from '../../test/fakes'
import { expectRejectedDomainError, SOME_DATE, SOME_INSTANT, yen } from '../../test/support'
import { Account } from '../domain/account'
import { Transaction } from '../domain/transaction'
import { isConflictError, isNotFoundError } from './port'
import { DEFAULT_TRANSACTION_LIMIT, TransactionUsecase } from './transaction'

let fakes: ReturnType<typeof newFakes>
let usecase: TransactionUsecase

beforeEach(() => {
  fakes = newFakes()
  usecase = new TransactionUsecase(
    fakes.writer,
    fakes.transactions,
    fakes.accounts,
    fixedClock(SOME_INSTANT),
    sequentialIds(),
  )
})

function givenAccount(balance: number): Account {
  const a = Account.create('acc-1', 'テスト口座', 'cash', yen(balance), SOME_INSTANT)
  fakes.accounts.seed(a)
  return a
}

function seed(count: number): void {
  for (let i = 0; i < count; i++) {
    fakes.transactions.seed(
      Transaction.create(`t-${i}`, 'acc-1', yen(-100), 'adjustment', null, SOME_DATE, ''),
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

describe('create', () => {
  it('出金は残高を減らし、履歴を1件残す', async () => {
    givenAccount(500_000)

    const t = await usecase.create('acc-1', yen(-3_000), SOME_DATE, 'コンビニ')

    expect(t.kind).toBe('adjustment')
    expect(t.amount).toBe(-3_000)
    expect(t.note).toBe('コンビニ')
    expect(t.refId).toBeNull()
    expect((await fakes.accounts.get('acc-1')).balance).toBe(497_000)
    expect(await usecase.list(10)).toHaveLength(1)
  })

  it('入金は残高を増やす', async () => {
    givenAccount(500_000)

    await usecase.create('acc-1', yen(250_000), SOME_DATE, '給料')

    expect((await fakes.accounts.get('acc-1')).balance).toBe(750_000)
  })

  // 不変条件10。片方だけ残ると、裏付けの無い残高か、残高の動いていない履歴になる。
  it('残高の更新と履歴の記録が同じ書き込みに載る', async () => {
    givenAccount(500_000)

    await usecase.create('acc-1', yen(-3_000), SOME_DATE, '')

    expect(fakes.writer.ops.map((o) => o.kind)).toEqual(['updateAccount', 'createTransaction'])
  })

  it('メモは省略できる', async () => {
    givenAccount(500_000)

    const t = await usecase.create('acc-1', yen(-3_000), SOME_DATE, '')

    expect(t.note).toBe('')
  })

  // 残高が動かない記録に意味は無い。口座に触る前に落ちるので、残高も変わらない。
  it('金額0なら domain が弾く。何も書かない', async () => {
    givenAccount(500_000)

    await expectRejectedDomainError(
      usecase.create('acc-1', yen(0), SOME_DATE, 'メモ'),
      'INVALID_AMOUNT',
    )

    expect((await fakes.accounts.get('acc-1')).balance).toBe(500_000)
    expect(fakes.writer.ops).toHaveLength(0)
  })

  it('存在しない口座なら NotFoundError', async () => {
    await expect(usecase.create('acc-1', yen(-3_000), SOME_DATE, '')).rejects.toSatisfy(
      isNotFoundError,
    )
    expect(fakes.writer.ops).toHaveLength(0)
  })

  // 2つのタブから同時に打つと、2度目は読み取った残高が残っていない。
  it('読み取りから書き込みの間に残高が動いていれば競合になる', async () => {
    givenAccount(500_000)

    // await を挟まずに呼ぶと、読み取りだけが済んだ状態で制御が戻る。
    const pending = usecase.create('acc-1', yen(-3_000), SOME_DATE, '')
    // その隙に別の操作が残高を動かす。
    givenAccount(499_000)

    await expect(pending).rejects.toSatisfy(isConflictError)
    expect((await fakes.accounts.get('acc-1')).balance).toBe(499_000)
  })
})

describe('delete', () => {
  it('出金の明細を消すと残高が戻る', async () => {
    givenAccount(500_000)
    const t = await usecase.create('acc-1', yen(-3_000), SOME_DATE, 'コンビニ')

    await usecase.delete(t.id)

    expect((await fakes.accounts.get('acc-1')).balance).toBe(500_000)
    expect(await usecase.list(10)).toHaveLength(0)
  })

  it('入金の明細を消すと残高が減る', async () => {
    givenAccount(500_000)
    const t = await usecase.create('acc-1', yen(250_000), SOME_DATE, '給料')

    await usecase.delete(t.id)

    expect((await fakes.accounts.get('acc-1')).balance).toBe(500_000)
  })

  it('残高の戻しと履歴の削除が同じ書き込みに載る', async () => {
    givenAccount(500_000)
    const t = await usecase.create('acc-1', yen(-3_000), SOME_DATE, '')
    fakes.writer.ops.length = 0

    await usecase.delete(t.id)

    expect(fakes.writer.ops.map((o) => o.kind)).toEqual(['updateAccount', 'deleteTransaction'])
  })

  // 履歴だけ消して残高を戻すと、ウィッシュが完了のままなのに支払いが無かった
  // ことになる。判定は domain の ensureDeletable が持つ（不変条件6）。
  it('ウィッシュの支払いは消せない。残高も動かさない', async () => {
    givenAccount(500_000)
    fakes.transactions.seed(
      Transaction.create('t-1', 'acc-1', yen(-80_000), 'wish_paid', 'w-1', SOME_DATE, ''),
    )

    await expectRejectedDomainError(usecase.delete('t-1'), 'TRANSACTION_NOT_DELETABLE')

    expect((await fakes.accounts.get('acc-1')).balance).toBe(500_000)
    expect(fakes.writer.ops).toHaveLength(0)
  })

  it('存在しない履歴なら NotFoundError', async () => {
    await expect(usecase.delete('t-1')).rejects.toSatisfy(isNotFoundError)
  })

  // 削除の競合で怖いのは、残高が二重に戻ることそのもの。
  it('同じ明細を2つのタブから消しても、残高は二重に戻らない', async () => {
    givenAccount(500_000)
    const t = await usecase.create('acc-1', yen(-3_000), SOME_DATE, '')

    const first = usecase.delete(t.id)
    const second = usecase.delete(t.id)

    await first
    await expect(second).rejects.toSatisfy(isConflictError)
    expect((await fakes.accounts.get('acc-1')).balance).toBe(500_000)
  })
})
