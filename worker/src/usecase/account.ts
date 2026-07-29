import { Account, type AccountKind } from '../domain/account'
import type { Money } from '../domain/money'
import type { AccountRepository, Clock, IDGenerator } from './port'

/** PATCH の部分更新を表す。undefined の項目は変更しない。 */
export type UpdateAccountInput = {
  name?: string
  balance?: Money
}
// kind が無いのは、口座種別を変えられないため。種別が変わると、その口座が
// 実質資産の計算から丸ごと外れる（不変条件1）。

export class AccountUsecase {
  readonly #accounts: AccountRepository
  readonly #now: Clock
  readonly #newID: IDGenerator

  constructor(accounts: AccountRepository, now: Clock, newID: IDGenerator) {
    this.#accounts = accounts
    this.#now = now
    this.#newID = newID
  }

  list(): Promise<Account[]> {
    return this.#accounts.list()
  }

  async create(name: string, kind: AccountKind, balance: Money): Promise<Account> {
    const a = Account.create(this.#newID(), name, kind, balance, this.#now())
    await this.#accounts.create(a)
    return a
  }

  /**
   * 名称と残高を更新する。
   *
   * 残高を触ったときだけ更新日時を進める。名称を直しただけで「残高は最新」と
   * 見なすと、isStale による催促が効かなくなるため。
   */
  async update(id: string, input: UpdateAccountInput): Promise<Account> {
    const a = await this.#accounts.get(id)
    if (input.name !== undefined) a.rename(input.name)
    if (input.balance !== undefined) a.updateBalance(input.balance, this.#now())
    await this.#accounts.update(a)
    return a
  }

  /** 取引履歴が残っている場合は ACCOUNT_IN_USE のドメインエラーになる。 */
  async delete(id: string): Promise<void> {
    await this.#accounts.get(id)
    await this.#accounts.delete(id)
  }
}
