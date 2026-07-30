import { beforeEach, describe, expect, it } from 'vitest'
import { newFakes, sequentialIds } from '../../test/fakes'
import { expectRejectedDomainError, SOME_DATE, SOME_INSTANT, yen } from '../../test/support'
import { Account } from '../domain/account'
import { Loan, type LoanDirection } from '../domain/loan'
import { isConflictError, isNotFoundError } from './port'
import { LoanUsecase } from './loan'

let fakes: ReturnType<typeof newFakes>
let usecase: LoanUsecase

beforeEach(() => {
  fakes = newFakes()
  usecase = new LoanUsecase(fakes.writer, fakes.loans, sequentialIds())
})

/**
 * 貸し借りと無関係な口座を1つ置く。
 *
 * 貸し借りの操作でこの残高が動かないことを確かめるために置いてある。
 * 動いたら、口座から切り離したはずの貸し借りが残高を触っている。
 */
function givenUnrelatedAccount(balance: number): Account {
  const a = Account.create('acc-1', 'テスト口座', 'cash', yen(balance), SOME_INSTANT)
  fakes.accounts.seed(a)
  return a
}

describe('create', () => {
  it.each(['lent', 'borrowed'] as const)('貸し借りを作る（%s）', async (direction) => {
    const l = await usecase.create(direction, 'テスト相手', 'メモ', yen(12_000), SOME_DATE)

    expect(l.direction).toBe(direction)
    expect(l.counterparty).toBe('テスト相手')
    expect(l.description).toBe('メモ')
    // 借りた側も金額は正。向きは direction だけが表す。
    expect(l.amount).toBe(12_000)
    expect(l.settledAmount).toBe(0)
    expect(await usecase.list(false)).toHaveLength(1)
  })

  // 不変条件4。立て替えた時点で現金が出たとは限らない（カード払い）。
  // 借りた側も同じで、借りた瞬間に手元の現金が増えるとは限らない。
  it.each(['lent', 'borrowed'] as const)(
    '口座残高を動かさず、取引履歴も残さない（%s）',
    async (direction) => {
      givenUnrelatedAccount(500_000)

      await usecase.create(direction, 'テスト相手', '', yen(12_000), SOME_DATE)

      expect((await fakes.accounts.get('acc-1')).balance).toBe(500_000)
      expect(fakes.transactions.items).toHaveLength(0)
      expect(fakes.writer.ops.map((o) => o.kind)).toEqual(['createLoan'])
    },
  )

  it('金額が0以下なら domain が弾く。何も書かない', async () => {
    await expectRejectedDomainError(
      usecase.create('lent', 'テスト相手', '', yen(0), SOME_DATE),
      'INVALID_AMOUNT',
    )
    expect(fakes.writer.ops).toHaveLength(0)
  })

  it('相手が空なら domain が弾く', async () => {
    await expectRejectedDomainError(
      usecase.create('lent', '   ', '', yen(12_000), SOME_DATE),
      'EMPTY_COUNTERPARTY',
    )
    expect(fakes.writer.ops).toHaveLength(0)
  })

  // handler は direction を検証せずそのまま渡す。判定は domain が持つ（不変条件6の精神）。
  it('向きが不正なら domain が弾く', async () => {
    await expectRejectedDomainError(
      usecase.create('sideways' as LoanDirection, 'テスト相手', '', yen(1), SOME_DATE),
      'INVALID_LOAN_DIRECTION',
    )
    expect(fakes.writer.ops).toHaveLength(0)
  })
})

describe('settle', () => {
  function givenLoan(amount: number, settled: number): Loan {
    const l = Loan.restore('lend-1', 'lent', 'テスト相手', '', yen(amount), yen(settled), SOME_DATE)
    fakes.loans.seed(l)
    return l
  }

  it('精算額を増やす', async () => {
    givenLoan(12_000, 0)

    const l = await usecase.settle('lend-1', yen(5_000))

    expect(l.settledAmount).toBe(5_000)
    expect(l.outstanding()).toBe(7_000)
  })

  it('口座残高を動かさず、取引履歴も残さない', async () => {
    givenUnrelatedAccount(500_000)
    givenLoan(12_000, 0)

    await usecase.settle('lend-1', yen(5_000))

    expect((await fakes.accounts.get('acc-1')).balance).toBe(500_000)
    expect(fakes.transactions.items).toHaveLength(0)
    expect(fakes.writer.ops.map((o) => o.kind)).toEqual(['updateLoanSettled'])
  })

  it('精算額を「読み取った時点の値」で条件にする', async () => {
    givenLoan(12_000, 3_000)

    await usecase.settle('lend-1', yen(2_000))

    const [op] = fakes.writer.ops
    expect(op.kind === 'updateLoanSettled' && op.expectedSettledAmount).toBe(3_000)
  })

  // 判定は domain が持つ。usecase は結果を書くだけ（不変条件4）。
  it('未精算残高を超える精算は弾かれ、何も書かない', async () => {
    givenLoan(12_000, 5_000)

    await expectRejectedDomainError(
      usecase.settle('lend-1', yen(8_000)),
      'SETTLE_EXCEEDS_OUTSTANDING',
    )
    expect(fakes.writer.ops).toHaveLength(0)
    expect((await fakes.loans.get('lend-1')).settledAmount).toBe(5_000)
  })

  // 2つのタブから同時に精算すると、片方は「精算額0」を読んだまま書きに行く。
  // 両方が通ると過精算が成立しうる（不変条件4）。
  it('読み取りから書き込みの間に精算額が動いていれば競合になる', async () => {
    givenLoan(12_000, 0)

    // await を挟まずに呼ぶと、貸し借りの読み取りだけが済んだ状態で制御が戻る。
    const pending = usecase.settle('lend-1', yen(5_000))
    // その隙に別の操作が先に精算する。
    fakes.loans.seed(Loan.restore('lend-1', 'lent', 'テスト相手', '', yen(12_000), yen(4_000), SOME_DATE))

    await expect(pending).rejects.toSatisfy(isConflictError)
    expect((await fakes.loans.get('lend-1')).settledAmount).toBe(4_000)
  })

  it('貸し借りが無ければ NotFoundError', async () => {
    await expect(usecase.settle('missing', yen(1))).rejects.toSatisfy(isNotFoundError)
  })
})

describe('list / delete', () => {
  it('未精算のみに絞れる', async () => {
    fakes.loans.seed(
      Loan.restore('l1', 'lent', 'a', '', yen(1_000), yen(0), SOME_DATE),
      Loan.restore('l2', 'lent', 'b', '', yen(1_000), yen(1_000), SOME_DATE),
    )
    expect(await usecase.list(true)).toHaveLength(1)
    expect(await usecase.list(false)).toHaveLength(2)
  })

  it('削除できる', async () => {
    fakes.loans.seed(Loan.restore('l1', 'lent', 'a', '', yen(1_000), yen(0), SOME_DATE))
    await usecase.delete('l1')
    expect(await usecase.list(false)).toHaveLength(0)
  })

  it('無いものを消そうとすれば NotFoundError', async () => {
    await expect(usecase.delete('missing')).rejects.toSatisfy(isNotFoundError)
  })
})
