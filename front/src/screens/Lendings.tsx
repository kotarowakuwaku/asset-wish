import { useCallback, useState } from 'react'
import { errorMessage, type ApiClient } from '../api/client'
import type { Lending } from '../api/types'
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
  collectionStatusLabel,
  formatDate,
  parseAmount,
  todayISO,
} from '../lib/format'

/**
 * Lendings は立替の一覧と、登録・回収・削除を行う。
 *
 * 未回収残高・回収状態はサーバーが導出した値をそのまま出す。
 * DB は回収額しか持たない（不変条件12）。
 *
 * **口座を選ばせない。** 立替は口座残高を動かさないため（不変条件4）。
 * 未回収額はダッシュボードで参考値として出る。
 */
export function Lendings({ client }: { client: ApiClient }) {
  const [outstandingOnly, setOutstandingOnly] = useState(true)

  const fetcher = useCallback(
    () => client.listLendings(outstandingOnly),
    [client, outstandingOnly],
  )
  const { data, loading, error, reload } = useAsync(fetcher)

  const lendings = data ?? []

  return (
    <>
      <Section
        title="立替"
        actions={
          <div className="tabs" role="group" aria-label="表示の絞り込み">
            <button
              type="button"
              aria-pressed={outstandingOnly}
              onClick={() => setOutstandingOnly(true)}
            >
              未回収
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
        {!error && lendings.length === 0 && !loading && (
          <Empty>
            {outstandingOnly
              ? '未回収の立替はありません。'
              : '立替がまだありません。'}
          </Empty>
        )}
        {lendings.length > 0 && (
          <ul className="card-list">
            {lendings.map((lending) => (
              <LendingItem
                key={lending.id}
                client={client}
                lending={lending}
                onChanged={reload}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section title="立替を登録">
        <NewLendingForm client={client} onCreated={reload} />
      </Section>
    </>
  )
}

function LendingItem({
  client,
  lending,
  onChanged,
}: {
  client: ApiClient
  lending: Lending
  onChanged: () => void
}) {
  const [collecting, setCollecting] = useState(false)

  return (
    <li className="card">
      <div className="card-head">
        <strong>{lending.counterparty}</strong>
        <Badge tone={lending.status === 'collected' ? 'good' : 'warn'}>
          {collectionStatusLabel(lending.status)}
        </Badge>
      </div>

      <div className="card-body">
        <span className="muted">{lending.description || '（内容なし）'}</span>
        <span>
          <Money amount={lending.amount} className="amount" />
          <span className="muted">
            {' '}
            / 未回収 <Money amount={lending.outstanding} />
          </span>
        </span>
      </div>

      <div className="card-foot">
        <span className="muted">{formatDate(lending.occurredOn)}</span>
        <span className="actions">
          {lending.outstanding > 0 && (
            <button type="button" onClick={() => setCollecting((v) => !v)}>
              {collecting ? '回収をやめる' : '回収を記録'}
            </button>
          )}
          <DeleteLendingButton
            client={client}
            lending={lending}
            onDeleted={onChanged}
          />
        </span>
      </div>

      {collecting && (
        <CollectForm
          client={client}
          lending={lending}
          onCollected={() => {
            setCollecting(false)
            onChanged()
          }}
        />
      )}
    </li>
  )
}

function DeleteLendingButton({
  client,
  lending,
  onDeleted,
}: {
  client: ApiClient
  lending: Lending
  onDeleted: () => void
}) {
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const remove = async () => {
    setBusy(true)
    try {
      await client.deleteLending(lending.id)
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
 * CollectForm は回収を記録する。
 *
 * 未回収残高を超える額はサーバーが 422 で弾く（不変条件4）。
 * front でも入力段階で気付けるよう未回収残高を示すが、**判定はサーバーが持つ**。
 * ここに同じ判定を書くと、ルールが2箇所に増える。
 */
function CollectForm({
  client,
  lending,
  onCollected,
}: {
  client: ApiClient
  lending: Lending
  onCollected: () => void
}) {
  const [amount, setAmount] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()

    const parsed = parseAmount(amount)
    if (parsed === null || parsed === 0) {
      setMessage('回収額は1以上の整数で入力してください')
      return
    }

    setBusy(true)
    try {
      await client.collectLending(lending.id, { amount: parsed })
      setMessage(null)
      onCollected()
    } catch (e) {
      setMessage(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="form inline-form">
      <Field label="回収額">
        <input
          type="text"
          inputMode="numeric"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          required
        />
      </Field>
      <p className="muted">
        未回収残高は <Money amount={lending.outstanding} /> です。
      </p>

      {/* 入金先の口座も回収日も聞かない。立替は口座残高を動かさず、
          取引履歴も残さない（不変条件4）。日付を聞いても残す先が無い。 */}

      <FormError message={message} />

      <button type="submit" disabled={busy}>
        回収を記録する
      </button>
    </form>
  )
}

function NewLendingForm({
  client,
  onCreated,
}: {
  client: ApiClient
  onCreated: () => void
}) {
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
      setMessage('立替額は1以上の整数で入力してください')
      return
    }

    setBusy(true)
    try {
      await client.createLending({
        counterparty,
        description,
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

      <Field label="立替額">
        <input
          type="text"
          inputMode="numeric"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          required
        />
      </Field>

      {/* 支払い元の口座は聞かない。立て替えた時点で現金が出たとは限らない
          （カード払いなら引き落としはまだ）。未回収額はダッシュボードの
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
