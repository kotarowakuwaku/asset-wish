import { beforeEach, describe, expect, it } from 'vitest'
import { db, givenAccount, givenTransaction, rawBalance, resetDb } from '../../../test/db'
import {
  expectDomainError,
  expectRejectedDomainError,
  id,
  instantOf,
  SOME_INSTANT,
  yen,
} from '../../../test/support'
import { Account } from '../../domain/account'
import { isNotFoundError } from '../../usecase/port'
import { D1AccountRepository, toAccount } from './account'

const repo = new D1AccountRepository(db)

beforeEach(resetDb)

describe('list', () => {
  it('種別・名称の順に返す', async () => {
    await givenAccount({ name: 'ゆうちょ', kind: 'cash' })
    await givenAccount({ name: '証券', kind: 'investment' })
    await givenAccount({ name: 'あおぞら', kind: 'cash' })

    expect((await repo.list()).map((a) => a.name)).toEqual(['あおぞら', 'ゆうちょ', '証券'])
  })

  it('空なら空配列', async () => {
    expect(await repo.list()).toEqual([])
  })
})

describe('get', () => {
  it('保存した値がそのまま戻る', async () => {
    const a = await givenAccount({ name: 'テスト口座', kind: 'investment', balance: -1_000 })

    const got = await repo.get(a.id)
    expect(got.id).toBe(a.id)
    expect(got.name).toBe('テスト口座')
    expect(got.kind).toBe('investment')
    expect(got.balance).toBe(-1_000)
    expect(got.updatedAt).toBe(SOME_INSTANT)
  })

  it('無ければ NotFoundError', async () => {
    await expect(repo.get(id())).rejects.toSatisfy(isNotFoundError)
  })
})

describe('create', () => {
  it('作った口座を読み戻せる', async () => {
    const a = Account.create(id(), '新しい口座', 'cash', yen(1_000), SOME_INSTANT)
    await repo.create(a)
    expect((await repo.get(a.id)).name).toBe('新しい口座')
  })
})

describe('update', () => {
  it('名称・残高・更新日時を書く', async () => {
    const a = await givenAccount({ name: '旧名', balance: 500_000 })
    const later = instantOf('2026-08-01T00:00:00Z')
    a.rename('新名')
    a.updateBalance(yen(600_000), later)

    await repo.update(a)

    const got = await repo.get(a.id)
    expect(got.name).toBe('新名')
    expect(got.balance).toBe(600_000)
    expect(got.updatedAt).toBe(later)
  })

  // 種別が変わると、その口座が実質資産の計算から丸ごと消える（不変条件1）。
  // 書けないことを SQL の側で保証している。
  it('種別は書き換えられない', async () => {
    const a = await givenAccount({ kind: 'cash' })
    await repo.update(a)
    expect((await repo.get(a.id)).kind).toBe('cash')
  })
})

describe('delete', () => {
  it('削除できる', async () => {
    const a = await givenAccount()
    await repo.delete(a.id)
    await expect(repo.get(a.id)).rejects.toSatisfy(isNotFoundError)
  })

  // ON DELETE RESTRICT を ACCOUNT_IN_USE に翻訳する。
  // handler はこれを 422 にする。DB 固有のエラーを知ってよいのはこの層まで。
  it('取引履歴が残っていれば ACCOUNT_IN_USE', async () => {
    const a = await givenAccount()
    await givenTransaction(a.id)

    await expectRejectedDomainError(repo.delete(a.id), 'ACCOUNT_IN_USE')
    expect(await rawBalance(a.id)).not.toBeNull()
  })
})

// CHECK 制約をすり抜けた値をドメイン層に渡さないための最後の関門。
// 行の詰め替えは純粋関数なので、DB を壊さずにここだけ直接確かめられる。
describe('toAccount', () => {
  const row = { id: 'a1', name: 'テスト口座', kind: 'cash', balance: 1_000, updated_at: SOME_INSTANT }

  it('種別が不正なら投げる', () => {
    expectDomainError(() => toAccount({ ...row, kind: 'crypto' }), 'INVALID_ACCOUNT_KIND')
  })

  it('更新日時が壊れていれば投げる', () => {
    expect(() => toAccount({ ...row, updated_at: 'いつか' })).toThrow(/updated_at/)
  })

  it('残高が整数でなければ投げる', () => {
    expect(() => toAccount({ ...row, balance: 1.5 })).toThrow(/balance/)
  })
})
