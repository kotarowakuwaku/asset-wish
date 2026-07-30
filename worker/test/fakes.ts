// usecase のテストで使う手書きの fake。モックライブラリは使わない。
//
// 見たいのは「手順が正しいか」なので、記録するだけでなく実際に状態を持つ。
// get が保存されている実体をそのまま返すと、usecase が書き込みもせずに
// 変更した内容が「保存された」ように見えてしまうため、必ず複製して返す。

import { Account } from '../src/domain/account'
import { Loan } from '../src/domain/loan'
import { MonthlyBalance } from '../src/domain/monthlyBalance'
import { Transaction } from '../src/domain/transaction'
import { Wish, type WishStatus } from '../src/domain/wish'
import {
  ConflictError,
  NotFoundError,
  type AccountRepository,
  type AtomicWriter,
  type Clock,
  type IDGenerator,
  type LoanRepository,
  type MonthlyBalanceRepository,
  type TransactionRepository,
  type WishRepository,
  type WriteOperation,
} from '../src/usecase/port'
import type { Instant } from '../src/domain/time'

function copyAccount(a: Account): Account {
  return Account.restore(a.id, a.name, a.kind, a.balance, a.updatedAt)
}

function copyLoan(l: Loan): Loan {
  return Loan.restore(
    l.id,
    l.direction,
    l.counterparty,
    l.description,
    l.amount,
    l.settledAmount,
    l.occurredOn,
  )
}

function copyWish(w: Wish): Wish {
  return Wish.restore(w.id, {
    title: w.title,
    amount: w.amount,
    category: w.category,
    status: w.status,
    priority: w.priority,
    deadline: w.deadline,
  })
}

export class FakeAccountRepository implements AccountRepository {
  readonly items = new Map<string, Account>()

  seed(...accounts: Account[]): void {
    for (const a of accounts) this.items.set(a.id, copyAccount(a))
  }

  async list(): Promise<Account[]> {
    return [...this.items.values()].map(copyAccount)
  }

  async get(id: string): Promise<Account> {
    const a = this.items.get(id)
    if (a === undefined) throw new NotFoundError('口座')
    return copyAccount(a)
  }

  async create(a: Account): Promise<void> {
    this.items.set(a.id, copyAccount(a))
  }

  async update(a: Account): Promise<void> {
    this.items.set(a.id, copyAccount(a))
  }

  async delete(id: string): Promise<void> {
    this.items.delete(id)
  }
}

export class FakeLoanRepository implements LoanRepository {
  readonly items = new Map<string, Loan>()

  seed(...loans: Loan[]): void {
    for (const l of loans) this.items.set(l.id, copyLoan(l))
  }

  async list(outstandingOnly: boolean): Promise<Loan[]> {
    return [...this.items.values()]
      .filter((l) => !outstandingOnly || !l.isFullySettled())
      .map(copyLoan)
  }

  async get(id: string): Promise<Loan> {
    const l = this.items.get(id)
    if (l === undefined) throw new NotFoundError('貸し借り')
    return copyLoan(l)
  }

  async delete(id: string): Promise<void> {
    this.items.delete(id)
  }
}

export class FakeWishRepository implements WishRepository {
  readonly items = new Map<string, Wish>()

  seed(...wishes: Wish[]): void {
    for (const w of wishes) this.items.set(w.id, copyWish(w))
  }

  async list(status: WishStatus | null): Promise<Wish[]> {
    return [...this.items.values()].filter((w) => status === null || w.status === status).map(copyWish)
  }

  async get(id: string): Promise<Wish> {
    const w = this.items.get(id)
    if (w === undefined) throw new NotFoundError('ウィッシュ')
    return copyWish(w)
  }

  async create(w: Wish): Promise<void> {
    this.items.set(w.id, copyWish(w))
  }

  async updateContent(w: Wish): Promise<void> {
    const stored = this.items.get(w.id)
    if (stored === undefined) throw new NotFoundError('ウィッシュ')
    // 内容だけを書く。状態は保存されている側の値を残す（不変条件6）。
    this.items.set(
      w.id,
      Wish.restore(w.id, {
        title: w.title,
        amount: w.amount,
        category: w.category,
        status: stored.status,
        priority: w.priority,
        deadline: w.deadline,
      }),
    )
  }

