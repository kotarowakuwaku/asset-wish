// テスト用の道具立て。ドメインの生成経路（コンストラクタ）を通しつつ、
// 検証本体に不要なフィールド（ID・名前・日時）を書かずに済ませる。
//
// 金額・氏名はすべて架空の値にすること（不変条件17。このリポジトリは public）。

import { expect } from 'vitest'
import { Account, type AccountKind } from '../src/domain/account'
import { isDomainError, type DomainErrorCode } from '../src/domain/errors'
import { Loan, type LoanDirection } from '../src/domain/loan'
import { money, type Money } from '../src/domain/money'
import { MonthlyBalance } from '../src/domain/monthlyBalance'
import { parseIsoDate, toInstant, type IsoDate, type Instant } from '../src/domain/time'
import { Wish, type WishStatus } from '../src/domain/wish'
import { YearMonth } from '../src/domain/yearMonth'

export const yen = money

export function isoDateOf(s: string): IsoDate {
  const d = parseIsoDate(s)
  if (d === null) throw new Error(`テストの日付が不正: ${s}`)
  return d
}

export function instantOf(s: string): Instant {
  return toInstant(new Date(s))
}

export const SOME_DATE = isoDateOf('2026-07-12')
export const SOME_INSTANT = instantOf('2026-07-29T00:00:00Z')

export function id(): string {
  return crypto.randomUUID()
}

export function acct(kind: AccountKind, balance: number): Account {
  return Account.create(id(), 'テスト口座', kind, yen(balance), SOME_INSTANT)
}

/** 貸した金。向きを書かずに済むのは、こちらが既定の向きだから。 */
export function lend(amount: number, settled: number): Loan {
  return loan('lent', amount, settled)
}

/** 借りた金。 */
export function borrow(amount: number, settled: number): Loan {
  return loan('borrowed', amount, settled)
}

export function loan(direction: LoanDirection, amount: number, settled: number): Loan {
  return Loan.restore(id(), direction, 'テスト相手', '', yen(amount), yen(settled), SOME_DATE)
}

export function wish(amount: number, status: WishStatus): Wish {
  return Wish.restore(id(), {
    title: 'テスト',
    amount: yen(amount),
    category: 'item',
    status,
    priority: 0,
    deadline: null,
  })
}

export function mb(year: number, month: number, income: number, expense: number): MonthlyBalance {
  return MonthlyBalance.create(id(), YearMonth.of(year, month), yen(income), yen(expense))
}

/** fn が指定した code の DomainError を投げることを検証する。 */
export function expectDomainError(fn: () => unknown, code: DomainErrorCode): void {
  try {
    fn()
  } catch (err) {
    if (!isDomainError(err)) throw err
    expect(err.code).toBe(code)
    return
  }
  expect.fail(`DomainError(${code}) を期待したが、何も投げられなかった`)
}

/** promise が指定した code の DomainError で失敗することを検証する。 */
export async function expectRejectedDomainError(
  promise: Promise<unknown>,
  code: DomainErrorCode,
): Promise<void> {
  try {
    await promise
  } catch (err) {
    if (!isDomainError(err)) throw err
    expect(err.code).toBe(code)
    return
  }
  expect.fail(`DomainError(${code}) を期待したが、何も投げられなかった`)
}

export type { Money }
