import { beforeEach, describe, expect, it } from 'vitest'
import { db, givenAccount, givenTransaction, resetDb } from '../../../test/db'
import { expectDomainError, id, SOME_DATE } from '../../../test/support'
import { D1TransactionRepository, toTransaction } from './transaction'

const repo = new D1TransactionRepository(db)

beforeEach(resetDb)

describe('list', () => {
  it('発生日の降順で返す', async () => {
    const a = await givenAccount()
    await givenTransaction(a.id, { amount: -100, occurredOn: '2026-05-01' })
    await givenTransaction(a.id, { amount: -300, occurredOn: '2026-07-12' })
    await givenTransaction(a.id, { amount: -200, occurredOn: '2026-06-15' })

    expect((await repo.list(100)).map((t) => t.amount)).toEqual([-300, -200, -100])
  })

  it('件数を絞れる', async () => {
    const a = await givenAccount()
    await givenTransaction(a.id, { occurredOn: '2026-05-01' })
    await givenTransaction(a.id, { occurredOn: '2026-07-12' })

    expect(await repo.list(1)).toHaveLength(1)
  })

  it('limit が0以下なら全件相当', async () => {
    const a = await givenAccount()
    await givenTransaction(a.id)
    await givenTransaction(a.id)
    expect(await repo.list(0)).toHaveLength(2)
  })

  it('符号と種別がそのまま戻る', async () => {
    const a = await givenAccount()
    await givenTransaction(a.id, { amount: -300, kind: 'adjustment' })

    const [t] = await repo.list(100)
    expect(t.amount).toBe(-300)
    expect(t.kind).toBe('adjustment')
    expect(t.refId).toBeNull()
    expect(t.accountId).toBe(a.id)
    expect(t.occurredOn).toBe(SOME_DATE)
  })

  it('空なら空配列', async () => {
    expect(await repo.list(100)).toEqual([])
  })
})

// 参照先が2種類あるため外部キーは張れないが、口座への参照は張ってある。
describe('外部キー', () => {
  it('存在しない口座の取引は入らない', async () => {
    await expect(
      db
        .prepare(
          `INSERT INTO transactions (id, account_id, amount, kind, occurred_on)
           VALUES (?, ?, -100, 'adjustment', '2026-07-12')`,
        )
        .bind(id(), id())
        .run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/)
  })
})

describe('toTransaction', () => {
  const row = {
    id: 't1',
    account_id: 'a1',
    amount: -300,
    kind: 'adjustment',
    ref_id: null,
    occurred_on: '2026-07-12',
  }

  it('未知の種別は復元しない', () => {
    expectDomainError(() => toTransaction({ ...row, kind: 'refund' }), 'INVALID_TRANSACTION_KIND')
  })

  it('存在しない発生日なら投げる', () => {
    expect(() => toTransaction({ ...row, occurred_on: '2026-02-31' })).toThrow(/occurred_on/)
  })
})
