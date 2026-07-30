// 使う側がインターフェースを定義する。実装は usecase のクラス。
//
// テストでは決め打ちの値を返すスタブを差し込み、HTTP の関心事——ステータス
// コード、JSON の形、エラーの対応づけ——だけを検証する。手順が正しいかは
// usecase のテストが見る。

import type { Account, AccountKind } from '../../domain/account'
import type { Lending } from '../../domain/lending'
import type { Money } from '../../domain/money'
import type { MonthlyBalance } from '../../domain/monthlyBalance'
import type { IsoDate } from '../../domain/time'
import type { Transaction } from '../../domain/transaction'
import type { Wish, WishCategory, WishStatus } from '../../domain/wish'
import type { YearMonth } from '../../domain/yearMonth'
import type { UpdateAccountInput } from '../../usecase/account'
import type { Dashboard } from '../../usecase/dashboard'
import type { Clock } from '../../usecase/port'
import type { UpdateWishInput } from '../../usecase/wish'

export type AccountService = {
  list(): Promise<Account[]>
  create(name: string, kind: AccountKind, balance: Money): Promise<Account>
  update(id: string, input: UpdateAccountInput): Promise<Account>
  delete(id: string): Promise<void>
}

// 立替は口座を触らないため accountId を受け取らない（不変条件4）。
// 回収日も受け取らない。記録する先が無い（取引履歴が作られない）。
export type LendingService = {
  list(outstandingOnly: boolean): Promise<Lending[]>
  create(
    counterparty: string,
    description: string,
    amount: Money,
    occurredOn: IsoDate,
  ): Promise<Lending>
  collect(lendingId: string, amount: Money): Promise<Lending>
  delete(id: string): Promise<void>
}

export type WishService = {
  list(status: WishStatus | null): Promise<Wish[]>
  create(
    title: string,
    amount: Money,
    category: WishCategory,
    priority: number,
    deadline: IsoDate | null,
  ): Promise<Wish>
  updateContent(id: string, input: UpdateWishInput): Promise<Wish>
  commit(id: string): Promise<Wish>
  pay(id: string, accountId: string, occurredOn: IsoDate): Promise<Wish>
  drop(id: string): Promise<Wish>
  delete(id: string): Promise<void>
}

export type MonthlyBalanceService = {
  list(): Promise<MonthlyBalance[]>
  upsert(yearMonth: YearMonth, income: Money, expense: Money): Promise<MonthlyBalance>
}

export type TransactionService = {
  list(limit: number): Promise<Transaction[]>
}

export type DashboardService = {
  get(): Promise<Dashboard>
}

export type Deps = {
  accounts: AccountService
  lendings: LendingService
  wishes: WishService
  balances: MonthlyBalanceService
  transactions: TransactionService
  dashboard: DashboardService
  /**
   * 口座の残高が古いか（isStale）の判定に使う。表示のための導出値だが、
   * 実時刻を直に読むとテストが日付をまたいだ瞬間に落ちる。
   */
  now: Clock
  authToken: string
}
