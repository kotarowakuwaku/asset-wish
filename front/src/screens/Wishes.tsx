import { useCallback, useState } from 'react'
import { errorMessage, type ApiClient } from '../api/client'
import type { Wish, WishCategory, WishStatus } from '../api/types'
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
  parseAmount,
  todayISO,
  wishCategoryLabel,
  wishStatusLabel,
} from '../lib/format'
import { AccountSelect } from '../components/AccountSelect'

// 絞り込みの選択肢。undefined は「すべて」。
const filters: { label: string; status?: WishStatus }[] = [
  { label: 'すべて' },
  { label: '検討中', status: 'considering' },
  { label: '確定', status: 'committed' },
  { label: '完了', status: 'done' },
  { label: '見送り', status: 'dropped' },
]

/**
 * Wishes はウィッシュの一覧と、登録・状態遷移・削除を行う。
 *
 * **状態遷移のボタンは、その遷移が許される状態のときだけ出す。**
 * ただし可否の判断そのものはサーバーが持つ（不変条件6）。ここでの
 * 出し分けは操作の見通しを良くするためで、防御はサーバー側にある。
 */
export function Wishes({ client }: { client: ApiClient }) {
  const [filterIndex, setFilterIndex] = useState(0)
  const status = filters[filterIndex].status

  const fetcher = useCallback(() => client.listWishes(status), [client, status])
  const { data, loading, error, reload } = useAsync(fetcher)

  const wishes = data ?? []

  return (
    <>
      <Section
        title="ウィッシュ"
        actions={
          <div className="tabs" role="group" aria-label="状態の絞り込み">
            {filters.map((filter, index) => (
              <button
                key={filter.label}
                type="button"
                aria-pressed={filterIndex === index}
                onClick={() => setFilterIndex(index)}
              >
                {filter.label}
              </button>
            ))}
          </div>
        }
      >
        {loading && !data && <Loading />}
        {error && <ErrorMessage error={error} onRetry={reload} />}
        {!error && !loading && wishes.length === 0 && (
          <Empty>該当するウィッシュはありません。</Empty>
        )}
        {wishes.length > 0 && (
          <ul className="card-list">
            {wishes.map((wish) => (
              <WishItem
                key={wish.id}
                client={client}
                wish={wish}
                onChanged={reload}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section title="ウィッシュを登録">
        <NewWishForm client={client} onCreated={reload} />
      </Section>
    </>
  )
}

function WishItem({
  client,
  wish,
  onChanged,
}: {
  client: ApiClient
  wish: Wish
  onChanged: () => void
}) {
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [paying, setPaying] = useState(false)

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await action()
      setMessage(null)
      onChanged()
    } catch (e) {
      // 不正な遷移はサーバーが 422 で返す。
      setMessage(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="card">
      <div className="card-head">
        <strong>{wish.title}</strong>
        <Badge tone={wish.status === 'committed' ? 'warn' : 'neutral'}>
          {wishStatusLabel(wish.status)}
        </Badge>
      </div>

      <div className="card-body">
        <span className="muted">{wishCategoryLabel(wish.category)}</span>
        <Money amount={wish.amount} className="amount" />
      </div>

      <div className="card-foot">
        <span className="muted">
          {wish.deadline ? `期限 ${formatDate(wish.deadline)}` : '期限なし'}
        </span>
        <span className="actions">
          {wish.status === 'considering' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => run(() => client.commitWish(wish.id))}
            >
              確定する
            </button>
          )}
          {wish.status === 'committed' && (
            <button type="button" onClick={() => setPaying((v) => !v)}>
              {paying ? '支払いをやめる' : '支払う'}
            </button>
          )}
          {(wish.status === 'considering' || wish.status === 'committed') && (
            <button
              type="button"
              disabled={busy}
              onClick={() => run(() => client.dropWish(wish.id))}
            >
              見送る
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => run(() => client.deleteWish(wish.id))}
          >
            削除
          </button>
        </span>
      </div>

      {paying && (
        <PayForm
          client={client}
          wish={wish}
          onPaid={() => {
            setPaying(false)
            onChanged()
          }}
        />
      )}

      <FormError message={message} />
    </li>
  )
}

/**
 * PayForm は支払いを記録する。
 *
 * 支払うと、そのウィッシュは確定支出から外れ、同額だけ口座残高が減る。
 * **実質資産は支払いの前後で変わらない。**
 */
function PayForm({
  client,
  wish,
  onPaid,
}: {
  client: ApiClient
  wish: Wish
  onPaid: () => void
}) {
  const [accountId, setAccountId] = useState('')
  const [occurredOn, setOccurredOn] = useState(todayISO())
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()

    setBusy(true)
    try {
      await client.payWish(wish.id, { accountId, occurredOn })
      setMessage(null)
      onPaid()
    } catch (e) {
      setMessage(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="form inline-form">
      <Field label="支払い元の口座">
        <AccountSelect client={client} value={accountId} onChange={setAccountId} />
      </Field>

      <Field label="日付">
        <input
          type="date"
          value={occurredOn}
          onChange={(e) => setOccurredOn(e.target.value)}
          required
        />
      </Field>

      <p className="muted">
        <Money amount={wish.amount} /> を口座から差し引きます。
      </p>

      <FormError message={message} />

      <button type="submit" disabled={busy || accountId === ''}>
        支払いを記録する
      </button>
    </form>
  )
}

function NewWishForm({
  client,
  onCreated,
}: {
  client: ApiClient
  onCreated: () => void
}) {
  const [title, setTitle] = useState('')
  const [amount, setAmount] = useState('')
  const [category, setCategory] = useState<WishCategory>('item')
  const [priority, setPriority] = useState('0')
  const [deadline, setDeadline] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()

    const parsedAmount = parseAmount(amount)
    if (parsedAmount === null || parsedAmount === 0) {
      setMessage('金額は1以上の整数で入力してください')
      return
    }
    const parsedPriority = parseAmount(priority)
    if (parsedPriority === null) {
      setMessage('優先度は0以上の整数で入力してください')
      return
    }

    setBusy(true)
    try {
      // 状態は送らない。新規は必ず検討中から始まる（不変条件3）。
      await client.createWish({
        title,
        amount: parsedAmount,
        category,
        priority: parsedPriority,
        deadline: deadline === '' ? null : deadline,
      })
      setTitle('')
      setAmount('')
      setDeadline('')
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
      <Field label="タイトル">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
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

      <Field label="種別">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as WishCategory)}
        >
          <option value="item">もの</option>
          <option value="experience">体験</option>
          <option value="goal">目標</option>
        </select>
      </Field>

      <Field label="優先度">
        <input
          type="text"
          inputMode="numeric"
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
        />
      </Field>

      <Field label="期限（任意）">
        <input
          type="date"
          value={deadline}
          onChange={(e) => setDeadline(e.target.value)}
        />
      </Field>

      <FormError message={message} />

      <button type="submit" disabled={busy}>
        登録する
      </button>
    </form>
  )
}
