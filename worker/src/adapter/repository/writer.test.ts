import { beforeEach, describe, expect, it } from 'vitest'
import { countRows, db, givenAccount, givenLending, givenWish, rawBalance, resetDb } from '../../../test/db'
import { id, instantOf, SOME_DATE, yen } from '../../../test/support'
import { Lending } from '../../domain/lending'
import { Transaction } from '../../domain/transaction'
import { isConflictError, type WriteOperation } from '../../usecase/port'
import { D1AtomicWriter } from './writer'

const writer = new D1AtomicWriter(db)
const LATER = instantOf('2026-08-01T00:00:00Z')

beforeEach(resetDb)

async function expectConflict(ops: readonly WriteOperation[]): Promise<void> {
  try {
    await writer.writeAll(ops)
  } catch (err) {
    if (!isConflictError(err)) throw err
    return
  }
  expect.fail('ConflictError を期待したが、何も投げられなかった')
}

describe('立替の作成（口座残高の減算と履歴を伴う）', () => {
  it('前提が満たされていれば3件すべて書かれる', async () => {
    const account = await givenAccount({ balance: 500_000 })
    const before = account.balance
    const lending = Lending.create(id(), 'テスト相手', '', yen(12_000), SOME_DATE)
    account.applyDelta(yen(-12_000), LATER)

    await writer.writeAll([
      { kind: 'createLending', lending },
      { kind: 'updateAccount', account, expectedBalance: before },
      {
        kind: 'createTransaction',
        transaction: Transaction.create(
          id(),
          account.id,
          yen(-12_000),
          'lending_created',
          lending.id,
          SOME_DATE,
        ),
      },
    ])

    expect(await rawBalance(account.id)).toBe(488_000)
    expect(await countRows('lendings')).toBe(1)
    expect(await countRows('transactions')).toBe(1)
  })

  // ここが案 A の肝。素朴に条件付き UPDATE を並べるだけだと、
  // 更新0件でも後続の INSERT が実行され、立替だけが増える。
  it('残高が読み取り時と違えば ConflictError になり、1件も書かれない', async () => {
    const account = await givenAccount({ balance: 500_000 })
    const staleBalance = yen(499_999) // 別の操作が先に残高を動かした状況
    const lending = Lending.create(id(), 'テスト相手', '', yen(12_000), SOME_DATE)
    account.applyDelta(yen(-12_000), LATER)

    await expectConflict([
      { kind: 'createLending', lending },
      { kind: 'updateAccount', account, expectedBalance: staleBalance },
      {
        kind: 'createTransaction',
        transaction: Transaction.create(
          id(),
          account.id,
          yen(-12_000),
          'lending_created',
          lending.id,
          SOME_DATE,
        ),
      },
    ])

    expect(await rawBalance(account.id)).toBe(500_000)
    expect(await countRows('lendings')).toBe(0)
    expect(await countRows('transactions')).toBe(0)
  })
})

