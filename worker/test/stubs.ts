// handler のテストで使うスタブ。
//
// 決め打ちの値を返すか、指定したエラーを投げるだけ。見たいのは HTTP の
// 関心事——ステータスコード、JSON の形、エラーの対応づけ——であって、
// 手順の正しさは usecase のテストが持つ。

import type { Deps } from '../src/adapter/handler/services'
import { Account } from '../src/domain/account'
import { Loan, type LoanDirection } from '../src/domain/loan'
import { money } from '../src/domain/money'
import { MonthlySummary, type MonthlySource } from '../src/domain/monthlySummary'
import { RecurringEntry } from '../src/domain/recurring'
import { Transaction } from '../src/domain/transaction'
import { Wish } from '../src/domain/wish'
import { YearMonth } from '../src/domain/yearMonth'
import type { Dashboard } from '../src/usecase/dashboard'
import { isoDateOf, SOME_DATE, SOME_INSTANT, yen } from './support'

export const TEST_TOKEN = 'test-token-that-is-long-enough-32'
export const TEST_ID = '00000000-0000-4000-8000-000000000001'
export const OTHER_ID = '00000000-0000-4000-8000-000000000002'
export const NOW = SOME_INSTANT

export function anAccount(overrides: { balance?: number; kind?: 'cash' | 'investment' } = {}): Account {
  return Account.create(
    TEST_ID,
    'テスト口座',
    overrides.kind ?? 'cash',
    yen(overrides.balance ?? 500_000),
    SOME_INSTANT,
  )
}

export function aLoan(
  overrides: { direction?: LoanDirection; amount?: number; settled?: number } = {},
): Loan {
  return Loan.restore(
    TEST_ID,
    overrides.direction ?? 'lent',
    'テスト相手',
    'メモ',
    yen(overrides.amount ?? 12_000),
    yen(overrides.settled ?? 5_000),
    SOME_DATE,
  )
}

export function aWish(overrides: { status?: string; deadline?: string | null } = {}): Wish {
  return Wish.restore(TEST_ID, {
    title: 'テスト',
    amount: money(80_000),
    category: 'item',
    status: overrides.status ?? 'considering',
    priority: 3,
    deadline: overrides.deadline == null ? null : isoDateOf(overrides.deadline),
  })
}

export function aRecurringEntry(): RecurringEntry {
  return RecurringEntry.restore(TEST_ID, '給料', OTHER_ID, yen(250_000), 25, YearMonth.of(2026, 7))
}

export function aMonthlySummary(source: MonthlySource = 'entries'): MonthlySummary {
  return MonthlySummary.of(YearMonth.of(2026, 7), yen(300_000), yen(230_000), source)
}

export function aTransaction(): Transaction {
  return Transaction.create(
    TEST_ID,
    OTHER_ID,
    yen(-12_000),
    'lending_created',
    OTHER_ID,
    SOME_DATE,
    '',
  )
}

/** 手入力の明細。削除できる唯一の種別。 */
export function anEntry(overrides: { amount?: number; note?: string } = {}): Transaction {
  return Transaction.create(
    TEST_ID,
    OTHER_ID,
    yen(overrides.amount ?? -3_000),
    'adjustment',
    null,
    SOME_DATE,
    overrides.note ?? 'コンビニ',
  )
}

export function aDashboard(): Dashboard {
  return {
    breakdown: { cashTotal: yen(910_000), commitments: yen(80_000) },
    netAsset: yen(830_000),
    investmentTotal: yen(350_000),
    outstanding: { lent: yen(12_000), borrowed: yen(5_000) },
    averageSurplus: yen(60_000),
    pendingRecurring: { count: 2, total: yen(170_000) },
    wishes: [
      { wish: aWish(), shortfall: yen(358_000), monthsToReach: 6, monthlySavingNeeded: yen(59_667) },
    ],
  }
}

/** 呼ばれた引数を記録する。handler が何を渡したかの検証に使う。 */
export type Calls = Record<string, unknown[]>

/**
 * すべての経路が通るスタブ一式。
 *
 * overrides で個別のメソッドを差し替える。エラーの対応づけを見るときは
 * 投げるだけのメソッドを渡す。
 */
export function stubDeps(overrides: Partial<Deps> = {}): Deps & { calls: Calls } {
  const calls: Calls = {}
  const record =
    <T>(name: string, result: () => T) =>
    (...args: unknown[]): Promise<T> => {
      calls[name] = args
      return Promise.resolve(result())
    }

  const base: Deps = {
    accounts: {
      list: record('accounts.list', () => [anAccount()]),
      create: record('accounts.create', () => anAccount()),
      update: record('accounts.update', () => anAccount()),
      delete: record('accounts.delete', () => undefined),
    },
    loans: {
      list: record('loans.list', () => [aLoan()]),
      create: record('loans.create', () => aLoan()),
      settle: record('loans.settle', () => aLoan()),
      delete: record('loans.delete', () => undefined),
    },
    wishes: {
      list: record('wishes.list', () => [aWish()]),
      create: record('wishes.create', () => aWish()),
      updateContent: record('wishes.updateContent', () => aWish()),
      commit: record('wishes.commit', () => aWish({ status: 'committed' })),
      pay: record('wishes.pay', () => aWish({ status: 'done' })),
      drop: record('wishes.drop', () => aWish({ status: 'dropped' })),
      delete: record('wishes.delete', () => undefined),
    },
    summaries: {
      list: record('summaries.list', () => [aMonthlySummary()]),
    },
    recurring: {
      list: record('recurring.list', () => [aRecurringEntry()]),
      create: record('recurring.create', () => aRecurringEntry()),
      apply: record('recurring.apply', () => 2),
      delete: record('recurring.delete', () => undefined),
    },
    transactions: {
      list: record('transactions.list', () => [aTransaction()]),
      create: record('transactions.create', () => anEntry()),
      delete: record('transactions.delete', () => undefined),
    },
    dashboard: {
      get: record('dashboard.get', () => aDashboard()),
    },
    now: () => NOW,
    authToken: TEST_TOKEN,
  }

  return { ...base, ...overrides, calls }
}

/** 認証つきのリクエストを組み立てる。 */
export function authed(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      Authorization: `Bearer ${TEST_TOKEN}`,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(init.headers as Record<string, string> | undefined),
    },
  }
}

/** JSON 本文つきの POST / PATCH / PUT を組み立てる。 */
export function jsonRequest(method: string, body: unknown): RequestInit {
  return authed({ method, body: JSON.stringify(body) })
}
