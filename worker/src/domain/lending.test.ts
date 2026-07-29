import { describe, expect, it } from 'vitest'
import { expectDomainError, id, lend, SOME_DATE, yen } from '../../test/support'
import type { DomainErrorCode } from './errors'
import { Lending, type CollectionStatus } from './lending'

describe('Lending.collect', () => {
  const cases: {
    name: string
    amount: number
    collected: number
    collectAmount: number
    wantErr: DomainErrorCode | null
    wantCollected: number
    wantStatus: CollectionStatus
  }[] = [
    {
      name: 'F-1: 一部回収',
      amount: 12_000,
      collected: 0,
      collectAmount: 5_000,
      wantErr: null,
      wantCollected: 5_000,
      wantStatus: 'partial',
    },
    {
      name: 'F-2: 全額に到達',
      amount: 12_000,
      collected: 5_000,
      collectAmount: 7_000,
      wantErr: null,
      wantCollected: 12_000,
      wantStatus: 'collected',
    },
    {
      name: 'F-3: 過回収（一部回収済み）',
      amount: 12_000,
      collected: 5_000,
      collectAmount: 8_000,
      wantErr: 'COLLECT_EXCEEDS_OUTSTANDING',
      wantCollected: 5_000,
      wantStatus: 'partial',
    },
    {
      name: 'F-4: 過回収（回収済み）',
      amount: 12_000,
      collected: 12_000,
      collectAmount: 1,
      wantErr: 'COLLECT_EXCEEDS_OUTSTANDING',
      wantCollected: 12_000,
      wantStatus: 'collected',
    },
    {
      name: 'F-5: 回収額0',
      amount: 12_000,
      collected: 0,
      collectAmount: 0,
      wantErr: 'INVALID_AMOUNT',
      wantCollected: 0,
      wantStatus: 'uncollected',
    },
    {
      name: 'F-6: 回収額が負',
      amount: 12_000,
      collected: 0,
      collectAmount: -100,
      wantErr: 'INVALID_AMOUNT',
      wantCollected: 0,
      wantStatus: 'uncollected',
    },
  ]

  it.each(cases)('$name', (c) => {
    const l = lend(c.amount, c.collected)
    if (c.wantErr === null) {
      l.collect(yen(c.collectAmount))
    } else {
      expectDomainError(() => l.collect(yen(c.collectAmount)), c.wantErr)
    }
    // 失敗時に回収額が動いていないことも見る。最も気づきにくい壊れ方になるため。
    expect(l.collectedAmount).toBe(c.wantCollected)
    expect(l.status()).toBe(c.wantStatus)
  })
})

describe('Lending', () => {
  it('F-7: 未回収なら outstanding は全額', () => {
    const l = lend(12_000, 0)
    expect(l.outstanding()).toBe(12_000)
    expect(l.status()).toBe('uncollected')
    expect(l.isFullyCollected()).toBe(false)
  })

  it('相手が空なら作れない', () => {
    expectDomainError(
      () => Lending.create(id(), '  ', '', yen(12_000), SOME_DATE),
      'EMPTY_COUNTERPARTY',
    )
  })

  it('金額が0以下なら作れない', () => {
    expectDomainError(() => Lending.create(id(), 'テスト相手', '', yen(0), SOME_DATE), 'INVALID_AMOUNT')
  })

  it('作った直後の回収額は0', () => {
    const l = Lending.create(id(), 'テスト相手', 'メモ', yen(12_000), SOME_DATE)
    expect(l.collectedAmount).toBe(0)
    expect(l.status()).toBe('uncollected')
  })

  it('過回収の行は復元できない（CHECK 制約をすり抜けた場合の最後の関門）', () => {
    expectDomainError(
      () => Lending.restore(id(), 'テスト相手', '', yen(12_000), yen(12_001), SOME_DATE),
      'COLLECT_EXCEEDS_OUTSTANDING',
    )
  })
})
