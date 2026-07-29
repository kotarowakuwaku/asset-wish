import { describe, expect, it } from 'vitest'
import { expectDomainError, id, wish, yen } from '../../test/support'
import type { DomainErrorCode } from './errors'
import { Wish, type WishStatus } from './wish'

describe('Wish の状態遷移', () => {
  const cases: {
    name: string
    initial: WishStatus
    op: 'commit' | 'pay' | 'drop'
    wantStatus: WishStatus
    wantErr: DomainErrorCode | null
  }[] = [
    { name: 'E-1: considering→commit 可', initial: 'considering', op: 'commit', wantStatus: 'committed', wantErr: null },
    { name: 'E-2: committed→commit 不可', initial: 'committed', op: 'commit', wantStatus: 'committed', wantErr: 'INVALID_TRANSITION' },
    { name: 'E-3: done→commit 不可', initial: 'done', op: 'commit', wantStatus: 'done', wantErr: 'INVALID_TRANSITION' },
    { name: 'E-4: dropped→commit 不可', initial: 'dropped', op: 'commit', wantStatus: 'dropped', wantErr: 'INVALID_TRANSITION' },
    { name: 'E-5: committed→pay 可', initial: 'committed', op: 'pay', wantStatus: 'done', wantErr: null },
    { name: 'E-6: considering→pay 不可', initial: 'considering', op: 'pay', wantStatus: 'considering', wantErr: 'INVALID_TRANSITION' },
    { name: 'E-7: done→pay 不可', initial: 'done', op: 'pay', wantStatus: 'done', wantErr: 'INVALID_TRANSITION' },
    { name: 'E-8: considering→drop 可', initial: 'considering', op: 'drop', wantStatus: 'dropped', wantErr: null },
    { name: 'E-9: committed→drop 可', initial: 'committed', op: 'drop', wantStatus: 'dropped', wantErr: null },
    { name: 'E-10: done→drop 不可', initial: 'done', op: 'drop', wantStatus: 'done', wantErr: 'INVALID_TRANSITION' },
    { name: 'E-11: dropped→drop 不可', initial: 'dropped', op: 'drop', wantStatus: 'dropped', wantErr: 'INVALID_TRANSITION' },
  ]

  it.each(cases)('$name', (c) => {
    const w = wish(1_000, c.initial)
    if (c.wantErr === null) {
      w[c.op]()
    } else {
      expectDomainError(() => w[c.op](), c.wantErr)
    }
    // エラー時に状態が変化していないことも検証する（最も気づきにくい不具合になるため）
    expect(w.status).toBe(c.wantStatus)
  })
})

describe('Wish', () => {
  const content = {
    title: 'テスト',
    amount: yen(1_000),
    category: 'item' as const,
    priority: 0,
    deadline: null,
  }

  it('作った直後は検討中', () => {
    expect(Wish.create(id(), content).status).toBe('considering')
  })

  it('committed のときだけ確定支出として控除される（不変条件3）', () => {
    expect(wish(1_000, 'committed').isCommitment()).toBe(true)
    for (const s of ['considering', 'done', 'dropped'] as const) {
      expect(wish(1_000, s).isCommitment()).toBe(false)
    }
  })

  it('タイトルが空なら作れない', () => {
    expectDomainError(() => Wish.create(id(), { ...content, title: '   ' }), 'EMPTY_TITLE')
  })

  it('金額が0以下なら作れない', () => {
    expectDomainError(() => Wish.create(id(), { ...content, amount: yen(0) }), 'INVALID_AMOUNT')
  })

  it('種別が不正なら作れない', () => {
    expectDomainError(
      () => Wish.create(id(), { ...content, category: 'unknown' as never }),
      'INVALID_WISH_CATEGORY',
    )
  })

  it('内容の更新は状態を動かさない（不変条件6）', () => {
    const w = wish(1_000, 'committed')
    w.updateContent({ ...content, title: '別のタイトル', amount: yen(2_000) })
    expect(w.title).toBe('別のタイトル')
    expect(w.amount).toBe(2_000)
    expect(w.status).toBe('committed')
  })

  it('内容の更新でも検証は素通りしない', () => {
    const w = wish(1_000, 'considering')
    expectDomainError(() => w.updateContent({ ...content, title: '' }), 'EMPTY_TITLE')
    expect(w.title).toBe('テスト')
  })

  it('不正な状態は復元できない（CHECK 制約をすり抜けた場合の最後の関門）', () => {
    expectDomainError(() => Wish.restore(id(), content, 'paid'), 'INVALID_WISH_STATUS')
  })
})
