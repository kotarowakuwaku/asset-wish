import { useCallback, useState } from 'react'
import { errorMessage, type ApiClient } from '../api/client'
import type { Transaction } from '../api/types'
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
import { formatDate, parseAmount, todayISO, transactionKindLabel } from '../lib/format'
import { AccountSelect } from './AccountSelect'

/** 入金か出金か。画面の中だけの区別で、サーバーへは金額の符号として送る。 */
type Direction = 'out' | 'in'

/**
 * Transactions は入出金の明細を打ち、履歴を並べる。
 *
 * **打つと口座残高が動く。** 貸し借り（口座を触らない）とはここが違う。
 * 残高の更新と履歴の記録はサーバーが原子的に行う（不変条件10）。
 *
 * 分類（カテゴリ）は持たない。何に使ったかはメモを読めば分かる。
 * 分類と集計を入れると、このアプリが実質資産を見る道具から家計簿に寄る。
 *
 * 一覧にはウィッシュの支払いなど手入力でない履歴も混ざる。残高が動いた
 * 理由を辿るのが履歴の役目なので、種別で隠さない。ただし消せるのは
 * 手入力の明細だけで、判定はサーバーが持つ。
 */
export function Transactions({ client }: { client: ApiClient }) {
  const fetchTransactions = useCallback(() => client.listTransactions(), [client])
  const { data, loading, error, reload } = useAsync(fetchTransactions)

  // 口座名は表示のためだけに引く。どの口座の残高が動いたかが読めないと、
  // 履歴を見ても残高の裏付けにならない。
  const fetchAccounts = useCallback(() => client.listAccounts(), [client])
  const accounts = useAsync(fetchAccounts)
  const accountNames = new Map(
    (accounts.data ?? []).map((a) => [a.id, a.name] as const),
  )

  const transactions = data ?? []

  return (
    <>
      <Section title="入出金">
        {loading && !data && <Loading />}
        {error && <ErrorMessage error={error} onRetry={reload} />}
        {!error && transactions.length === 0 && !loading && (
          <Empty>入出金がまだありません。</Empty>
        )}
        {transactions.length > 0 && (
          <ul className="card-list">
            {transactions.map((t) => (
              <TransactionItem
                key={t.id}
                client={client}
                transaction={t}
                accountName={accountNames.get(t.accountId)}
                onDeleted={reload}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section title="入出金を打つ">
        <NewTransactionForm client={client} onCreated={reload} />
      </Section>
    </>
  )
}

function TransactionItem({
  client,
  transaction,
  accountName,
  onDeleted,
}: {
  client: ApiClient
  transaction: Transaction
  accountName: string | undefined
  onDeleted: () => void
}) {
  // 手入力の明細だけが消せる。それ以外を消すとウィッシュや貸し借りの
  // 状態と食い違うため、サーバーも 422 で弾く。
  const deletable = transaction.kind === 'adjustment'

  return (
    <li className="card">
      <div className="card-head">
        <strong>{transaction.note || transactionKindLabel(transaction.kind)}</strong>
        {/* 符号が向きそのものなので、入金・出金のラベルは金額に任せる。
            ここで示すのは、手入力かウィッシュ由来かの区別。 */}
        <Badge tone={transaction.amount < 0 ? 'neutral' : 'good'}>
          {transactionKindLabel(transaction.kind)}
        </Badge>
      </div>

      <div className="card-body">
        <span className="muted">{accountName ?? ''}</span>
        <Money amount={transaction.amount} className="amount" />
      </div>

      <div className="card-foot">
        <span className="muted">{formatDate(transaction.occurredOn)}</span>
        {deletable && (
          <DeleteTransactionButton
            client={client}
            transaction={transaction}
            onDeleted={onDeleted}
          />
        )}
      </div>
    </li>
  )
}

/**
 * DeleteTransactionButton は明細を消す。
 *
 * 消すと動かした分の残高が戻る。打ち消しの明細を足す方式は採らない。
 * 打ち間違いが一覧に残り続け、1件の誤りが2行に増えるため。
 */
function DeleteTransactionButton({
  client,
  transaction,
  onDeleted,
}: {
  client: ApiClient
  transaction: Transaction
  onDeleted: () => void
}) {
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const remove = async () => {
    setBusy(true)
    try {
      await client.deleteTransaction(transaction.id)
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

function NewTransactionForm({
  client,
  onCreated,
}: {
  client: ApiClient
  onCreated: () => void
}) {
  // 出金を既定にする。件数が多いのはこちら。
  const [direction, setDirection] = useState<Direction>('out')
  const [accountId, setAccountId] = useState('')
  const [amount, setAmount] = useState('')
  const [occurredOn, setOccurredOn] = useState(todayISO())
  const [note, setNote] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()

    const parsed = parseAmount(amount)
    if (parsed === null || parsed === 0) {
      setMessage('金額は1以上の整数で入力してください')
      return
    }
    if (accountId === '') {
      setMessage('口座を選んでください')
      return
    }

    setBusy(true)
    try {
      await client.createTransaction({
        accountId,
        // 入力欄は常に正の数で受け、ここで符号に直す。API と domain は
        // 符号付きで統一されており（出金は負）、一覧も符号付きで返る。
        // 計算ではなく、向きの表し方をサーバーに合わせているだけ。
        amount: direction === 'out' ? -parsed : parsed,
        occurredOn,
        note,
      })
      setAmount('')
      setNote('')
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
        <select
          value={direction}
          onChange={(e) => setDirection(e.target.value as Direction)}
        >
          <option value="out">出金（払った）</option>
          <option value="in">入金（受け取った）</option>
        </select>
      </Field>

      {/* 貸し借りと違い、口座は必ず選ばせる。どの残高が動くかを
          指定しないと処理が成立しない。 */}
      <Field label="口座">
        <AccountSelect
          client={client}
          value={accountId}
          onChange={setAccountId}
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

      <Field label="日付">
        <input
          type="date"
          value={occurredOn}
          onChange={(e) => setOccurredOn(e.target.value)}
          required
        />
      </Field>

      {/* 分類は持たない。何に使ったかはここに書く。 */}
      <Field label="メモ">
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>

      <FormError message={message} />

      <button type="submit" disabled={busy}>
        打つ
      </button>
    </form>
  )
}
