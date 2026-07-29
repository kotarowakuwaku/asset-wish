import { beforeEach, describe, expect, it } from 'vitest'
import { countRows, db, givenWish, resetDb } from '../../../test/db'
import { expectDomainError, id, isoDateOf, yen } from '../../../test/support'
import { Wish } from '../../domain/wish'
import { isNotFoundError } from '../../usecase/port'
import { D1WishRepository, toWish } from './wish'

const repo = new D1WishRepository(db)

beforeEach(resetDb)

describe('list', () => {
  it('優先度の昇順で返す', async () => {
    await givenWish({ title: '後回し', priority: 3 })
    await givenWish({ title: '最優先', priority: 1 })
    await givenWish({ title: '中くらい', priority: 2 })

    expect((await repo.list(null)).map((w) => w.title)).toEqual(['最優先', '中くらい', '後回し'])
  })

  it('状態で絞り込める', async () => {
    await givenWish({ title: '検討中', status: 'considering' })
    await givenWish({ title: '確定', status: 'committed' })

    expect((await repo.list('committed')).map((w) => w.title)).toEqual(['確定'])
  })

  it('状態が null なら全件', async () => {
    await givenWish({ status: 'considering' })
    await givenWish({ status: 'dropped' })
    expect(await repo.list(null)).toHaveLength(2)
  })
})

describe('get', () => {
  it('保存した値がそのまま戻る', async () => {
    const w = await givenWish({
      title: 'テスト',
      amount: 80_000,
      category: 'experience',
      status: 'committed',
      priority: 2,
      deadline: '2026-12-31',
    })

    const got = await repo.get(w.id)
    expect(got.title).toBe('テスト')
    expect(got.amount).toBe(80_000)
    expect(got.category).toBe('experience')
    expect(got.status).toBe('committed')
    expect(got.priority).toBe(2)
    expect(got.deadline).toBe('2026-12-31')
  })

  it('期限なしは null で戻る', async () => {
    const w = await givenWish({ deadline: null })
    expect((await repo.get(w.id)).deadline).toBeNull()
  })

  it('無ければ NotFoundError', async () => {
    await expect(repo.get(id())).rejects.toSatisfy(isNotFoundError)
  })
})

describe('create', () => {
  it('検討中の状態で入る', async () => {
    const w = Wish.create(id(), {
      title: '新しいウィッシュ',
      amount: yen(50_000),
      category: 'goal',
      priority: 1,
      deadline: isoDateOf('2027-03-31'),
    })
    await repo.create(w)

    const got = await repo.get(w.id)
    expect(got.status).toBe('considering')
    expect(got.deadline).toBe('2027-03-31')
  })
})

describe('updateContent', () => {
  // 1本の UPDATE で status も書けるようにすると、遷移の可否を判定する
  // domain のメソッドを迂回できる（不変条件6）。SQL の側から塞いでいる。
  it('内容だけを書き、状態は動かさない', async () => {
    const stored = await givenWish({ title: '旧題', amount: 80_000, status: 'committed' })
    const w = await repo.get(stored.id)
    w.updateContent({
      title: '新題',
      amount: yen(90_000),
      category: 'goal',
      priority: 5,
      deadline: null,
    })

    await repo.updateContent(w)

    const got = await repo.get(stored.id)
    expect(got.title).toBe('新題')
    expect(got.amount).toBe(90_000)
    expect(got.category).toBe('goal')
    expect(got.priority).toBe(5)
    expect(got.deadline).toBeNull()
    expect(got.status).toBe('committed')
  })
})

describe('delete', () => {
  it('削除できる', async () => {
    const w = await givenWish()
    await repo.delete(w.id)
    expect(await countRows('wishes')).toBe(0)
  })
})

describe('CHECK 制約', () => {
  it('未知の状態は入らない', async () => {
    await expect(
      db
        .prepare(
          `INSERT INTO wishes (id, title, amount, category, status, priority)
           VALUES (?, 'x', 100, 'item', 'paid', 0)`,
        )
        .bind(id())
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/)
  })

  it('金額が0以下は入らない', async () => {
    await expect(
      db
        .prepare(
          `INSERT INTO wishes (id, title, amount, category, status, priority)
           VALUES (?, 'x', 0, 'item', 'considering', 0)`,
        )
        .bind(id())
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/)
  })
})

describe('toWish', () => {
  const row = {
    id: 'w1',
    title: 'テスト',
    amount: 80_000,
    category: 'item',
    status: 'considering',
    priority: 0,
    deadline: null,
  }

  it('未知の状態は復元しない', () => {
    expectDomainError(() => toWish({ ...row, status: 'paid' }), 'INVALID_WISH_STATUS')
  })

  it('未知の種別は復元しない', () => {
    expectDomainError(() => toWish({ ...row, category: 'trip' }), 'INVALID_WISH_CATEGORY')
  })

  it('存在しない期限なら投げる', () => {
    expect(() => toWish({ ...row, deadline: '2026-02-31' })).toThrow(/deadline/)
  })
})
