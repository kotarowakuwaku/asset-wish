import { describe, expect, it } from 'vitest'
import { borrow, expectDomainError, id, lend, loan, SOME_DATE, yen } from '../../test/support'
import type { DomainErrorCode } from './errors'
import { Loan, type LoanDirection, type SettlementStatus } from './loan'

// 精算の計算は向きによらず同じ。どちらも「未精算残高が減る」だけで、
// 口座残高は動かない（不変条件4）。同じ表を両方向に流して、
// **向きで分岐していないこと**を検証する。
describe('Loan.settle', () => {
  const cases: {
    name: string
    amount: number
    settled: number
    settleAmount: number
    wantErr: DomainErrorCode | null
    wantSettled: number
    wantStatus: SettlementStatus
  }[] = [
    {
      name: 'F-1: 一部精算',
      amount: 12_000,
      settled: 0,
      settleAmount: 5_000,
      wantErr: null,
      wantSettled: 5_000,
      wantStatus: 'partial',
    },
    {
      name: 'F-2: 全額に到達',
      amount: 12_000,
      settled: 5_000,
      settleAmount: 7_000,
      wantErr: null,
      wantSettled: 12_000,
      wantStatus: 'settled',
    },
    {
      name: 'F-3: 過精算（一部精算済み）',
      amount: 12_000,
      settled: 5_000,
      settleAmount: 8_000,
      wantErr: 'SETTLE_EXCEEDS_OUTSTANDING',
      wantSettled: 5_000,
      wantStatus: 'partial',
    },
    {
      name: 'F-4: 過精算（精算済み）',
      amount: 12_000,
      settled: 12_000,
      settleAmount: 1,
      wantErr: 'SETTLE_EXCEEDS_OUTSTANDING',
      wantSettled: 12_000,
      wantStatus: 'settled',
    },
    {
      name: 'F-5: 精算額0',
      amount: 12_000,
      settled: 0,
      settleAmount: 0,
      wantErr: 'INVALID_AMOUNT',
      wantSettled: 0,
      wantStatus: 'unsettled',
    },
    {
      name: 'F-6: 精算額が負',
      amount: 12_000,
      settled: 0,
      settleAmount: -100,
      wantErr: 'INVALID_AMOUNT',
      wantSettled: 0,
      wantStatus: 'unsettled',
    },
  ]

  const directions: LoanDirection[] = ['lent', 'borrowed']

  it.each(
    directions.flatMap((direction) => cases.map((c) => ({ ...c, direction }))),
  )('$name（$direction）', (c) => {
    const l = loan(c.direction, c.amount, c.settled)
    if (c.wantErr === null) {
      l.settle(yen(c.settleAmount))
    } else {
      expectDomainError(() => l.settle(yen(c.settleAmount)), c.wantErr)
    }
    // 失敗時に精算額が動いていないことも見る。最も気づきにくい壊れ方になるため。
    expect(l.settledAmount).toBe(c.wantSettled)
    expect(l.status()).toBe(c.wantStatus)
    // 向きは精算で動かない。動くと貸しと借りが入れ替わる。
    expect(l.direction).toBe(c.direction)
  })
})

describe('Loan', () => {
  it('F-7: 未精算なら outstanding は全額', () => {
    const l = lend(12_000, 0)
    expect(l.outstanding()).toBe(12_000)
    expect(l.status()).toBe('unsettled')
    expect(l.isFullySettled()).toBe(false)
  })

  // 借りた金も金額は正で持つ。負の金額で向きを表すと、amount > 0 の
  // 検査が借りた側に効かなくなる。
  it('F-8: 借りた金も amount と outstanding は正の値', () => {
    const l = borrow(5_000, 2_000)
    expect(l.amount).toBe(5_000)
    expect(l.outstanding()).toBe(3_000)
    expect(l.direction).toBe('borrowed')
  })

  it('相手が空なら作れない', () => {
    expectDomainError(
      () => Loan.create(id(), 'lent', '  ', '', yen(12_000), SOME_DATE),
      'EMPTY_COUNTERPARTY',
    )
  })

  it('金額が0以下なら作れない', () => {
    expectDomainError(
      () => Loan.create(id(), 'lent', 'テスト相手', '', yen(0), SOME_DATE),
      'INVALID_AMOUNT',
    )
  })

  it('向きが不正なら作れない', () => {
    expectDomainError(
      () => Loan.create(id(), 'sideways' as LoanDirection, 'テスト相手', '', yen(1), SOME_DATE),
      'INVALID_LOAN_DIRECTION',
    )
  })

  it.each(['lent', 'borrowed'] as const)('作った直後の精算額は0（%s）', (direction) => {
    const l = Loan.create(id(), direction, 'テスト相手', 'メモ', yen(12_000), SOME_DATE)
    expect(l.settledAmount).toBe(0)
    expect(l.status()).toBe('unsettled')
    expect(l.direction).toBe(direction)
  })

  // ここは CHECK 制約をすり抜けた値を domain に渡さないための最後の関門。
  it('過精算の行は復元できない', () => {
    expectDomainError(
      () => Loan.restore(id(), 'lent', 'テスト相手', '', yen(12_000), yen(12_001), SOME_DATE),
      'SETTLE_EXCEEDS_OUTSTANDING',
    )
  })

  it('精算額が負の行も復元できない', () => {
    expectDomainError(
      () => Loan.restore(id(), 'lent', 'テスト相手', '', yen(12_000), yen(-1), SOME_DATE),
      'NEGATIVE_AMOUNT',
    )
  })

  it('向きが不正な行も復元できない', () => {
    expectDomainError(
      () => Loan.restore(id(), 'lending', 'テスト相手', '', yen(12_000), yen(0), SOME_DATE),
      'INVALID_LOAN_DIRECTION',
    )
  })
})
