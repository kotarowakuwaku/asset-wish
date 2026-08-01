import { useCallback } from 'react'
import type { ApiClient } from '../api/client'
import { useAsync } from '../app/useAsync'
import { Badge, Empty, ErrorMessage, Loading, Money, Section } from '../components/common'
import { formatSurplus } from '../lib/format'

/**
 * MonthlySummaries は月ごとの収入・支出を並べる。
 *
 * **入力欄は無い。** 入出金の明細を打てば、その月の収支は自動で出る。
 * 手入力の経路を残すと、同じ数字を明細と月次の2箇所に入れることになり、
 * どちらが正なのかが決まらない（docs/spec-changes.md 4）。
 *
 * ライブや旅行のような個別の支出はウィッシュ側に登録する。**同じ支出を
 * 両方に入れない**（不変条件2）。ウィッシュの支払いはここには足されない。
 *
 * 計算はしない。収入・支出・余剰はサーバーが算出済みの値を並べるだけ
 * （不変条件8）。
 */
export function MonthlySummaries({ client }: { client: ApiClient }) {
  const fetcher = useCallback(() => client.listMonthlySummaries(), [client])
  const { data, loading, error, reload } = useAsync(fetcher)

  const summaries = data ?? []

  return (
    <Section title="月次収支">
      <p className="muted">
        入出金の明細を月ごとに足し上げた結果です。直接の入力はできません。
      </p>

      {loading && !data && <Loading />}
      {error && <ErrorMessage error={error} onRetry={reload} />}
      {!error && !loading && summaries.length === 0 && (
        <Empty>入出金の明細がまだありません。</Empty>
      )}
      {summaries.length > 0 && (
        <ul className="card-list">
          {summaries.map((s) => (
            <li key={s.yearMonth} className="card">
              <div className="card-head">
                <strong>{s.yearMonth}</strong>
                <span className="actions">
                  {/* 明細が1件も無い月は、廃止前に手入力した値で埋まる。
                      示さないと「明細を打ったのに反映されない」ように見える。 */}
                  {s.source === 'manual' && <Badge tone="neutral">手入力</Badge>}
                  {/* 符号で黒字・赤字が一目で分かること（要件 F-17）。 */}
                  <Badge tone={s.surplus >= 0 ? 'good' : 'bad'}>
                    {formatSurplus(s.surplus)}
                  </Badge>
                </span>
              </div>
              <div className="card-body">
                <span className="muted">
                  収入 <Money amount={s.income} />
                </span>
                <span className="muted">
                  支出 <Money amount={s.expense} />
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}
