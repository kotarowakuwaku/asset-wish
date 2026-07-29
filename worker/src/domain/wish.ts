import { domainError } from './errors'
import { isPositiveMoney, type Money } from './money'
import type { IsoDate } from './time'

export const WISH_CATEGORIES = ['item', 'experience', 'goal'] as const
export type WishCategory = (typeof WISH_CATEGORIES)[number]

export function isWishCategory(v: string): v is WishCategory {
  return (WISH_CATEGORIES as readonly string[]).includes(v)
}

export const WISH_STATUSES = ['considering', 'committed', 'done', 'dropped'] as const
export type WishStatus = (typeof WISH_STATUSES)[number]

export function isWishStatus(v: string): v is WishStatus {
  return (WISH_STATUSES as readonly string[]).includes(v)
}

/** 終端状態か。done / dropped が true。 */
export function isTerminalWishStatus(s: WishStatus): boolean {
  return s === 'done' || s === 'dropped'
}

/** 内容の更新に渡す値。status はここに含めない（不変条件6）。 */
export type WishContent = {
  title: string
  amount: Money
  category: WishCategory
  priority: number
  deadline: IsoDate | null
}

/**
 * DB に保存されている表現。
 *
 * category と status を未検証の文字列で受けるのは、CHECK 制約をすり抜けた値を
 * ドメイン層に通さないため。呼び出し側にキャストさせると、検証の前に型で
 * 嘘をつくことになる（Account.restore / Transaction.restore と同じ形）。
 */
export type StoredWish = {
  title: string
  amount: Money
  category: string
  status: string
  priority: number
  deadline: IsoDate | null
}

/**
 * ウィッシュ。
 *
 * すべての値を #private にしてメソッド経由に限定している。直接代入できると、
 * 0円やタイトル空のウィッシュが更新経由で入り込み、状態遷移の可否判定
 *（不変条件6）も迂回できる。
 */
export class Wish {
  readonly id: string
  #title: string
  #amount: Money
  #category: WishCategory
  #priority: number
  #deadline: IsoDate | null
  #status: WishStatus

  private constructor(id: string, content: WishContent, status: WishStatus) {
    this.id = id
    this.#title = content.title
    this.#amount = content.amount
    this.#category = content.category
    this.#priority = content.priority
    this.#deadline = content.deadline
    this.#status = status
  }

  get title(): string {
    return this.#title
  }

  get amount(): Money {
    return this.#amount
  }

  get category(): WishCategory {
    return this.#category
  }

  get priority(): number {
    return this.#priority
  }

  get deadline(): IsoDate | null {
    return this.#deadline
  }

  /** 状態を動かせるのは commit / pay / drop だけ（不変条件6）。 */
  get status(): WishStatus {
    return this.#status
  }

  /**
   * 検討中の状態でウィッシュを生成する。
   * title が空、amount が 1 未満、category が不正なら投げる。
   */
  static create(id: string, content: WishContent): Wish {
    validateContent(content)
    return new Wish(id, content, 'considering')
  }

  /** DB から復元する。category と status は CHECK 制約をすり抜けた値を通さないため検証する。 */
  static restore(id: string, stored: StoredWish): Wish {
    if (!isWishCategory(stored.category)) throw domainError('INVALID_WISH_CATEGORY')
    if (!isWishStatus(stored.status)) throw domainError('INVALID_WISH_STATUS')
    return new Wish(
      id,
      {
        title: stored.title,
        amount: stored.amount,
        category: stored.category,
        priority: stored.priority,
        deadline: stored.deadline,
      },
      stored.status,
    )
  }

  /**
   * 内容を更新する。状態は変えない。
   *
   * Go 版は usecase が NewWish を呼び直して検証し、そのあと状態を戻していた。
   * 状態を戻し忘れると検討中に落ちるため、状態に触れない経路を domain 側に置く。
   */
  updateContent(content: WishContent): void {
    validateContent(content)
    this.#title = content.title
    this.#amount = content.amount
    this.#category = content.category
    this.#priority = content.priority
    this.#deadline = content.deadline
  }

  /**
   * 確定支出として実質資産から控除されるか。
   * committed のときのみ true。他の状態では必ず false（不変条件3）。
   */
  isCommitment(): boolean {
    return this.#status === 'committed'
  }

  /** 検討中 → 確定。検討中以外からは投げる。 */
  commit(): void {
    if (this.#status !== 'considering') throw domainError('INVALID_TRANSITION')
    this.#status = 'committed'
  }

  /** 確定 → 完了。確定以外からは投げる。 */
  pay(): void {
    if (this.#status !== 'committed') throw domainError('INVALID_TRANSITION')
    this.#status = 'done'
  }

  /** 検討中 または 確定 → 見送り。終端状態からは投げる。 */
  drop(): void {
    if (this.#status !== 'considering' && this.#status !== 'committed') {
      throw domainError('INVALID_TRANSITION')
    }
    this.#status = 'dropped'
  }
}

function validateContent(content: WishContent): void {
  if (content.title.trim() === '') throw domainError('EMPTY_TITLE')
  if (!isPositiveMoney(content.amount)) throw domainError('INVALID_AMOUNT')
  if (!isWishCategory(content.category)) throw domainError('INVALID_WISH_CATEGORY')
}