  async delete(id: string): Promise<void> {
    this.items.delete(id)
  }
}

export class FakeMonthlyBalanceRepository implements MonthlyBalanceRepository {
  readonly items: MonthlyBalance[] = []

  seed(...balances: MonthlyBalance[]): void {
    this.items.push(...balances)
  }

  async listAll(): Promise<MonthlyBalance[]> {
    return [...this.items].sort((a, b) => b.yearMonth.compare(a.yearMonth))
  }

  async listRecent(limit: number): Promise<MonthlyBalance[]> {
    return (await this.listAll()).slice(0, limit)
  }

  async upsert(m: MonthlyBalance): Promise<MonthlyBalance> {
    const existing = this.items.findIndex((x) => x.yearMonth.equals(m.yearMonth))
    if (existing === -1) {
      this.items.push(m)
      return m
    }
    // 既存行の id を維持する。実装（ON CONFLICT）と同じ振る舞い。
    const saved = MonthlyBalance.restore(this.items[existing].id, m.yearMonth, m.income, m.expense)
    this.items[existing] = saved
    return saved
  }
}

export class FakeTransactionRepository implements TransactionRepository {
  readonly items: Transaction[] = []

  async list(limit: number): Promise<Transaction[]> {
    return this.items.slice(0, limit)
  }
}

/**
 * 書き込みをまとめて適用する fake。
 *
 * 実装と同じく、前提条件が食い違えば ConflictError を投げて**1件も適用しない。**
 * 何を書こうとしたかは ops に残るので、usecase が正しい expected* を渡して
 * いるかを検証できる。
 */
export class FakeAtomicWriter implements AtomicWriter {
  readonly ops: WriteOperation[] = []

  readonly #accounts: FakeAccountRepository
  readonly #loans: FakeLoanRepository
  readonly #wishes: FakeWishRepository
  readonly #transactions: FakeTransactionRepository

  constructor(
    accounts: FakeAccountRepository,
    loans: FakeLoanRepository,
    wishes: FakeWishRepository,
    transactions: FakeTransactionRepository,
  ) {
    this.#accounts = accounts
    this.#loans = loans
    this.#wishes = wishes
    this.#transactions = transactions
  }

  async writeAll(ops: readonly WriteOperation[]): Promise<void> {
    for (const op of ops) {
      if (!this.#preconditionHolds(op)) throw new ConflictError()
    }
    this.ops.push(...ops)
    for (const op of ops) this.#apply(op)
  }

  #preconditionHolds(op: WriteOperation): boolean {
    switch (op.kind) {
      case 'updateAccount':
        return this.#accounts.items.get(op.account.id)?.balance === op.expectedBalance
      case 'updateLoanSettled':
        return this.#loans.items.get(op.loan.id)?.settledAmount === op.expectedSettledAmount
      case 'updateWishStatus':
        return this.#wishes.items.get(op.wish.id)?.status === op.expectedStatus
      case 'createLoan':
      case 'createTransaction':
        return true
    }
  }

  #apply(op: WriteOperation): void {
    switch (op.kind) {
      case 'createLoan':
        this.#loans.seed(op.loan)
        return
      case 'updateLoanSettled':
        this.#loans.seed(op.loan)
        return
      case 'updateWishStatus':
        this.#wishes.seed(op.wish)
        return
      case 'updateAccount':
        this.#accounts.seed(op.account)
        return
      case 'createTransaction':
        this.#transactions.items.push(op.transaction)
        return
    }
  }
}

/** すべての fake をまとめて用意する。 */
export function newFakes() {
  const accounts = new FakeAccountRepository()
  const loans = new FakeLoanRepository()
  const wishes = new FakeWishRepository()
  const balances = new FakeMonthlyBalanceRepository()
  const transactions = new FakeTransactionRepository()
  const writer = new FakeAtomicWriter(accounts, loans, wishes, transactions)
  return { accounts, loans, wishes, balances, transactions, writer }
}

/** 時刻を固定する。実時刻に依存したテストは日付をまたいだ瞬間に落ちる。 */
export function fixedClock(at: Instant): Clock {
  return () => at
}

/** 採番を固定する。連番なので、どの ID がどの順で採られたか読める。 */
export function sequentialIds(prefix = 'id'): IDGenerator {
  let n = 0
  return () => `${prefix}-${++n}`
}
