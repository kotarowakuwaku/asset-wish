import { useCallback, useState } from 'react'
import { errorMessage, type ApiClient } from '../api/client'
import { useAsync } from '../app/useAsync'
import {
  Badge,
  Empty,
  ErrorMessage,
  FormError,
  Loading,
  Money,
  Section,
} from '../components/common'
import {
  formatMonthlySaving,
  formatMonths,
  formatShortfall,
  wishCategoryLabel,
  wishStatusLabel,
} from '../lib/format'

/**
 * Dashboard は実質資産と、ウィッシュごとの不足額・到達見込みを並べる。
 *
 * **表示する値はすべてサーバーが算出済み。** 実質資産も不足額も
 * 到達見込みも、ここでは一切計算しない（CLAUDE.md 不変条件8）。
 * front で足し引きを書くと、同じ式が2箇所に増えて必ずずれる。
 */
export function Dashboard({ client }: { client: ApiClient }) {
  const fetcher = useCallback(() => client.getDashboard(), [client])
  const { data, loading, error, reload } = useAsync(fetcher)

  if (loading && !data) return <Loading />
  if (error) return <ErrorMessage error={error} onRetry={reload} />
  if (!data) return null

  return (
    <>
      {/* **口座の残高を3つの時点で並べる。**

          「今ある額」を主役にしているのは、確定した支出を引いた額だけを
          出していると「結局いまいくら持っているのか」が読めないため。
          引き算をやめるのではなく、引く前と引いた後の両方を出す。

          貸し借りと投資はどの時点にも足さないので、この dl には入れない。 */}
      <section className="section net-asset">
        <h2>今ある額</h2>
        <p className="net-asset-value">
          <Money amount={data.breakdown.cashTotal} />
        </p>
        <dl className="breakdown">
          <div>
            <dt>支払い後に残る額</dt>
            <dd>
              <Money amount={data.netAsset} />
            </dd>
          </div>
          <div>
            <dt>確定した支出</dt>
            <dd>
              −<Money amount={data.breakdown.commitments} />
            </dd>
          </div>
          {/* 定期入出金を反映した翌月1日の見込み。確定した支出は含めない
              （いつ払うかが決まっていないため）。 */}
          <div>
            <dt>来月初めの見込み</dt>
            <dd>
              <Money amount={data.projectedBalance} />
            </dd>
          </div>
        </dl>
      </section>

      {/* 未適用の定期入出金。**背景で勝手に適用しない。** 何が起きたかが
          常に見えるようにするため、押したときだけ残高が動く
          （docs/decisions.md 2.5）。0件のときは何も出さない。 */}
      {data.pendingRecurringCount > 0 && (
        <Section title="未適用の定期入出金">
          <ApplyRecurring
            client={client}
            count={data.pendingRecurringCount}
            total={data.pendingRecurringTotal}
            onApplied={reload}
          />
        </Section>
      )}

      {/* 実質資産には足さない参考値（不変条件4）。立て替えた時点で現金が
          出たとは限らないため（カード払いなら引き落としはまだ）、
          「返ってくる／返す予定の額」として横に置くだけにしている。

          貸しと借りを引き算して1つにしない。差額だけだと、誰にいくら
          貸しているのかが消える。サーバーも分けて返している。 */}
      <Section title="未精算の貸し借り">
        {data.outstandingLent > 0 || data.outstandingBorrowed > 0 ? (
          <dl className="breakdown">
            <div>
              <dt>貸している</dt>
              <dd>
                <Money amount={data.outstandingLent} />
              </dd>
            </div>
            <div>
              <dt>借りている</dt>
              <dd>
                <Money amount={data.outstandingBorrowed} />
              </dd>
            </div>
          </dl>
        ) : (
          <Empty>未精算の貸し借りはありません。</Empty>
        )}
      </Section>

      <Section title="平均月間余剰">
        {data.hasAverageSurplus ? (
          <p className="reference-value">
            <Money amount={data.averageSurplus} />
          </p>
        ) : (
          // hasAverageSurplus が false のとき averageSurplus には 0 が
          // 入っているが、表示してはいけない（docs/architecture.md 7章）。
          <Empty>月次収支がまだ登録されていません。</Empty>
        )}
      </Section>

      <Section title="ウィッシュ">
        {data.wishes.length === 0 ? (
          <Empty>登録されているウィッシュはありません。</Empty>
        ) : (
          <ul className="card-list">
            {data.wishes.map((wish) => (
              <li key={wish.id} className="card">
                <div className="card-head">
                  <strong>{wish.title}</strong>
                  <Badge
                    tone={wish.status === 'committed' ? 'warn' : 'neutral'}
                  >
                    {wishStatusLabel(wish.status)}
                  </Badge>
                </div>
                <div className="card-body">
                  <span className="muted">
                    {wishCategoryLabel(wish.category)}
                  </span>
                  <Money amount={wish.amount} />
                </div>
                <div className="card-foot">
                  <span>{formatShortfall(wish.shortfall)}</span>
                  <span className="muted">
                    {formatMonths(wish.monthsToReach)}
                  </span>
                </div>
                {/* 期限があるものだけ。平均月間余剰に依存しないので、
                    月次収支が未登録でも出る。 */}
                {wish.monthlySavingNeeded !== null && (
                  <div className="card-foot">
                    <span className="muted">期限までに</span>
                    <span>{formatMonthlySaving(wish.monthlySavingNeeded)}</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  )
}

/**
 * ApplyRecurring は未適用の定期入出金をまとめて適用する。
 *
 * **押したときだけ残高が動く。** 画面を開いただけでは何も起きない。
 * 2ヶ月開かなかった場合は2ヶ月分がまとめて入る。
 *
 * 件数も合計もサーバーが数えた値をそのまま出す。ここで数え直すと、
 * 表示していた件数と実際に動く件数がずれる余地ができる。
 */
function ApplyRecurring({
  client,
  count,
  total,
  onApplied,
}: {
  client: ApiClient
  count: number
  total: number
  onApplied: () => void
}) {
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const apply = async () => {
    setBusy(true)
    try {
      await client.applyRecurringEntries()
      setMessage(null)
      onApplied()
    } catch (e) {
      setMessage(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <p>
        {count}件（合計 <Money amount={total} />）が未適用です。
      </p>
      <FormError message={message} />
      <button type="button" onClick={apply} disabled={busy}>
        適用する
      </button>
    </>
  )
}
