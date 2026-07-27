import { useCallback, useState } from 'react'
import { errorMessage, type ApiClient } from '../api/client'
import { useAsync } from '../app/useAsync'
import {
  Badge,
  Empty,
  ErrorMessage,
  Field,
  FormError,
  Loading,
  Money,
  Section,
} from '../components/common'
import { currentYearMonth, formatSurplus, parseAmount } from '../lib/format'

/**
 * MonthlyBalances は月ごとの収入・支出を登録し、黒字・赤字を並べる。
 *
 * ここに入れるのは生活費などの月次の収支。ライブや旅行のような
 * 個別の支出はウィッシュ側に登録する。**同じ支出を両方に入れない**
 * （不変条件2）。二重に数えると実質資産が実際より低く出る。
 */
export function MonthlyBalances({ client }: { client: ApiClient }) {
  const fetcher = useCallback(() => client.listMonthlyBalances(), [client])
  const { data, loading, error, reload } = useAsync(fetcher)

  const balances = data ?? []

  return (
    <>
      <Section title="月次収支">
        {loading && !data && <Loading />}
        {error && <ErrorMessage error={error} onRetry={reload} />}
        {!error && !loading && balances.length === 0 && (
          <Empty>月次収支がまだ登録されていません。</Empty>
        )}
        {balances.length > 0 && (
          <ul className="card-list">
            {balances.map((balance) => (
              <li key={balance.id} className="card">
                <div className="card-head">
                  <strong>{balance.yearMonth}</strong>
                  {/* 符号で黒字・赤字が一目で分かること（要件 F-17）。 */}
                  <Badge tone={balance.surplus >= 0 ? 'good' : 'bad'}>
                    {formatSurplus(balance.surplus)}
                  </Badge>
                </div>
                <div className="card-body">
                  <span className="muted">
                    収入 <Money amount={balance.income} />
                  </span>
                  <span className="muted">
                    支出 <Money amount={balance.expense} />
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="月次収支を登録">
        <UpsertForm client={client} onSaved={reload} />
      </Section>
    </>
  )
}

/**
 * UpsertForm は月次収支を登録・更新する。
 * 同じ月を再送信すると上書きになる（冪等）。
 */
function UpsertForm({
  client,
  onSaved,
}: {
  client: ApiClient
  onSaved: () => void
}) {
  const [yearMonth, setYearMonth] = useState(currentYearMonth())
  const [income, setIncome] = useState('')
  const [expense, setExpense] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()

    const parsedIncome = parseAmount(income)
    const parsedExpense = parseAmount(expense)
    if (parsedIncome === null || parsedExpense === null) {
      setMessage('収入・支出は0以上の整数で入力してください')
      return
    }

    setBusy(true)
    try {
      await client.upsertMonthlyBalance(yearMonth, {
        income: parsedIncome,
        expense: parsedExpense,
      })
      setIncome('')
      setExpense('')
      setMessage(null)
      onSaved()
    } catch (e) {
      setMessage(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="form">
      <Field label="年月">
        {/* month 入力は YYYY-MM を返す。サーバーの経路の形式と一致する。 */}
        <input
          type="month"
          value={yearMonth}
          onChange={(e) => setYearMonth(e.target.value)}
          required
        />
      </Field>

      <Field label="収入">
        <input
          type="text"
          inputMode="numeric"
          value={income}
          onChange={(e) => setIncome(e.target.value)}
          required
        />
      </Field>

      <Field label="支出">
        <input
          type="text"
          inputMode="numeric"
          value={expense}
          onChange={(e) => setExpense(e.target.value)}
          required
        />
      </Field>

      <p className="muted">
        同じ月をもう一度登録すると上書きになります。ライブや旅行のような
        個別の支出はウィッシュ側に登録してください（二重に数えないため）。
      </p>

      <FormError message={message} />

      <button type="submit" disabled={busy}>
        保存する
      </button>
    </form>
  )
}
