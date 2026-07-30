import { domainError } from './errors'
import { addMoney, type Money } from './money'
import { instantDiffMillis, type Instant } from './time'

/** 残高が古いと判断する閾値。45日。 */
export const STALE_BALANCE_THRESHOLD_MS = 45 * 24 * 60 * 60 * 1000

export const ACCOUNT_KINDS = ['cash', 'investment'] as const

/** cash は実質資産に算入する。investment は算入しない。 */
export type AccountKind = (typeof ACCOUNT_KINDS)[number]

export function isAccountKind(v: string): v is AccountKind {
  return (ACCOUNT_KINDS as readonly string[]).includes(v)
}

/**
 * 口座。
 *
 * 書き換わる値は #private にしてメソッド経由に限定している。
 * balance を直接代入できると updatedAt が古いまま残り、isStale による
 * 残高更新の催促が効かなくなる。kind は生成後に変えられない（不変条件1）。
 */
export class Account {
  readonly id: string
  readonly kind: AccountKind
  #name: string
  #balance: Money
  #updatedAt: Instant

  private constructor(id: string, name: string, kind: AccountKind, balance: Money, updatedAt: Instant) {
    this.id = id
    this.kind = kind
    this.#name = name
    this.#balance = balance
    this.#updatedAt = updatedAt
  }

  get name(): string {
    return this.#name
  }

  get balance(): Money {
    return this.#balance
  }

  get updatedAt(): Instant {
    return this.#updatedAt
  }

  /**
   * 口座を生成する。name が空、または kind が不正なら投げる。
   * balance は負値を許容する（当座借越などを想定）。
   */
  static create(id: string, name: string, kind: AccountKind, balance: Money, now: Instant): Account {
    if (name.trim() === '') throw domainError('EMPTY_TITLE')
    if (!isAccountKind(kind)) throw domainError('INVALID_ACCOUNT_KIND')
    return new Account(id, name, kind, balance, now)
  }

  /**
   * DB から復元する。kind は CHECK 制約をすり抜けた値を通さないためここで検証する。
   * 名称の検証は行わない。既に保存されている値を復元不能にしないため。
   */
  static restore(id: string, name: string, kind: string, balance: Money, updatedAt: Instant): Account {
    if (!isAccountKind(kind)) throw domainError('INVALID_ACCOUNT_KIND')
    return new Account(id, name, kind, balance, updatedAt)
  }

  /**
   * 実質資産の計算に算入すべきかを返す。
   * investment は必ず false（不変条件1。実質資産の存在意義に関わる）。
   */
  countsTowardNetAsset(): boolean {
    return this.kind === 'cash'
  }

  /**
   * 名称を変更する。kind は変更できない（不変条件1）。
   *
   * Go 版は usecase が NewAccount を呼び直して検証していた。同じ検証を
   * domain 側のメソッドに置き、usecase から生成経路を消している。
   */
  rename(name: string): void {
    if (name.trim() === '') throw domainError('EMPTY_TITLE')
    this.#name = name
  }

  /** 残高を更新し、更新日時を now にする。 */
  updateBalance(balance: Money, now: Instant): void {
    this.#balance = balance
    this.#updatedAt = now
  }

  /**
   * 残高を増減させる。ウィッシュの支払いで用いる。
   *
   * 貸し借りの発生・精算では**用いない。** 貸し借りは口座残高を動かさない（不変条件4）。
   */
  applyDelta(delta: Money, now: Instant): void {
    this.#balance = addMoney(this.#balance, delta)
    this.#updatedAt = now
  }

  /** 最終更新から thresholdMillis 以上経過しているか。残高更新の催促表示に用いる。 */
  isStale(now: Instant, thresholdMillis: number): boolean {
    return instantDiffMillis(now, this.#updatedAt) >= thresholdMillis
  }
}
