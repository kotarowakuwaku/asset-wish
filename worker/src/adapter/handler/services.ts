// 使う側がインターフェースを定義する。実装は usecase のクラス。
//
// テストでは決め打ちの値を返すスタブを差し込み、HTTP の関心事——ステータス
// コード、JSON の形、エラーの対応づけ——だけを検証する。手順が正しいかは
// usecase のテストが見る。

import type { Account, AccountKind } from '../../domain/account'
import type { Loan, LoanDirection } from '../../domain/loan'
import type { Money } from '../../domain/money'
import type { MonthlySummary } from '../../domain/monthlySummary'
import type { RecurringEntry } from '../../domain/recurring'
import type { IsoDate } from '../../domain/time'
import type { Transaction } from '../../domain/transaction'
import type { Wish, WishCategory, WishStatus } from '../../domain/wish'
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

// 貸し借りは口座を触らないため accountId を受け取らない（不変条件4）。
// 精算日も受け取らない。記録する先が無い（取引履歴が作られない）。
export type LoanService = {
  list(outstandingOnly: boolean): Promise<Loan[]>
  create(
    direction: LoanDirection,
    counterparty: string,
    description: string,
    amount: Money,
    occurredOn: IsoDate,
  ): Promise<Loan>
  settle(loanId: string, amount: Money): Promise<Loan>
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

// 手入力の経路は無い。月次の収支は明細から集計する（docs/decisions.md 2.4）。
// 同じ数字を明細と月次の2箇所に入れさせないため、書き込みの口ごと消してある。
// 適用は自動では起きない。件数はダッシュボードに出し、実行は明示的に呼ぶ
// （docs/decisions.md 2.5）。登録の時点では口座を触らない。
export type RecurringService = {
  list(): Promise<RecurringEntry[]>
  create(
    name: string,
    accountId: string,
    amount: Money,
    dayOfMonth: number,
  ): Promise<RecurringEntry>
  /** 未適用の分をまとめて適用し、件数を返す。 */
  apply(): Promise<number>
  delete(id: string): Promise<void>
}

export type MonthlySummaryService = {
  list(): Promise<MonthlySummary[]>
}

// 明細の登録は口座残高を動かす。金額は符号付きで受ける（出金は負）。
// 向きを別の項目にしないのは、一覧も符号付きで返しているため。
export type TransactionService = {
  list(limit: number): Promise<Transaction[]>
  create(accountId: string, amount: Money, occurredOn: IsoDate, note: string): Promise<Transaction>
  delete(id: string): Promise<void>
}

export type DashboardService = {
  get(): Promise<Dashboard>
}

export type Deps = {
  accounts: AccountService
  loans: LoanService
  wishes: WishService
  summaries: MonthlySummaryService
  recurring: RecurringService
  transactions: TransactionService
  dashboard: DashboardService
  /**
   * 口座の残高が古いか（isStale）の判定に使う。表示のための導出値だが、
   * 実時刻を直に読むとテストが日付をまたいだ瞬間に落ちる。
   */
  now: Clock
  authToken: string
}
