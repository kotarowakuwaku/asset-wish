import { beforeEach, describe, expect, it } from 'vitest'
import { db, givenAccount, resetDb } from '../../../test/db'
import { expectDomainError, id, yen } from '../../../test/support'
import { RecurringEntry } from '../../domain/recurring'
import { NotFoundError } from '../../usecase/port'
import { YearMonth } from '../../domain/yearMonth'
import {
  D1RecurringRepository,
  toRecurringEntry,
  updateRecurringAppliedStatement,
} from './recurring'

const repo = new D1RecurringRepository(db)

beforeEach(resetDb)

async function given(
  name: string,
  amount: number,
  dayOfMonth = 25,
  appliedThrough = '2026-07',
): Promise<RecurringEntry> {
  const account = await givenAccount()
  const e = RecurringEntry.restore(
    id(),
    name,
    account.id,
    yen(amount),
    dayOfMonth,
    YearMonth.parse(appliedThrough),
  )
  await repo.create(e)
  return e
}

describe('create / list', () => {
  it('保存した値がそのまま戻る', async () => {
    await given('給料', 250_000, 25, '2026-07')

    const [e] = await repo.list()
    expect(e.name).toBe('給料')
    // 符号付き。向きを別の列にしていない。
    expect(e.amount).toBe(250_000)
    expect(e.dayOfMonth).toBe(25)
    expect(e.appliedThrough.toString()).toBe('2026-07')
  })

  it('支出は負のまま戻る', async () => {
    await given('家賃', -80_000)
    expect((await repo.list())[0].amount).toBe(-80_000)
  })

  it('名称順で返す', async () => {
    await given('家賃', -80_000)
    await given('給料', 250_000)

    expect((await repo.list()).map((e) => e.name)).toEqual(['家賃', '給料'])
  })

  it('空なら空配列', async () => {
    expect(await repo.list()).toEqual([])
  })
})

describe('get', () => {
  it('1件を復元して返す', async () => {
    const created = await given('給料', 250_000)

    const got = await repo.get(created.id)
    expect(got.id).toBe(created.id)
    expect(got.amount).toBe(250_000)
  })

  it('無ければ NotFoundError', async () => {
    await expect(repo.get(id())).rejects.toThrow(NotFoundError)
  })
})

describe('updateRecurringAppliedStatement', () => {
  // 金額・適用日を書ける文は置いていない。適用のついでに条件が変わると、
  // 「どの条件で適用されたか」と履歴が食い違う。
  it('適用済み年月だけを書く', async () => {
    const created = await given('給料', 250_000, 25, '2026-07')
    created.markAppliedThrough(YearMonth.of(2026, 8))

    await updateRecurringAppliedStatement(db, created, false).run()

    const got = await repo.get(created.id)
    expect(got.appliedThrough.toString()).toBe('2026-08')
    expect(got.amount).toBe(250_000)
    expect(got.dayOfMonth).toBe(25)
  })
})

describe('delete', () => {
  it('消える', async () => {
    const created = await given('給料', 250_000)

    await repo.delete(created.id)

    expect(await repo.list()).toEqual([])
  })
})

// domain の判定をすり抜けた値を DB に残さないための最後の防波堤。
describe('CHECK 制約', () => {
  async function insertRaw(amount: number, dayOfMonth: number, appliedThrough: string) {
    const account = await givenAccount()
    return db
      .prepare(
        `INSERT INTO recurring_entries (id, name, account_id, amount, day_of_month, applied_through)
         VALUES (?, 'テスト', ?, ?, ?, ?)`,
      )
      .bind(id(), account.id, amount, dayOfMonth, appliedThrough)
      .run()
  }

  it('金額0は入らない', async () => {
    await expect(insertRaw(0, 25, '2026-07')).rejects.toThrow(/CHECK constraint failed/)
  })

  it.each([0, 32])('適用日 %s は入らない', async (day) => {
    await expect(insertRaw(1, day, '2026-07')).rejects.toThrow(/CHECK constraint failed/)
  })

  it('YYYY-MM の形をしていない適用済み年月は入らない', async () => {
    await expect(insertRaw(1, 25, '2026-7')).rejects.toThrow(/CHECK constraint failed/)
  })

  it('存在しない口座では入らない', async () => {
    await expect(
      db
        .prepare(
          `INSERT INTO recurring_entries (id, name, account_id, amount, day_of_month, applied_through)
           VALUES (?, 'テスト', ?, 1, 25, '2026-07')`,
        )
        .bind(id(), id())
        .run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/)
  })
})

describe('toRecurringEntry', () => {
  const row = {
    id: 'r1',
    name: '給料',
    account_id: 'a1',
    amount: 250_000,
    day_of_month: 25,
    applied_through: '2026-07',
  }

  it('適用済み年月の形が壊れていれば投げる', () => {
    expectDomainError(
      () => toRecurringEntry({ ...row, applied_through: '2026-7' }),
      'INVALID_YEAR_MONTH',
    )
  })

  it('適用日が範囲外なら投げる', () => {
    expectDomainError(() => toRecurringEntry({ ...row, day_of_month: 0 }), 'INVALID_DAY_OF_MONTH')
  })
})
