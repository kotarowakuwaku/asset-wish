import { useCallback } from 'react'
import type { ApiClient } from '../api/client'
import { useAsync } from '../app/useAsync'
import {
  Badge,
  Empty,
  ErrorMessage,
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
      <section className="section net-asset">
        <h2>実質資産</h2>
        <p className="net-asset-value">
          <Money amount={data.netAsset} />
        </p>
        <dl className="breakdown">
          <div>
            <dt>現金・預金</dt>
            <dd>
              <Money amount={data.breakdown.cashTotal} />
            </dd>
          </div>
          <div>
            <dt>未回収の立替</dt>
            <dd>
              +<Money amount={data.breakdown.outstandingLendings} />
            </dd>
          </div>
          <div>
            <dt>確定した支出</dt>
            <dd>
              −<Money amount={data.breakdown.commitments} />
            </dd>
          </div>
        </dl>
      </section>

      <Section title="平均月間余剰">
        {data.hasAverageSurplus ? (
          <p className="reference-value">
            <Money amount={data.averageSurplus} />
          </p>
        ) : (
          // hasAverageSurplus が false のとき averageSurplus には 0 が
          // 入っているが、表示してはいけない（detailed-design 6.1）。
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
