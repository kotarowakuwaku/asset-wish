import { useCallback, useState } from 'react'
import { errorMessage, type ApiClient } from '../api/client'
import type { RecurringEntry } from '../api/types'
import { useAsync } from '../app/useAsync'
import { useSubmit } from '../app/useSubmit'
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
import { parseAmount } from '../lib/format'
import { AccountSelect } from '../components/AccountSelect'

/** 入金か出金か。画面の中だけの区別で、サーバーへは金額の符号として送る。 */
type Direction = 'out' | 'in'

/**
 * Recurring は定期入出金（給料・家賃）の一覧と、登録・削除を行う。
 *
 * **ここでは適用しない。** 未適用の件数はダッシュボードに出て、適用も
 * そこから行う。適用は残高を動かす操作なので、入り口を1箇所に絞っている
 *（docs/decisions.md 2.5）。
 *
 * 登録しただけでは口座残高は動かない。
 */
export function Recurring({ client }: { client: ApiClient }) {
  const fetcher = useCallback(() => client.listRecurringEntries(), [client])
  const { data, loading, error, reload } = useAsync(fetcher)

  const fetchAccounts = useCallback(() => client.listAccounts(), [client])
  const accounts = useAsync(fetchAccounts)
  const accountNames = new Map((accounts.data ?? []).map((a) => [a.id, a.name] as const))

  const entries = data ?? []

  return (
    <>
      <Section title="定期">
        <p className="muted">
          毎月決まった日に口座を増減させます。適用はダッシュボードから行います。
        </p>

        {loading && !data && <Loading />}
        {error && <ErrorMessage error={error} onRetry={reload} />}
        {!error && !loading && entries.length === 0 && (
          <Empty>定期入出金がまだありません。</Empty>
        )}
        {entries.length > 0 && (
          <ul className="card-list">
            {entries.map((entry) => (
              <RecurringItem
                key={entry.id}
                client={client}
                entry={entry}
                accountName={accountNames.get(entry.accountId)}
                onDeleted={reload}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section title="定期を登録">
        <NewRecurringForm client={client} onCreated={reload} />
      </Section>
    </>
  )
}

function RecurringItem({
  client,
  entry,
  accountName,
  onDeleted,
}: {
  client: ApiClient
  entry: RecurringEntry
  accountName: string | undefined
  onDeleted: () => void
}) {
  return (
    <li className="card">
      <div className="card-head">
        <strong>{entry.name}</strong>
        <Badge tone={entry.amount < 0 ? 'neutral' : 'good'}>毎月{entry.dayOfMonth}日</Badge>
      </div>

      <div className="card-body">
        <span className="muted">{accountName ?? ''}</span>
        {/* 符号がそのまま向きを表す。入金・出金のラベルは置かない。 */}
        <Money amount={entry.amount} className="amount" />
      </div>

      <div className="card-foot">
        <span className="muted">{entry.appliedThrough} まで適用済み</span>
        <DeleteRecurringButton client={client} entry={entry} onDeleted={onDeleted} />
      </div>
    </li>
  )
}

/**
 * DeleteRecurringButton は定期入出金を消す。
 *
 * **適用済みの履歴は消えない。** 残高を戻すこともしない。すでに起きた
 * 入出金は事実なので、取り消すなら打ち消しの明細を打つ。名称は履歴側に
 * 写してあるので、消したあとも何だったかは読める。
 */
function DeleteRecurringButton({
  client,
  entry,
  onDeleted,
}: {
  client: ApiClient
  entry: RecurringEntry
  onDeleted: () => void
}) {
  const { busy, message, submit } = useSubmit(() => client.deleteRecurringEntry(entry.id), onDeleted)

  return (
    <>
      <button type="button" onClick={submit} disabled={busy}>
        削除
      </button>
      <FormError message={message} />
    </>
  )
}

function NewRecurringForm({
  client,
  onCreated,
}: {
  client: ApiClient
  onCreated: () => void
}) {
  // 出金を既定にする。件数が多いのはこちら。
  const [direction, setDirection] = useState<Direction>('out')
  const [name, setName] = useState('')
  const [accountId, setAccountId] = useState('')
  const [amount, setAmount] = useState('')
  const [dayOfMonth, setDayOfMonth] = useState('25')
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()

    const parsed = parseAmount(amount)
    if (parsed === null || parsed === 0) {
      setMessage('金額は1以上の整数で入力してください')
      return
    }
    const day = parseAmount(dayOfMonth)
    if (day === null || day < 1 || day > 31) {
      setMessage('適用日は1〜31で入力してください')
      return
    }
    if (accountId === '') {
      setMessage('口座を選んでください')
      return
    }

    setBusy(true)
    try {
      await client.createRecurringEntry({
        name,
        accountId,
        // 入力欄は常に正の数で受け、ここで符号に直す。入出金の明細と同じ約束。
        amount: direction === 'out' ? -parsed : parsed,
        dayOfMonth: day,
      })
      setName('')
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
      <Field label="どちら">
        <select value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
          <option value="out">出金（家賃など）</option>
          <option value="in">入金（給料など）</option>
        </select>
      </Field>

      <Field label="名称">
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} required />
      </Field>

      <Field label="口座">
        <AccountSelect client={client} value={accountId} onChange={setAccountId} />
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

      {/* 月末の無い月に31を指定した場合は、サーバーがその月の末日に丸める。 */}
      <Field label="適用日">
        <input
          type="text"
          inputMode="numeric"
          value={dayOfMonth}
          onChange={(e) => setDayOfMonth(e.target.value)}
          required
        />
      </Field>

      <p className="muted">
        登録しただけでは残高は動きません。適用はダッシュボードから行います。
      </p>

      <FormError message={message} />

      <button type="submit" disabled={busy}>
        登録する
      </button>
    </form>
  )
}
