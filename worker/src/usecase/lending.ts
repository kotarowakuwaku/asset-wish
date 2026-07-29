import { Lending } from '../domain/lending'
import { negateMoney, type Money } from '../domain/money'
import type { IsoDate } from '../domain/time'
import { Transaction } from '../domain/transaction'
import type {
  AccountRepository,
  AtomicWriter,
  Clock,
  IDGenerator,
  LendingRepository,
  WriteOperation,
} from './port'

export class LendingUsecase {
  readonly #writer: AtomicWriter
  readonly #lendings: LendingRepository
  readonly #accounts: AccountRepository
  readonly #now: Clock
  readonly #newID: IDGenerator

  constructor(
    writer: AtomicWriter,
    lendings: LendingRepository,
    accounts: AccountRepository,
    now: Clock,
    newID: IDGenerator,
  ) {
    this.#writer = writer
    this.#lendings = lendings
    this.#accounts = accounts
    this.#now = now
    this.#newID = newID
  }

  list(outstandingOnly: boolean): Promise<Lending[]> {
    return this.#lendings.list(outstandingOnly)
  }

  /**
   * 立替を登録し、口座残高を減らして履歴を残す。
   *
   * 立て替えた時点で自分の口座からは金が出ている。残高を減らさないと、
   * 未回収額と残高の両方に同じ金を数えることになる。
   */
  async create(
    counterparty: string,
    description: string,
    amount: Money,
    occurredOn: IsoDate,
    accountId: string,
  ): Promise<Lending> {
    const lending = Lending.create(this.#newID(), counterparty, description, amount, occurredOn)

    const account = await this.#accounts.get(accountId)
    // 読み取った時点の残高。これが書き込みまでに変わっていれば競合になる。
    const expectedBalance = account.balance
    account.applyDelta(negateMoney(amount), this.#now())

    const ops: WriteOperation[] = [
      { kind: 'createLending', lending },
      { kind: 'updateAccount', account, expectedBalance },
      {
        kind: 'createTransaction',
        transaction: Transaction.create(
          this.#newID(),
          accountId,
          negateMoney(amount),
          'lending_created',
          lending.id,
          occurredOn,
        ),
      },
    ]
    await this.#writer.writeAll(ops)
    return lending
  }

  /**
   * 回収を記録し、口座残高を戻して履歴を残す。
   *
   * 回収額と残高の両方について「読み取った時点から変わっていないこと」を条件に
   * 書き込む。取得と書き込みの間に別の回収が入ると、どちらも未回収残高の
   * 範囲内に見えて過回収が成立しうるため（不変条件4）。
   */
  async collect(
    lendingId: string,
    amount: Money,
    occurredOn: IsoDate,
    accountId: string,
  ): Promise<Lending> {
    const lending = await this.#lendings.get(lendingId)
    const expectedCollectedAmount = lending.collectedAmount
    // 回収してよいかの判定は domain が持つ。usecase は結果を書くだけ。
    lending.collect(amount)

    const account = await this.#accounts.get(accountId)
    const expectedBalance = account.balance
    account.applyDelta(amount, this.#now())

    const ops: WriteOperation[] = [
      { kind: 'updateLendingCollected', lending, expectedCollectedAmount },
      { kind: 'updateAccount', account, expectedBalance },
      {
        kind: 'createTransaction',
        transaction: Transaction.create(
          this.#newID(),
          accountId,
          amount,
          'lending_collected',
          lendingId,
          occurredOn,
        ),
      },
    ]
    await this.#writer.writeAll(ops)
    return lending
  }

  /** 立替を削除する。無ければ NotFoundError。 */
  async delete(id: string): Promise<void> {
    await this.#lendings.get(id)
    await this.#lendings.delete(id)
  }
}
