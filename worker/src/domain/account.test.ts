import { describe, expect, it } from 'vitest'
import { acct, expectDomainError, id, instantOf, SOME_INSTANT, yen } from '../../test/support'
import { Account, STALE_BALANCE_THRESHOLD_MS } from './account'

describe('Account', () => {
  it('cash だけが実質資産に算入される（不変条件1）', () => {
    expect(acct('cash', 500_000).countsTowardNetAsset()).toBe(true)
    expect(acct('investment', 500_000).countsTowardNetAsset()).toBe(false)
  })

  it('名称が空なら作れない', () => {
    expectDomainError(() => Account.create(id(), '  ', 'cash', yen(0), SOME_INSTANT), 'EMPTY_TITLE')
  })

  it('残高は負値を許容する（当座借越を想定）', () => {
    expect(acct('cash', -1_000).balance).toBe(-1_000)
  })

  it('不正な種別は復元できない（CHECK 制約をすり抜けた場合の最後の関門）', () => {
    expectDomainError(
      () => Account.restore(id(), 'テスト口座', 'crypto', yen(0), SOME_INSTANT),
      'INVALID_ACCOUNT_KIND',
    )
  })

  it('残高の更新は更新日時も動かす', () => {
    const a = acct('cash', 500_000)
    const later = instantOf('2026-08-01T00:00:00Z')
    a.updateBalance(yen(600_000), later)
    expect(a.balance).toBe(600_000)
    expect(a.updatedAt).toBe(later)
  })

  it('増減の適用は残高に加算する', () => {
    const a = acct('cash', 500_000)
    a.applyDelta(yen(-12_000), SOME_INSTANT)
    expect(a.balance).toBe(488_000)
  })

  it('名称の変更は検証を通る', () => {
    const a = acct('cash', 0)
    a.rename('別の口座')
    expect(a.name).toBe('別の口座')
    expectDomainError(() => a.rename(''), 'EMPTY_TITLE')
    expect(a.name).toBe('別の口座')
  })

  describe('isStale', () => {
    const updatedAt = instantOf('2026-06-01T00:00:00Z')
    const account = Account.restore(id(), 'テスト口座', 'cash', yen(0), updatedAt)

    it('閾値ちょうどで古いと判定する', () => {
      const now = instantOf(new Date(Date.parse(updatedAt) + STALE_BALANCE_THRESHOLD_MS).toISOString())
      expect(account.isStale(now, STALE_BALANCE_THRESHOLD_MS)).toBe(true)
    })

    it('閾値の1ミリ秒手前では古くない', () => {
      const now = instantOf(new Date(Date.parse(updatedAt) + STALE_BALANCE_THRESHOLD_MS - 1).toISOString())
      expect(account.isStale(now, STALE_BALANCE_THRESHOLD_MS)).toBe(false)
    })
  })
})
