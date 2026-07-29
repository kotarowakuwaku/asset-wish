import { beforeEach, describe, expect, it } from 'vitest'
import { fixedClock, newFakes, sequentialIds } from '../../test/fakes'
import { expectRejectedDomainError, instantOf, SOME_DATE, SOME_INSTANT, yen } from '../../test/support'
import { Account } from '../domain/account'
import { Lending } from '../domain/lending'
import { isConflictError, isNotFoundError } from './port'
import { LendingUsecase } from './lending'

const NOW = instantOf('2026-07-29T00:00:00Z')

let fakes: ReturnType<typeof newFakes>
let usecase: LendingUsecase

beforeEach(() => {
  fakes = newFakes()
  usecase = new LendingUsecase(
    fakes.writer,
    fakes.lendings,
    fakes.accounts,
    fixedClock(NOW),
    sequentialIds(),
  )
})

function givenAccount(balance: number): Account {
  const a = Account.create('acc-1', 'テスト口座', 'cash', yen(balance), SOME_INSTANT)
  fakes.accounts.seed(a)
  return a
}

describe('create', () => {
  it('立替を作り、口座残高を減らし、履歴を残す', async () => {
    givenAccount(500_000)

    const l = await usecase.create('テスト相手', 'メモ', yen(12_000), SOME_DATE, 'acc-1')

    expect(l.counterparty).toBe('テスト相手')
    expect(l.collectedAmount).toBe(0)
    expect((await fakes.accounts.get('acc-1')).balance).toBe(488_000)
    expect(fakes.transactions.items).toHaveLength(1)
    expect(fakes.transactions.items[0].amount).toBe(-12_000)
    expect(fakes.transactions.items[0].kind).toBe('lending_created')
    expect(fakes.transactions.items[0].refId).toBe(l.id)
  })

  it('残高の更新は「読み取った時点の値」を条件にする', async () => {
    givenAccount(500_000)

    await usecase.create('テスト相手', '', yen(12_000), SOME_DATE, 'acc-1')

    const op = fakes.writer.ops.find((o) => o.kind === 'updateAccount')
    expect(op).toBeDefined()
    expect(op?.kind === 'updateAccount' && op.expectedBalance).toBe(500_000)
  })

  it('3件を1回の書き込みにまとめる', async () => {
    givenAccount(500_000)
    await usecase.create('テスト相手', '', yen(12_000), SOME_DATE, 'acc-1')
    expect(fakes.writer.ops.map((o) => o.kind)).toEqual([
      'createLending',
      'updateAccount',
      'createTransaction',
    ])
  })

  it('残高の更新日時は Clock の値になる', async () => {
    givenAccount(500_000)
    await usecase.create('テスト相手', '', yen(12_000), SOME_DATE, 'acc-1')
    expect((await fakes.accounts.get('acc-1')).updatedAt).toBe(NOW)
  })

  it('口座が無ければ NotFoundError。何も書かない', async () => {
    await expect(
      usecase.create('テスト相手', '', yen(12_000), SOME_DATE, 'missing'),
    ).rejects.toSatisfy(isNotFoundError)
    expect(fakes.writer.ops).toHaveLength(0)
  })

  it('金額が0以下なら domain が弾く。口座も読まない', async () => {
    givenAccount(500_000)
    await expectRejectedDomainError(
      usecase.create('テスト相手', '', yen(0), SOME_DATE, 'acc-1'),
      'INVALID_AMOUNT',
    )
    expect(fakes.writer.ops).toHaveLength(0)
  })

  it('相手が空なら domain が弾く', async () => {
    givenAccount(500_000)
    await expectRejectedDomainError(
      usecase.create('   ', '', yen(12_000), SOME_DATE, 'acc-1'),
      'EMPTY_COUNTERPARTY',
    )
  })
})

