import { useCallback, useState } from 'react'
import { errorMessage, type ApiClient } from '../api/client'
import type { Loan, LoanDirection } from '../api/types'
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
import {
  formatDate,
  loanDirectionLabel,
  parseAmount,
  settlementStatusLabel,
  todayISO,
} from '../lib/format'

/**
 * Loans は貸し借りの一覧と、登録・精算・削除を行う。
 *
 * 未精算残高・精算状態はサーバーが導出した値をそのまま出す。
 * DB は精算額しか持たない（不変条件12）。
 *
 * **口座を選ばせない。** 貸し借りは口座残高を動かさないため（不変条件4）。
 * 未精算額はダッシュボードで参考値として出る。
 */
export function Loans({ client }: { client: ApiClient }) {
  const [outstandingOnly, setOutstandingOnly] = useState(true)

  const fetcher = useCallback(
    () => client.listLoans(outstandingOnly),
    [client, outstandingOnly],
  )
  const { data, loading, error, reload } = useAsync(fetcher)

  const loans = data ?? []

  return (
    <>
      <Section
        title="貸し借り"
        actions={
          <div className="tabs" role="group" aria-label="表示の絞り込み">
            <button
              type="button"
              aria-pressed={outstandingOnly}
              onClick={() => setOutstandingOnly(true)}
            >
              未精算
            </button>
            <button
              type="button"
              aria-pressed={!outstandingOnly}
              onClick={() => setOutstandingOnly(false)}
            >
              すべて
            </button>
          </div>
        }
      >
        {loading && !data && <Loading />}
        {error && <ErrorMessage error={error} onRetry={reload} />}
        {!error && loans.length === 0 && !loading && (
          <Empty>
            {outstandingOnly
              ? '未精算の貸し借りはありません。'
              : '貸し借りがまだありません。'}
          </Empty>
        )}
        {loans.length > 0 && (
          <ul className="card-list">
            {loans.map((loan) => (
              <LoanItem
                key={loan.id}
                client={client}
                loan={loan}
                onChanged={reload}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section title="貸し借りを登録">
        <NewLoanForm client={client} onCreated={reload} />
      </Section>
    </>
  )
}

function LoanItem({
  client,
  loan,
  onChanged,
}: {
  client: ApiClient
  loan: Loan
  onChanged: () => void
}) {
  const [settling, setSettling] = useState(false)

  return (
    <li className="card">
      <div className="card-head">
        <strong>{loan.counterparty}</strong>
        <span className="actions">
          {/* 向きは金額の符号では表れないので、必ずラベルで示す。
              これが無いと、貸したのか借りたのかが画面から読めない。 */}
          <Badge tone={loan.direction === 'lent' ? 'neutral' : 'warn'}>
            {loanDirectionLabel(loan.direction)}
          </Badge>
          <Badge tone={loan.status === 'settled' ? 'good' : 'warn'}>
            {settlementStatusLabel(loan.status)}
          </Badge>
        </span>
      </div>

      <div className="card-body">
        <span className="muted">{loan.description || '（内容なし）'}</span>
        <span>
          <Money amount={loan.amount} className="amount" />
          <span className="muted">
            {' '}
            / 未精算 <Money amount={loan.outstanding} />
          </span>
        </span>
      </div>

      <div className="card-foot">
        <span className="muted">{formatDate(loan.occurredOn)}</span>
        <span className="actions">
          {loan.outstanding > 0 && (
            <button type="button" onClick={() => setSettling((v) => !v)}>
              {settling ? '精算をやめる' : '精算を記録'}
            </button>
          )}
          <DeleteLoanButton
            client={client}
            loan={loan}
            onDeleted={onChanged}
          />
        </span>
      </div>

      {settling && (
        <SettleForm
          client={client}
          loan={loan}
          onSettled={() => {
            setSettling(false)
            onChanged()
          }}
        />
      )}
    </li>
  )
}

function DeleteLoanButton({
  client,
  loan,
  onDeleted,
}: {
  client: ApiClient
  loan: Loan
  onDeleted: () => void
}) {
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const remove = async () => {
    setBusy(true)
    try {
      await client.deleteLoan(loan.id)
      onDeleted()
    } catch (e) {
      setMessage(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button type="button" onClick={remove} disabled={busy}>
        削除
      </button>
      <FormError message={message} />
    </>
  )
}

/**
 * SettleForm は精算を記録する。
 *
 * 未精算残高を超える額はサーバーが 422 で弾く（不変条件4）。
 * front でも入力段階で気付けるよう未精算残高を示すが、**判定はサーバーが持つ**。
 * ここに同じ判定を書くと、ルールが2箇所に増える。
 */
function SettleForm({
  client,
  loan,
  onSettled,
}: {
  client: ApiClient
  loan: Loan
  onSettled: () => void
}) {
  const [amount, setAmount] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()

    const parsed = parseAmount(amount)
    if (parsed === null || parsed === 0) {
      setMessage('精算額は1以上の整数で入力してください')
      return
    }

    setBusy(true)
    try {
      await client.settleLoan(loan.id, { amount: parsed })
      setMessage(null)
      onSettled()
    } catch (e) {
      setMessage(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="form inline-form">
      <Field label="精算額">
        <input
          type="text"
          inputMode="numeric"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          required
        />
      </Field>
      <p className="muted">
        未精算残高は <Money amount={loan.outstanding} /> です。
      </p>

      {/* 入金先の口座も精算日も聞かない。貸し借りは口座残高を動かさず、
          取引履歴も残さない（不変条件4）。日付を聞いても残す先が無い。 */}

      <FormError message={message} />

      <button type="submit" disabled={busy}>
        精算を記録する
      </button>
    </form>
  )
}

function NewLoanForm({
  client,
  onCreated,
}: {
  client: ApiClient
  onCreated: () => void
}) {
  // 貸した側を既定にする。立て替えのほうが件数が多い。
  const [direction, setDirection] = useState<LoanDirection>('lent')
  const [counterparty, setCounterparty] = useState('')
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [occurredOn, setOccurredOn] = useState(todayISO())
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()

    const parsed = parseAmount(amount)
    if (parsed === null || parsed === 0) {
      setMessage('金額は1以上の整数で入力してください')
      return
    }

    setBusy(true)
    try {
      await client.createLoan({
        direction,
        counterparty,
        description,
        // 借りた場合も正の値で送る。符号で向きを表さない。
        amount: parsed,
        occurredOn,
      })
      setCounterparty('')
      setDescription('')
      setAmount('')
      setMessage(null)
      onCreated()
    } catch (e) {
      setMessage(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="form">
      {/* 向きは select で選ばせる。金額の符号に混ぜると、
          「−5000 と入れたら借りたことになる」という当てにくい仕様になる。 */}
      <Field label="どちら">
        <select
          value={direction}
          onChange={(e) => setDirection(e.target.value as LoanDirection)}
        >
          <option value="lent">貸した（立て替えた）</option>
          <option value="borrowed">借りた</option>
        </select>
      </Field>

      <Field label="相手">
        <input
          type="text"
          value={counterparty}
          onChange={(e) => setCounterparty(e.target.value)}
          required
        />
      </Field>

      <Field label="内容">
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>

      <Field label="金額">
        <input
          type="text"
          inputMode="numeric"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          required
        />
      </Field>

      {/* 支払い元の口座は聞かない。立て替えた時点で現金が出たとは限らない
          （カード払いなら引き落としはまだ）。未精算額はダッシュボードの
          参考値として出るだけで、口座残高は動かさない（不変条件4）。 */}

      <Field label="日付">
        <input
          type="date"
          value={occurredOn}
          onChange={(e) => setOccurredOn(e.target.value)}
          required
        />
      </Field>

      <FormError message={message} />

      <button type="submit" disabled={busy}>
        登録する
      </button>
    </form>
  )
}
