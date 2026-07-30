// サーバーのレスポンスに対応する型。
//
// server/internal/adapter/handler/dto.go と一対一で対応させる。
// 片方だけ変えると、型は通るのに実行時に undefined を触ることになるため、
// あちらを変えたらここも直す。
//
// 金額はすべて円単位の整数。文字列にはしない（detailed-design 6）。

export type AccountKind = 'cash' | 'investment'

export type Account = {
  id: string
  name: string
  kind: AccountKind
  balance: number
  updatedAt: string
  /** 残高の更新が滞っているか。サーバー側で判定した導出値。 */
  isStale: boolean
}

export type SettlementStatus = 'unsettled' | 'partial' | 'settled'

/** 貸した / 借りた。金額は向きによらず正で、向きはこれだけが表す。 */
export type LoanDirection = 'lent' | 'borrowed'

export type Loan = {
  id: string
  direction: LoanDirection
  counterparty: string
  description: string
  /** 向きによらず正の値。負の金額で「借りた」を表さない。 */
  amount: number
  settledAmount: number
  /** 未精算残高。amount - settledAmount の導出値。 */
  outstanding: number
  status: SettlementStatus
  /** YYYY-MM-DD */
  occurredOn: string
}

export type WishCategory = 'item' | 'experience' | 'goal'
export type WishStatus = 'considering' | 'committed' | 'done' | 'dropped'

export type Wish = {
  id: string
  title: string
  amount: number
  category: WishCategory
  status: WishStatus
  priority: number
  /** YYYY-MM-DD。未設定なら null。 */
  deadline: string | null
}

export type MonthlyBalance = {
  id: string
  /** YYYY-MM */
  yearMonth: string
  income: number
  expense: number
  /** 月間余剰。income - expense の導出値。負値なら赤字。 */
  surplus: number
}

export type TransactionKind =
  | 'lending_created'
  | 'lending_collected'
  | 'wish_paid'
  | 'adjustment'

export type Transaction = {
  id: string
  accountId: string
  /** 符号付き。口座から出るときは負。 */
  amount: number
  kind: TransactionKind
  refId: string | null
  occurredOn: string
}

export type DashboardWish = Wish & {
  /** 不足額。負値ならすでに手が届く。 */
  shortfall: number
  /** 到達見込みの月数。算出不可なら null。0 と混同しないこと。 */
  monthsToReach: number | null
  /** 期限までに毎月いくら貯めればよいか。期限が無い・過ぎている・到達済みなら null。 */
  monthlySavingNeeded: number | null
}

export type Dashboard = {
  netAsset: number
  /** 実質資産を構成する項目だけ。参考値は下に別で並ぶ。 */
  breakdown: {
    cashTotal: number
    commitments: number
  }
  /** 投資は実質資産に含めない別枠の参考値。 */
  investmentTotal: number
  /**
   * 未精算の貸し借り。**これも実質資産には含めない別枠の参考値。**
   * 立て替えた時点で現金が出たとは限らないため（カード払い）。
   *
   * 貸しと借りは分かれて届く。差額に丸めると、誰にいくら貸しているのかが
   * 消えるため。どちらも正の値。
   */
  outstandingLent: number
  outstandingBorrowed: number
  averageSurplus: number
  /** false のとき averageSurplus は 0 が入るが、表示してはいけない。 */
  hasAverageSurplus: boolean
  wishes: DashboardWish[]
}
