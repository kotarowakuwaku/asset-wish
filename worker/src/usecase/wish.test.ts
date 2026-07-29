import { beforeEach, describe, expect, it } from 'vitest'
import { fixedClock, newFakes, sequentialIds } from '../../test/fakes'
import {
  expectRejectedDomainError,
  instantOf,
  isoDateOf,
  SOME_DATE,
  SOME_INSTANT,
  yen,
} from '../../test/support'
import { Account } from '../domain/account'
import { Wish, type WishStatus } from '../domain/wish'
import { isConflictError, isNotFoundError } from './port'
import { WishUsecase } from './wish'

const NOW = instantOf('2026-07-29T00:00:00Z')

let fakes: ReturnType<typeof newFakes>
let usecase: WishUsecase

beforeEach(() => {
  fakes = newFakes()
  usecase = new WishUsecase(fakes.writer, fakes.wishes, fakes.accounts, fixedClock(NOW), sequentialIds())
})

function givenWish(status: WishStatus, amount = 80_000): Wish {
  const w = Wish.restore('wish-1', {
    title: 'テスト',
    amount: yen(amount),
    category: 'item',
    status,
    priority: 0,
    deadline: null,
  })
  fakes.wishes.seed(w)
  return w
}

function givenAccount(balance: number): Account {
  const a = Account.create('acc-1', 'テスト口座', 'cash', yen(balance), SOME_INSTANT)
  fakes.accounts.seed(a)
  return a
}

describe('create', () => {
  it('検討中の状態で作る', async () => {
    const w = await usecase.create('新しい目標', yen(1_200_000), 'goal', 1, isoDateOf('2027-03-31'))
    expect(w.status).toBe('considering')
    expect(w.deadline).toBe('2027-03-31')
    expect(await usecase.list(null)).toHaveLength(1)
  })

  it('金額が0以下なら domain が弾く', async () => {
    await expectRejectedDomainError(usecase.create('x', yen(0), 'item', 0, null), 'INVALID_AMOUNT')
    expect(await usecase.list(null)).toHaveLength(0)
  })
})

describe('状態遷移', () => {
  it('commit は 検討中 → 確定', async () => {
    givenWish('considering')
    const w = await usecase.commit('wish-1')
    expect(w.status).toBe('committed')
    expect((await fakes.wishes.get('wish-1')).status).toBe('committed')
  })

  it('drop は 確定 → 見送り', async () => {
    givenWish('committed')
    expect((await usecase.drop('wish-1')).status).toBe('dropped')
  })

  // 遷移の可否は domain が判定する。usecase は if status を書かない（不変条件6）。
  it('終端状態からの遷移は弾かれ、何も書かない', async () => {
    givenWish('done')
    await expectRejectedDomainError(usecase.commit('wish-1'), 'INVALID_TRANSITION')
    await expectRejectedDomainError(usecase.drop('wish-1'), 'INVALID_TRANSITION')
    expect(fakes.writer.ops).toHaveLength(0)
  })

  it('遷移も「読み取った時点の状態」を条件にする', async () => {
    givenWish('considering')
    await usecase.commit('wish-1')
    const [op] = fakes.writer.ops
    expect(op.kind === 'updateWishStatus' && op.expectedStatus).toBe('considering')
  })

  // 2つのタブから同時に確定すると、2度目は状態が considering ではなくなっている。
  it('読み取りから書き込みの間に状態が動いていれば競合になる', async () => {
    givenWish('considering')

    // await を挟まずに呼ぶと、読み取りだけが済んだ状態で制御が戻る。
    const pending = usecase.commit('wish-1')
    // その隙に別の操作が先に確定する。
    givenWish('committed')

    await expect(pending).rejects.toSatisfy(isConflictError)
  })

  it('無ければ NotFoundError', async () => {
    await expect(usecase.commit('missing')).rejects.toSatisfy(isNotFoundError)
  })
})

