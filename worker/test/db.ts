// D1 を使うテストの下ごしらえ。
//
// vitest-pool-workers はテストごとにストレージを巻き戻さないため、
// 各テストの前に自分で消す。Go 版の internal/dbtest に相当するが、
// アドバイザリロックは要らない。miniflare のインスタンスがテストファイル
// ごとに分かれているため、並行実行で壊し合わない。

import { env } from 'cloudflare:test'
import { Account } from '../src/domain/account'
import { Loan, type LoanDirection } from '../src/domain/loan'
import { money } from '../src/domain/money'
import { Transaction } from '../src/domain/transaction'
import { Wish } from '../src/domain/wish'
import { insertAccountStatement } from '../src/adapter/repository/account'
import { insertLoanStatement } from '../src/adapter/repository/loan'
import { insertTransactionStatement } from '../src/adapter/repository/transaction'
import { insertWishStatement } from '../src/adapter/repository/wish'
import { id, isoDateOf, SOME_DATE, SOME_INSTANT, yen } from './support'

export const db = env.DB

/** 全テーブルを空にする。外部キーがあるため transactions を先に消す。 */
export async function resetDb(): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM transactions'),
    db.prepare('DELETE FROM loans'),
    db.prepare('DELETE FROM wishes'),
    db.prepare('DELETE FROM monthly_balances'),
    db.prepare('DELETE FROM accounts'),
  ])
}

/** 口座を1件入れて返す。 */
export async function givenAccount(
  overrides: { id?: string; name?: string; kind?: 'cash' | 'investment'; balance?: number } = {},
): Promise<Account> {
  const a = Account.create(
    overrides.id ?? id(),
    overrides.name ?? 'テスト口座',
    overrides.kind ?? 'cash',
    yen(overrides.balance ?? 500_000),
    SOME_INSTANT,
  )
  await insertAccountStatement(db, a, false).run()
  return a
}

/**
 * 貸し借りを1件入れて返す。settled を指定すると精算済みの状態で入る。
 * direction を省くと貸した側（'lent'）になる。
 */
export async function givenLoan(
  overrides: {
    direction?: LoanDirection
    amount?: number
    settled?: number
    counterparty?: string
    occurredOn?: string
  } = {},
): Promise<Loan> {
  const l = Loan.restore(
    id(),
    overrides.direction ?? 'lent',
    overrides.counterparty ?? 'テスト相手',
    '',
    yen(overrides.amount ?? 12_000),
    yen(overrides.settled ?? 0),
    overrides.occurredOn === undefined ? SOME_DATE : isoDateOf(overrides.occurredOn),
  )
  await insertLoanStatement(db, l, false).run()
  return l
}

/** ウィッシュを1件入れて返す。 */
export async function givenWish(
  overrides: {
    title?: string
    amount?: number
    status?: string
    category?: string
    priority?: number
    deadline?: string | null
  } = {},
): Promise<Wish> {
  const w = Wish.restore(id(), {
    title: overrides.title ?? 'テスト',
    amount: money(overrides.amount ?? 80_000),
    category: overrides.category ?? 'item',
    status: overrides.status ?? 'considering',
    priority: overrides.priority ?? 0,
    deadline: overrides.deadline == null ? null : isoDateOf(overrides.deadline),
  })
  await insertWishStatement(db, w, false).run()
  return w
}

/**
 * 手入力の月次収支を1件入れる。
 *
 * **本番のコードにこの表へ書く経路はもう無い**（月次の収支は明細から集計する）。
 * 明細を打ち始める前の月を再現するために、テストからだけ直に入れる。
 */
export async function givenMonthlyBalance(
  yearMonth: string,
  income: number,
  expense: number,
): Promise<void> {
  await db
    .prepare('INSERT INTO monthly_balances (id, year_month, income, expense) VALUES (?, ?, ?, ?)')
    .bind(id(), yearMonth, income, expense)
    .run()
}

/** 取引履歴を1件入れて返す。 */
export async function givenTransaction(
  accountId: string,
  overrides: { amount?: number; kind?: 'adjustment'; occurredOn?: string; note?: string } = {},
): Promise<Transaction> {
  const t = Transaction.create(
    id(),
    accountId,
    yen(overrides.amount ?? -300),
    overrides.kind ?? 'adjustment',
    null,
    overrides.occurredOn === undefined ? SOME_DATE : isoDateOf(overrides.occurredOn),
    overrides.note ?? '',
  )
  await insertTransactionStatement(db, t, false).run()
  return t
}

/** 行数を数える。「1件も書かれていない」の検証に使う。 */
export async function countRows(table: 'accounts' | 'loans' | 'wishes' | 'transactions'): Promise<number> {
  const row = await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>()
  return row?.n ?? -1
}

/** 口座の残高を生で読む。ドメインを経由せずに DB の状態を確かめたいとき用。 */
export async function rawBalance(accountId: string): Promise<number | null> {
  const row = await db
    .prepare('SELECT balance FROM accounts WHERE id = ?')
    .bind(accountId)
    .first<{ balance: number }>()
  return row?.balance ?? null
}
