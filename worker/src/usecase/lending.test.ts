import { beforeEach, describe, expect, it } from 'vitest'
import { newFakes, sequentialIds } from '../../test/fakes'
import { expectRejectedDomainError, SOME_DATE, SOME_INSTANT, yen } from '../../test/support'
import { Account } from '../domain/account'
import { Lending } from '../domain/lending'
import { isConflictError, isNotFoundError } from './port'
import { LendingUsecase } from './lending'

let fakes: ReturnType<typeof newFakes>
let usecase: LendingUsecase

beforeEach(() => {
  fakes = newFakes()
  usecase = new LendingUsecase(fakes.writer, fakes.lendings, sequentialIds())
})

/**
 * 立替と無関係な口座を1つ置く。
 *
 * 立替の操作でこの残高が動かないことを確かめるために置いてある。
 * 動いたら、口座から切り離したはずの立替が残高を触っている。
 */
function givenUnrelatedAccount(balance: number): Account {
  const a = Account.create('acc-1', 'テスト口座', 'cash', yen(balance), SOME_INSTANT)
  fakes.accounts.seed(a)
  return a
}

describe('create', () => {
  it('立替を作る', async () => {
    const l = await usecase.create('テスト相手', 'メモ', yen(12_000), SOME_DATE)

    expect(l.counterparty).toBe('テスト相手')
    expect(l.description).toBe('メモ')
    expect(l.amount).toBe(12_000)
    expect(l.collectedAmount).toBe(0)
    expect(await usecase.list(false)).toHaveLength(1)
  })

  // 不変条件4。立て替えた時点で現金が出たとは限らない（カード払い）。
  it('口座残高を動かさず、取引履歴も残さない', async () => {
    givenUnrelatedAccount(500_000)

    await usecase.create('テスト相手', '', yen(12_000), SOME_DATE)

    expect((await fakes.accounts.get('acc-1')).balance).toBe(500_000)
    expect(fakes.transactions.items).toHaveLength(0)
    expect(fakes.writer.ops.map((o) => o.kind)).toEqual(['createLending'])
  })

  it('金額が0以下なら domain が弾く。何も書かない', async () => {
    await expectRejectedDomainError(
      usecase.create('テスト相手', '', yen(0), SOME_DATE),
      'INVALID_AMOUNT',
    )
    expect(fakes.writer.ops).toHaveLength(0)
  })

  it('相手が空なら domain が弾く', async () => {
    await expectRejectedDomainError(
      usecase.create('   ', '', yen(12_000), SOME_DATE),
      'EMPTY_COUNTERPARTY',
    )
    expect(fakes.writer.ops).toHaveLength(0)
  })
})

describe('collect', () => {
  function givenLending(amount: number, collected: number): Lending {
    const l = Lending.restore('lend-1', 'テスト相手', '', yen(amount), yen(collected), SOME_DATE)
    fakes.lendings.seed(l)
    return l
  }

  it('回収額を増やす', async () => {
    givenLending(12_000, 0)

    const l = await usecase.collect('lend-1', yen(5_000))

    expect(l.collectedAmount).toBe(5_000)
    expect(l.outstanding()).toBe(7_000)
  })

  it('口座残高を動かさず、取引履歴も残さない', async () => {
    givenUnrelatedAccount(500_000)
    givenLending(12_000, 0)

    await usecase.collect('lend-1', yen(5_000))

    expect((await fakes.accounts.get('acc-1')).balance).toBe(500_000)
    expect(fakes.transactions.items).toHaveLength(0)
    expect(fakes.writer.ops.map((o) => o.kind)).toEqual(['updateLendingCollected'])
  })

  it('回収額を「読み取った時点の値」で条件にする', async () => {
    givenLending(12_000, 3_000)

    await usecase.collect('lend-1', yen(2_000))

    const [op] = fakes.writer.ops
    expect(op.kind === 'updateLendingCollected' && op.expectedCollectedAmount).toBe(3_000)
  })

  // 判定は domain が持つ。usecase は結果を書くだけ（不変条件4）。
  it('未回収残高を超える回収は弾かれ、何も書かない', async () => {
    givenLending(12_000, 5_000)

    await expectRejectedDomainError(
      usecase.collect('lend-1', yen(8_000)),
      'COLLECT_EXCEEDS_OUTSTANDING',
    )
    expect(fakes.writer.ops).toHaveLength(0)
    expect((await fakes.lendings.get('lend-1')).collectedAmount).toBe(5_000)
  })

  // 2つのタブから同時に回収すると、片方は「回収額0」を読んだまま書きに行く。
  // 両方が通ると過回収が成立しうる（不変条件4）。
  it('読み取りから書き込みの間に回収額が動いていれば競合になる', async () => {
    givenLending(12_000, 0)

    // await を挟まずに呼ぶと、立替の読み取りだけが済んだ状態で制御が戻る。
    const pending = usecase.collect('lend-1', yen(5_000))
    // その隙に別の操作が先に回収する。
    fakes.lendings.seed(Lending.restore('lend-1', 'テスト相手', '', yen(12_000), yen(4_000), SOME_DATE))

    await expect(pending).rejects.toSatisfy(isConflictError)
    expect((await fakes.lendings.get('lend-1')).collectedAmount).toBe(4_000)
  })

  it('立替が無ければ NotFoundError', async () => {
    await expect(usecase.collect('missing', yen(1))).rejects.toSatisfy(isNotFoundError)
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