describe('立替の回収（前提条件が2つある）', () => {
  async function ops(
    expectedCollected: number,
    expectedBalance: number,
  ): Promise<readonly WriteOperation[]> {
    const account = await givenAccount({ balance: 500_000 })
    const lending = await givenLending({ amount: 12_000, collected: 0 })
    lending.collect(yen(5_000))
    account.applyDelta(yen(5_000), LATER)
    return [
      { kind: 'updateLendingCollected', lending, expectedCollectedAmount: yen(expectedCollected) },
      { kind: 'updateAccount', account, expectedBalance: yen(expectedBalance) },
      {
        kind: 'createTransaction',
        transaction: Transaction.create(
          id(),
          account.id,
          yen(5_000),
          'lending_collected',
          lending.id,
          SOME_DATE,
        ),
      },
    ]
  }

  it('両方の前提が満たされていれば3件すべて書かれる', async () => {
    await writer.writeAll(await ops(0, 500_000))

    const l = await db.prepare('SELECT collected_amount AS c FROM lendings').first<{ c: number }>()
    expect(l?.c).toBe(5_000)
    const row = await db.prepare('SELECT balance FROM accounts').first<{ balance: number }>()
    expect(row?.balance).toBe(505_000)
    expect(await countRows('transactions')).toBe(1)
  })

  it('回収額の前提だけ食い違っても1件も書かれない', async () => {
    await expectConflict(await ops(3_000, 500_000))

    const l = await db.prepare('SELECT collected_amount AS c FROM lendings').first<{ c: number }>()
    expect(l?.c).toBe(0)
    const row = await db.prepare('SELECT balance FROM accounts').first<{ balance: number }>()
    expect(row?.balance).toBe(500_000)
    expect(await countRows('transactions')).toBe(0)
  })

  // 前提条件を後続の文にばらして持たせると、先に走った UPDATE の結果を
  // あとの条件が見てしまう。番人を先頭に置いているのはこれを避けるため。
  it('残高の前提だけ食い違っても1件も書かれない', async () => {
    await expectConflict(await ops(0, 499_999))

    const l = await db.prepare('SELECT collected_amount AS c FROM lendings').first<{ c: number }>()
    expect(l?.c).toBe(0)
    const row = await db.prepare('SELECT balance FROM accounts').first<{ balance: number }>()
    expect(row?.balance).toBe(500_000)
    expect(await countRows('transactions')).toBe(0)
  })
})

describe('ウィッシュの支払い（状態の前提）', () => {
  it('状態が読み取り時と同じなら書かれる', async () => {
    const account = await givenAccount({ balance: 500_000 })
    const wish = await givenWish({ amount: 80_000, status: 'committed' })
    const before = account.balance
    wish.pay()
    account.applyDelta(yen(-80_000), LATER)

    await writer.writeAll([
      { kind: 'updateWishStatus', wish, expectedStatus: 'committed' },
      { kind: 'updateAccount', account, expectedBalance: before },
      {
        kind: 'createTransaction',
        transaction: Transaction.create(id(), account.id, yen(-80_000), 'wish_paid', wish.id, SOME_DATE),
      },
    ])

    const w = await db.prepare('SELECT status FROM wishes').first<{ status: string }>()
    expect(w?.status).toBe('done')
    expect(await rawBalance(account.id)).toBe(420_000)
  })

  // 2つのタブから同時に支払うと、2度目は状態が committed ではなくなっている。
  it('別の操作が先に状態を動かしていれば1件も書かれない', async () => {
    const account = await givenAccount({ balance: 500_000 })
    const wish = await givenWish({ amount: 80_000, status: 'done' })
    const before = account.balance
    account.applyDelta(yen(-80_000), LATER)

    await expectConflict([
      { kind: 'updateWishStatus', wish, expectedStatus: 'committed' },
      { kind: 'updateAccount', account, expectedBalance: before },
      {
        kind: 'createTransaction',
        transaction: Transaction.create(id(), account.id, yen(-80_000), 'wish_paid', wish.id, SOME_DATE),
      },
    ])

    const w = await db.prepare('SELECT status FROM wishes').first<{ status: string }>()
    expect(w?.status).toBe('done')
    expect(await rawBalance(account.id)).toBe(500_000)
    expect(await countRows('transactions')).toBe(0)
  })
})

describe('前提条件が無い場合', () => {
  it('番人を置かずにそのまま流す', async () => {
    const account = await givenAccount()
    const lending = Lending.create(id(), 'テスト相手', '', yen(12_000), SOME_DATE)
    await writer.writeAll([
      { kind: 'createLending', lending },
      {
        kind: 'createTransaction',
        transaction: Transaction.create(
          id(),
          account.id,
          yen(-12_000),
          'lending_created',
          lending.id,
          SOME_DATE,
        ),
      },
    ])
    expect(await countRows('lendings')).toBe(1)
    expect(await countRows('transactions')).toBe(1)
  })

  it('空なら何もしない', async () => {
    await writer.writeAll([])
    expect(await countRows('lendings')).toBe(0)
  })
})
