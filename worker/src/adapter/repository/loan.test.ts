import { beforeEach, describe, expect, it } from 'vitest'
import { countRows, db, givenLoan, resetDb } from '../../../test/db'
import { expectDomainError, id, isoDateOf, SOME_DATE } from '../../../test/support'
import { isNotFoundError } from '../../usecase/port'
import { D1LoanRepository, toLoan } from './loan'

const repo = new D1LoanRepository(db)

beforeEach(resetDb)

describe('list', () => {
  it('発生日の降順で返す', async () => {
    await givenLoan({ counterparty: '古い', occurredOn: '2026-05-01' })
    await givenLoan({ counterparty: '新しい', occurredOn: '2026-07-12' })
    await givenLoan({ counterparty: '中間', occurredOn: '2026-06-15' })

    expect((await repo.list(false)).map((l) => l.counterparty)).toEqual(['新しい', '中間', '古い'])
  })

  it('outstandingOnly なら精算済みを除く', async () => {
    await givenLoan({ counterparty: '未精算', amount: 12_000, settled: 0 })
    await givenLoan({ counterparty: '一部精算', amount: 12_000, settled: 5_000 })
    await givenLoan({ counterparty: '精算済み', amount: 12_000, settled: 12_000 })

    const names = (await repo.list(true)).map((l) => l.counterparty)
    expect(names).toHaveLength(2)
    expect(names).toContain('未精算')
    expect(names).toContain('一部精算')
    expect(names).not.toContain('精算済み')
  })

  it('全件なら精算済みも含む', async () => {
    await givenLoan({ settled: 12_000, amount: 12_000 })
    expect(await repo.list(false)).toHaveLength(1)
  })
})

describe('get', () => {
  it('保存した値がそのまま戻る', async () => {
    const l = await givenLoan({ amount: 12_000, settled: 5_000 })

    const got = await repo.get(l.id)
    expect(got.amount).toBe(12_000)
    expect(got.settledAmount).toBe(5_000)
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
    const l = await givenLoan()
    await repo.delete(l.id)
    expect(await countRows('loans')).toBe(0)
  })
})

// 精算額そのものを DB が守る最後の防波堤。domain の検証をすり抜けても
// ここで止まる（不変条件4）。
describe('CHECK 制約', () => {
  it('精算額が貸し借り額を超える行は入らない', async () => {
    await expect(
      db
        .prepare(
          `INSERT INTO loans (id, direction, counterparty, amount, settled_amount, occurred_on)
           VALUES (?, 'lent', 'テスト相手', 100, 200, '2026-07-12')`,
        )
        .bind(id())
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/)
  })

  it('貸し借り額が0以下の行は入らない', async () => {
    await expect(
      db
        .prepare(
          `INSERT INTO loans (id, direction, counterparty, amount, occurred_on)
           VALUES (?, 'lent', 'テスト相手', 0, '2026-07-12')`,
        )
        .bind(id())
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/)
  })

  it('日付の形をしていない発生日は入らない', async () => {
    await expect(
      db
        .prepare(
          `INSERT INTO loans (id, direction, counterparty, amount, occurred_on)
           VALUES (?, 'lent', 'テスト相手', 100, '2026/07/12')`,
        )
        .bind(id())
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/)
  })
})

describe('toLoan', () => {
  const row = {
    id: 'l1',
    direction: 'lent',
    counterparty: 'テスト相手',
    description: '',
    amount: 12_000,
    settled_amount: 0,
    occurred_on: '2026-07-12',
  }

  it('存在しない日付なら投げる', () => {
    expect(() => toLoan({ ...row, occurred_on: '2026-02-31' })).toThrow(/occurred_on/)
  })

  it('過精算の行は復元しない', () => {
    expectDomainError(
      () => toLoan({ ...row, settled_amount: 12_001 }),
      'SETTLE_EXCEEDS_OUTSTANDING',
    )
  })

  // 行の型は direction を string で持つ。CHECK 制約をすり抜けた値が
  // ドメインに入らないことを、ここで確かめる。
  it('向きが不正な行は復元しない', () => {
    expectDomainError(() => toLoan({ ...row, direction: 'sideways' }), 'INVALID_LOAN_DIRECTION')
  })

  it.each(['lent', 'borrowed'])('正しい行は復元できる（%s）', (direction) => {
    const l = toLoan({ ...row, direction, occurred_on: isoDateOf('2026-07-12') })
    expect(l.amount).toBe(12_000)
    expect(l.direction).toBe(direction)
  })
})
