import { useCallback, useState } from 'react'
import { errorMessage, type ApiClient } from '../api/client'
import type { Account, AccountKind } from '../api/types'
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
import { accountKindLabel, formatDate, parseAmount } from '../lib/format'

/**
 * Accounts は口座と残高を並べ、登録・残高更新・削除を行う。
 *
 * **口座種別は登録時にしか決められない。** 種別が変わると、その口座が
 * 実質資産の計算から丸ごと外れる（不変条件1）。サーバーも PATCH で
 * kind を受け付けないので、画面にも変更の導線を置かない。
 */
export function Accounts({ client }: { client: ApiClient }) {
  const fetcher = useCallback(() => client.listAccounts(), [client])
  const { data, loading, error, reload } = useAsync(fetcher)

  if (loading && !data) return <Loading />
  if (error) return <ErrorMessage error={error} onRetry={reload} />

  const accounts = data ?? []

  return (
    <>
      <Section title="口座">
        {accounts.length === 0 ? (
          <Empty>口座がまだありません。</Empty>
        ) : (
          <ul className="card-list">
            {accounts.map((account) => (
              <AccountItem
                key={account.id}
                client={client}
                account={account}
                onChanged={reload}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section title="口座を追加">
        <NewAccountForm client={client} onCreated={reload} />
      </Section>
    </>
  )
}

function AccountItem({
  client,
  account,
  onChanged,
}: {
  client: ApiClient
  account: Account
  onChanged: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [balance, setBalance] = useState(String(account.balance))
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async () => {
    const parsed = parseAmount(balance)
    if (parsed === null) {
      setMessage('残高は0以上の整数で入力してください')
      return
    }

    setBusy(true)
    try {
      await client.updateAccount(account.id, { balance: parsed })
      setMessage(null)
      setEditing(false)
      onChanged()
    } catch (e) {
      setMessage(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    try {
      await client.deleteAccount(account.id)
      onChanged()
    } catch (e) {
      // 取引履歴が残っている口座は消せない（422）。
      // 残高の裏付けが取れなくなるため。
      setMessage(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="card">
      <div className="card-head">
        <strong>{account.name}</strong>
        <Badge tone={account.kind === 'investment' ? 'neutral' : 'good'}>
          {accountKindLabel(account.kind)}
        </Badge>
      </div>

      <div className="card-body">
        {editing ? (
          <Field label="残高">
            <input
              type="text"
              inputMode="numeric"
              value={balance}
              onChange={(e) => setBalance(e.target.value)}
              aria-label={`${account.name} の残高`}
            />
          </Field>
        ) : (
          <Money amount={account.balance} className="amount" />
        )}
        {account.isStale && <Badge tone="warn">残高が古い</Badge>}
      </div>

      <div className="card-foot">
        <span className="muted">更新 {formatDate(account.updatedAt.slice(0, 10))}</span>
        <span className="actions">
          {editing ? (
            <>
              <button type="button" onClick={save} disabled={busy}>
                保存
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditing(false)
                  setBalance(String(account.balance))
                  setMessage(null)
                }}
                disabled={busy}
              >
                取消
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => setEditing(true)}>
                残高を更新
              </button>
              <button type="button" onClick={remove} disabled={busy}>
                削除
              </button>
            </>
          )}
        </span>
      </div>

      <FormError message={message} />
    </li>
  )
}

function NewAccountForm({
  client,
  onCreated,
}: {
  client: ApiClient
  onCreated: () => void
}) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState<AccountKind>('cash')
  const [balance, setBalance] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()

    const parsed = parseAmount(balance)
    if (parsed === null) {
      setMessage('残高は0以上の整数で入力してください')
      return
    }

    setBusy(true)
    try {
      await client.createAccount({ name, kind, balance: parsed })
      setName('')
      setBalance('')
      setKind('cash')
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
      <Field label="名称">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </Field>

      <Field label="種別">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as AccountKind)}
        >
          <option value="cash">現金・預金</option>
          <option value="investment">投資</option>
        </select>
      </Field>

      {/* 種別はあとから変えられない。実質資産の対象が変わるため。 */}
      <p className="muted">種別はあとから変更できません。</p>

      <Field label="残高">
        <input
          type="text"
          inputMode="numeric"
          value={balance}
          onChange={(e) => setBalance(e.target.value)}
          required
        />
      </Field>

      <FormError message={message} />

      <button type="submit" disabled={busy}>
        追加する
      </button>
    </form>
  )
}
