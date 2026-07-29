import type { Transaction } from '../domain/transaction'
import type { TransactionRepository } from './port'

/**
 * 取引履歴の既定の取得件数。
 *
 * 履歴は「残高が動いた理由を後から辿る」ためのもので、古いものまで一度に
 * 見る場面が無い。データ規模は年間数百件なので、上限を設けても実用上は困らない。
 */
export const DEFAULT_TRANSACTION_LIMIT = 100

export class TransactionUsecase {
  readonly #transactions: TransactionRepository

  constructor(transactions: TransactionRepository) {
    this.#transactions = transactions
  }

  /** 発生日の降順で返す。limit が 0 以下なら既定の件数を使う。 */
  list(limit: number): Promise<Transaction[]> {
    return this.#transactions.list(limit <= 0 ? DEFAULT_TRANSACTION_LIMIT : limit)
  }
}