describe('collect', () => {
  function givenLending(amount: number, collected: number): Lending {
    const l = Lending.restore('lend-1', 'テスト相手', '', yen(amount), yen(collected), SOME_DATE)
    fakes.lendings.seed(l)
    return l
  }

  it('回収額を増やし、口座残高を戻し、履歴を残す', async () => {
    givenAccount(500_000)
    givenLending(12_000, 0)

    const l = await usecase.collect('lend-1', yen(5_000), SOME_DATE, 'acc-1')

    expect(l.collectedAmount).toBe(5_000)
    expect(l.outstanding()).toBe(7_000)
    expect((await fakes.accounts.get('acc-1')).balance).toBe(505_000)
    expect(fakes.transactions.items[0].amount).toBe(5_000)
    expect(fakes.transactions.items[0].kind).toBe('lending_collected')
  })

  it('回収額と残高の両方を「読み取った時点の値」で条件にする', async () => {
    givenAccount(500_000)
    givenLending(12_000, 3_000)

    await usecase.collect('lend-1', yen(2_000), SOME_DATE, 'acc-1')

    const [lendOp, accOp] = fakes.writer.ops
    expect(lendOp.kind === 'updateLendingCollected' && lendOp.expectedCollectedAmount).toBe(3_000)
    expect(accOp.kind === 'updateAccount' && accOp.expectedBalance).toBe(500_000)
  })

  // 判定は domain が持つ。usecase は結果を書くだけ（不変条件4）。
  it('未回収残高を超える回収は弾かれ、何も書かない', async () => {
    givenAccount(500_000)
    givenLending(12_000, 5_000)

    await expectRejectedDomainError(
      usecase.collect('lend-1', yen(8_000), SOME_DATE, 'acc-1'),
      'COLLECT_EXCEEDS_OUTSTANDING',
    )
    expect(fakes.writer.ops).toHaveLength(0)
    expect((await fakes.lendings.get('lend-1')).collectedAmount).toBe(5_000)
    expect((await fakes.accounts.get('acc-1')).balance).toBe(500_000)
  })

  // 2つのタブから同時に回収すると、片方は「回収額0」を読んだまま書きに行く。
  // 両方が通ると過回収が成立しうる（不変条件4）。
  it('読み取りから書き込みの間に回収額が動いていれば競合になる', async () => {
    givenAccount(500_000)
    givenLending(12_000, 0)

    // await を挟まずに呼ぶと、立替の読み取りだけが済んだ状態で制御が戻る。
    const pending = usecase.collect('lend-1', yen(5_000), SOME_DATE, 'acc-1')
    // その隙に別の操作が先に回収する。
    fakes.lendings.seed(Lending.restore('lend-1', 'テスト相手', '', yen(12_000), yen(4_000), SOME_DATE))

    await expect(pending).rejects.toSatisfy(isConflictError)
    expect((await fakes.lendings.get('lend-1')).collectedAmount).toBe(4_000)
    expect((await fakes.accounts.get('acc-1')).balance).toBe(500_000)
  })

  it('立替が無ければ NotFoundError', async () => {
    givenAccount(500_000)
    await expect(usecase.collect('missing', yen(1), SOME_DATE, 'acc-1')).rejects.toSatisfy(
      isNotFoundError,
    )
  })
})

describe('list / delete', () => {
  it('未回収のみに絞れる', async () => {
    fakes.lendings.seed(
      Lending.restore('l1', 'a', '', yen(1_000), yen(0), SOME_DATE),
      Lending.restore('l2', 'b', '', yen(1_000), yen(1_000), SOME_DATE),
    )
    expect(await usecase.list(true)).toHaveLength(1)
    expect(await usecase.list(false)).toHaveLength(2)
  })

  it('削除できる', async () => {
    fakes.lendings.seed(Lending.restore('l1', 'a', '', yen(1_000), yen(0), SOME_DATE))
    await usecase.delete('l1')
    expect(await usecase.list(false)).toHaveLength(0)
  })

  it('無いものを消そうとすれば NotFoundError', async () => {
    await expect(usecase.delete('missing')).rejects.toSatisfy(isNotFoundError)
  })
})
