import { describe, expect, it } from 'vitest'
import { expectDomainError, id, SOME_DATE, yen } from '../../test/support'
import type { DomainErrorCode } from './errors'
import { requiresReference, Transaction, TRANSACTION_KINDS, isTransactionKind, type TransactionKind } from './transaction'

describe('Transaction.create', () => {
  const ref = id()

  const cases: {
    name: string
    amount: number
    kind: TransactionKind
    refId: string | null
    wantErr: DomainErrorCode | null
  }[] = [
    { name: '貸し借りの発生（出金）', amount: -12_000, kind: 'lending_created', refId: ref, wantErr: null },
    { name: '貸し借りの精算（入金）', amount: 5_000, kind: 'lending_collected', refId: ref, wantErr: null },
    { name: 'ウィッシュの支払い', amount: -80_000, kind: 'wish_paid', refId: ref, wantErr: null },
    { name: '手動調整は参照先なしでよい', amount: -300, kind: 'adjustment', refId: null, wantErr: null },
    { name: '金額0は記録する意味が無い', amount: 0, kind: 'adjustment', refId: null, wantErr: 'INVALID_AMOUNT' },
    { name: '未知の種別', amount: -100, kind: 'refund' as never, refId: ref, wantErr: 'INVALID_TRANSACTION_KIND' },
    { name: '貸し借りの発生に参照先が無い', amount: -100, kind: 'lending_created', refId: null, wantErr: 'MISSING_REFERENCE' },
    { name: '貸し借りの精算に参照先が無い', amount: 100, kind: 'lending_collected', refId: null, wantErr: 'MISSING_REFERENCE' },
    { name: '支払いに参照先が無い', amount: -100, kind: 'wish_paid', refId: null, wantErr: 'MISSING_REFERENCE' },
  ]

  it.each(cases)('$name', (c) => {
    const build = () => Transaction.create(id(), id(), yen(c.amount), c.kind, c.refId, SOME_DATE)
    if (c.wantErr !== null) {
      expectDomainError(build, c.wantErr)
      return
    }
    const t = build()
    expect(t.amount).toBe(c.amount)
    expect(t.kind).toBe(c.kind)
    expect(t.occurredOn).toBe(SOME_DATE)
  })

  // 参照先を持てる種別と持てない種別が混ざると、履歴を辿るときに
  // 「ref_id があるのに参照先が無い」行を疑う羽目になる。入口で落とす。
  it('adjustment は参照先を渡されても保持しない', () => {
    const t = Transaction.create(id(), id(), yen(-300), 'adjustment', id(), SOME_DATE)
    expect(t.refId).toBeNull()
  })

  it('参照先はそのまま保持される', () => {
    const ref = id()
    const t = Transaction.create(id(), id(), yen(-12_000), 'lending_created', ref, SOME_DATE)
    expect(t.refId).toBe(ref)
  })
})

describe('TransactionKind', () => {
  it('DB の CHECK 制約と同じ4種別が有効', () => {
    for (const k of TRANSACTION_KINDS) {
      expect(isTransactionKind(k)).toBe(true)
    }
    for (const k of ['', 'unknown', 'LENDING_CREATED']) {
      expect(isTransactionKind(k)).toBe(false)
    }
  })

  it('adjustment だけが参照先を要求しない', () => {
    expect(requiresReference('adjustment')).toBe(false)
    for (const k of ['lending_created', 'lending_collected', 'wish_paid'] as const) {
      expect(requiresReference(k)).toBe(true)
    }
  })
})