describe('pay', () => {
  it('完了にし、口座残高を減らし、履歴を残す', async () => {
    givenWish('committed', 80_000)
    givenAccount(500_000)

    const w = await usecase.pay('wish-1', 'acc-1', SOME_DATE)

    expect(w.status).toBe('done')
    expect((await fakes.accounts.get('acc-1')).balance).toBe(420_000)
    expect(fakes.transactions.items[0].amount).toBe(-80_000)
    expect(fakes.transactions.items[0].kind).toBe('wish_paid')
    expect(fakes.transactions.items[0].refId).toBe('wish-1')
  })

  // 支払い後、そのウィッシュは確定支出から外れ、同額だけ残高が減る。
  // 実質資産は支払いの前後で変わらない。
  it('実質資産は支払いの前後で変わらない', async () => {
    givenWish('committed', 80_000)
    givenAccount(500_000)

    const before = 500_000 - 80_000 // 現金 - 確定支出
    await usecase.pay('wish-1', 'acc-1', SOME_DATE)
    const after = (await fakes.accounts.get('acc-1')).balance // 確定支出は外れた

    expect(after).toBe(before)
  })

  it('確定していないウィッシュは支払えず、何も書かない', async () => {
    givenWish('considering')
    givenAccount(500_000)

    await expectRejectedDomainError(usecase.pay('wish-1', 'acc-1', SOME_DATE), 'INVALID_TRANSITION')
    expect(fakes.writer.ops).toHaveLength(0)
    expect((await fakes.accounts.get('acc-1')).balance).toBe(500_000)
  })

  it('3件を1回の書き込みにまとめる', async () => {
    givenWish('committed')
    givenAccount(500_000)
    await usecase.pay('wish-1', 'acc-1', SOME_DATE)
    expect(fakes.writer.ops.map((o) => o.kind)).toEqual([
      'updateWishStatus',
      'updateAccount',
      'createTransaction',
    ])
  })

  it('口座が無ければ NotFoundError。何も書かない', async () => {
    givenWish('committed')
    await expect(usecase.pay('wish-1', 'missing', SOME_DATE)).rejects.toSatisfy(isNotFoundError)
    expect(fakes.writer.ops).toHaveLength(0)
  })
})

describe('updateContent', () => {
  it('渡した項目だけを変える', async () => {
    givenWish('committed', 80_000)

    const w = await usecase.updateContent('wish-1', { title: '新題' })

    expect(w.title).toBe('新題')
    expect(w.amount).toBe(80_000)
    expect(w.priority).toBe(0)
  })

  it('状態は動かさない（不変条件6）', async () => {
    givenWish('committed')
    await usecase.updateContent('wish-1', { title: '新題', amount: yen(90_000) })
    expect((await fakes.wishes.get('wish-1')).status).toBe('committed')
  })

  // undefined は「変更しない」、null は「期限を外す」。
  // 区別しないと、期限を消したいのか触っていないのか分からなくなる。
  it('期限は undefined と null を区別する', async () => {
    fakes.wishes.seed(
      Wish.restore('wish-1', {
        title: 'テスト',
        amount: yen(1_000),
        category: 'item',
        status: 'considering',
        priority: 0,
        deadline: isoDateOf('2026-12-31'),
      }),
    )

    await usecase.updateContent('wish-1', { title: '据え置き' })
    expect((await fakes.wishes.get('wish-1')).deadline).toBe('2026-12-31')

    await usecase.updateContent('wish-1', { deadline: null })
    expect((await fakes.wishes.get('wish-1')).deadline).toBeNull()
  })

  it('検証は素通りしない', async () => {
    givenWish('considering')
    await expectRejectedDomainError(usecase.updateContent('wish-1', { title: '' }), 'EMPTY_TITLE')
    expect((await fakes.wishes.get('wish-1')).title).toBe('テスト')
  })
})

describe('list / delete', () => {
  it('状態で絞れる', async () => {
    givenWish('considering')
    fakes.wishes.seed(
      Wish.restore('wish-2', {
        title: '別',
        amount: yen(1_000),
        category: 'item',
        status: 'committed',
        priority: 0,
        deadline: null,
      }),
    )
    expect(await usecase.list('committed')).toHaveLength(1)
    expect(await usecase.list(null)).toHaveLength(2)
  })

  it('削除できる', async () => {
    givenWish('considering')
    await usecase.delete('wish-1')
    expect(await usecase.list(null)).toHaveLength(0)
  })

  it('無いものを消そうとすれば NotFoundError', async () => {
    await expect(usecase.delete('missing')).rejects.toSatisfy(isNotFoundError)
  })
})
