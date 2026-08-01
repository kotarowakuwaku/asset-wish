// アプリケーションの手順を組み立てる層の入口。
//
// 永続化の手段は知らない。必要な操作をインターフェースとしてここに定義し、
// 実装は adapter/repository が与える。使う側がインターフェースを持つことで、
// 依存の向きを handler → usecase → domain に保つ（不変条件9）。

import type { Account } from '../domain/account'
import type { Loan } from '../domain/loan'
import type { Money } from '../domain/money'
import type { MonthlyBalance } from '../domain/monthlyBalance'
import { toInstant, type Instant } from '../domain/time'
import type { Transaction } from '../domain/transaction'
import type { Wish, WishStatus } from '../domain/wish'

/**
 * 対象が存在しないことを表す。handler で 404 に対応させる。
 *
 * DomainError ではない。業務ルール違反（422）と「そもそも無い」（404）は別物。
 */
export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what}が見つかりません`)
    this.name = 'NotFoundError'
  }
}

export function isNotFoundError(err: unknown): err is NotFoundError {
  return err instanceof NotFoundError
}

/**
 * 読み取ってから書き込むまでの間に、別の操作が同じ行を書き換えたことを表す。
 * handler で 409 に対応させる。
 *
 * D1 にトランザクションが無いため、読み取り時の値を UPDATE の条件に含める
 * 楽観ロックで守っている（docs/migration-cloudflare.md 4章の案 A）。
 * 単一ユーザーでも PC とスマホ、あるいは複数タブで起こりうる。
 *
 * リトライはしない。握り潰して書き換えるより、気付けるほうがよい。
 */
export class ConflictError extends Error {
  constructor() {
    super('他の操作と競合しました。読み込み直してからやり直してください')
    this.name = 'ConflictError'
  }
}

export function isConflictError(err: unknown): err is ConflictError {
  return err instanceof ConflictError
}

/**
 * 現在時刻を返す。
 *
 * Date を直に触らずに注入するのは、テストで時刻を固定するため。口座の更新日時は
 * 「残高がいつ時点のものか」を表す値で、表示にも使われる（Account.isStale）。
 * 実時刻に依存したテストは、境界をまたいだ瞬間に落ちる。
 */
export type Clock = () => Instant

/** 新しい ID を採番する。テストで固定するために注入する。 */
export type IDGenerator = () => string

/** 本番で使う実時刻。 */
export const systemClock: Clock = () => toInstant(new Date())

/** 本番で使う採番。Workers 組み込みの crypto を使う。 */
export const newUUID: IDGenerator = () => crypto.randomUUID()

// 更新系のメソッドを操作ごとに分けている。全項目を書き戻す update を1本置くと、
// 状態遷移や口座種別まで巻き込んで上書きでき、domain の判定を通さない変更経路が
// できる（CLAUDE.md「更新クエリを操作別に分ける」）。SQL 側も同じ形に割ってある。

export interface AccountRepository {
  list(): Promise<Account[]>
  /** 見つからなければ NotFoundError。 */
  get(id: string): Promise<Account>
  create(a: Account): Promise<void>
  /**
   * 名称・残高・更新日時を反映する。kind は変更できない。
   * 種別が変わると、その口座が実質資産の計算から外れるため（不変条件1）。
   */
  update(a: Account): Promise<void>
  /** 取引履歴が残っていれば ACCOUNT_IN_USE の DomainError。 */
  delete(id: string): Promise<void>
}

export interface LoanRepository {
  /** outstandingOnly が true なら未精算（精算額 < 貸し借り額）のみ返す。 */
  list(outstandingOnly: boolean): Promise<Loan[]>
  get(id: string): Promise<Loan>
  delete(id: string): Promise<void>
}

export interface WishRepository {
  /** status が null なら全件を返す。 */
  list(status: WishStatus | null): Promise<Wish[]>
  get(id: string): Promise<Wish>
  create(w: Wish): Promise<void>
  /**
   * title / amount / category / priority / deadline を反映する。
   * status は動かさない。遷移は WriteOperation の updateWishStatus を使う。
   */
  updateContent(w: Wish): Promise<void>
  delete(id: string): Promise<void>
}

export interface MonthlyBalanceRepository {
  /** 年月の降順で最大 limit 件を返す。 */
  listRecent(limit: number): Promise<MonthlyBalance[]>
  listAll(): Promise<MonthlyBalance[]>
  /**
   * 同一年月があれば更新、なければ作成し、保存後の姿を返す。
   *
   * 戻り値があるのは ID のため。既存行を更新した場合、DB は既存の ID を
   * 維持するので、呼び出し側が採番した ID は使われない。返さないと
   * 存在しない ID をレスポンスに載せることになる。
   */
  upsert(m: MonthlyBalance): Promise<MonthlyBalance>
}

export interface TransactionRepository {
  /** 発生日の降順で最大 limit 件を返す。 */
  list(limit: number): Promise<Transaction[]>
  /** 見つからなければ NotFoundError。 */
  get(id: string): Promise<Transaction>
}
// 作成と削除がここに無いのは、どちらも口座残高の増減と同じ batch に載るため。
// 単独で書ける経路を残すと、履歴だけが増えて残高が動かない状態を作れる（不変条件10）。

/**
 * まとめて書き込む操作。
 *
 * Go 版の TxManager.RunInTx の置き換え。D1 は BEGIN を受け付けないため、
 * 「読む → domain が判断する → 書く」の書き込み部分だけをデータとして組み立て、
 * 1回の batch として原子的に流す。
 *
 * expected* は読み取った時点の値。書き込み時にその値が変わっていれば競合と
 * みなして ConflictError にする。usecase は「何を書くか」だけを知り、
 * 楽観ロックの実現方法は adapter が持つ。
 */
export type WriteOperation =
  | { kind: 'createLoan'; loan: Loan }
  | { kind: 'updateLoanSettled'; loan: Loan; expectedSettledAmount: Money }
  | { kind: 'updateWishStatus'; wish: Wish; expectedStatus: WishStatus }
  | { kind: 'updateAccount'; account: Account; expectedBalance: Money }
  | { kind: 'createTransaction'; transaction: Transaction }
  | { kind: 'deleteTransaction'; transaction: Transaction }

export interface AtomicWriter {
  /**
   * 1回のトランザクションとしてまとめて実行する。
   *
   * expected* が食い違っていれば ConflictError を投げ、**1件も書き込まない。**
   * トランザクション境界をここに閉じ込めることで、handler や repository が
   * 個別に境界を張ることはしない（不変条件10）。
   */
  writeAll(ops: readonly WriteOperation[]): Promise<void>
}
