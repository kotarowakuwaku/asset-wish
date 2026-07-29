import { beforeEach, describe, expect, it } from 'vitest'
import { countRows, db, givenLending, resetDb } from '../../../test/db'
import { expectDomainError, id, isoDateOf, SOME_DATE } from '../../../test/support'
import { isNotFoundError } from '../../usecase/port'
import { D1LendingRepository, toLending } from './lending'

const repo = new D1LendingRepository(db)

beforeEach(resetDb)

describe('list', () => {
  it('発生日の降順で返す', async () => {
    await givenLending({ counterparty: '古い', occurredOn: '2026-05-01' })
    await givenLending({ counterparty: '新しい', occurredOn: '2026-07-12' })
    await givenLending({ counterparty: '中間', occurredOn: '2026-06-15' })

    expect((await repo.list(false)).map((l) => l.counterparty)).toEqual(['新しい', '中間', '古い'])
  })

  it('outstandingOnly なら回収済みを除く', async () => {
    await givenLending({ counterparty: '未回収', amount: 12_000, collected: 0 })
    await givenLending({ counterparty: '一部回収', amount: 12_000, collected: 5_000 })
    await givenLending({ counterparty: '回収済み', amount: 12_000, collected: 12_000 })

    const names = (await repo.list(true)).map((l) => l.counterparty)
    expect(names).toHaveLength(2)
    expect(names).toContain('未回収')
    expect(names).toContain('一部回収')
    expect(names).not.toContain('回収済み')
  })

  it('全件なら回収済みも含む', async () => {
    await givenLending({ collected: 12_000, amount: 12_000 })
    expect(await repo.list(false)).toHaveLength(1)
  })
})

describe('get', () => {
  it('保存した値がそのまま戻る', async () => {
    const l = await givenLending({ amount: 12_000, collected: 5_000 })

    const got = await repo.get(l.id)
    expect(got.amount).toBe(12_000)
    expect(got.collectedAmount).toBe(5_000)
    expect(got.outstanding()).toBe(7_000)
    expect(got.status()).toBe('partial')
    expect(got.occurredOn).toBe(SOME_DATE)
  })

  it('無ければ NotFoundError', async () => {
    await expect(repo.get(id())).rejects.toSatisfy(isNotFoundError)
  })
})

describe('delete', () => {
  it('削除できる', async () => {
    const l = await givenLending()
    await repo.delete(l.id)
    expect(await countRows('lendings')).toBe(0)
  })
})

// 回収額そのものを DB が守る最後の防波堤。domain の検証をすり抜けても
// ここで止まる（不変条件4）。
describe('CHECK 制約', () => {
  it('回収額が立替額を超える行は入らない', async () => {
    await expect(
      db
        .prepare(
          `INSERT INTO lendings (id, counterparty, amount, collected_amount, occurred_on)
           VALUES (?, 'テスト相手', 100, 200, '2026-07-12')`,
        )
        .bind(id())
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/)
  })

  it('立替額が0以下の行は入らない', async () => {
    await expect(
      db
        .prepare(
          `INSERT INTO lendings (id, counterparty, amount, occurred_on)
           VALUES (?, 'テスト相手', 0, '2026-07-12')`,
        )
        .bind(id())
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/)
  })

  it('日付の形をしていない発生日は入らない', async () => {
    await expect(
      db
        .prepare(
          `INSERT INTO lendings (id, counterparty, amount, occurred_on)
           VALUES (?, 'テスト相手', 100, '2026/07/12')`,
        )
        .bind(id())
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/)
  })
})

describe('toLending', () => {
  const row = {
    id: 'l1',
    counterparty: 'テスト相手',
    description: '',
    amount: 12_000,
    collected_amount: 0,
    occurred_on: '2026-07-12',
  }

  it('存在しない日付なら投げる', () => {
    expect(() => toLending({ ...row, occurred_on: '2026-02-31' })).toThrow(/occurred_on/)
  })

  it('過回収の行は復元しない', () => {
    expectDomainError(
      () => toLending({ ...row, collected_amount: 12_001 }),
      'COLLECT_EXCEEDS_OUTSTANDING',
    )
  })

  it('正しい行は復元できる', () => {
    expect(toLending({ ...row, occurred_on: isoDateOf('2026-07-12') }).amount).toBe(12_000)
  })
})
