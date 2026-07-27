import { useCallback, useEffect } from 'react'
import type { ApiClient } from '../api/client'
import { useAsync } from '../app/useAsync'

/**
 * AccountSelect は口座を選ばせる。
 *
 * 立替の登録・回収、ウィッシュの支払いで使う。いずれも「どの口座の
 * 残高が動くか」を指定しないと処理が成立しない。
 */
export function AccountSelect({
  client,
  value,
  onChange,
}: {
  client: ApiClient
  value: string
  onChange: (accountId: string) => void
}) {
  const fetcher = useCallback(() => client.listAccounts(), [client])
  const { data, loading, error } = useAsync(fetcher)

  const accounts = data ?? []

  // 先頭の口座を初期選択にする。毎回選ばせるより、間違いに気付いて
  // 選び直すほうが手数が少ない。
  //
  // 依存に配列そのものを置かない。`data ?? []` は毎回新しい配列に
  // なるため、レンダーのたびに effect が走る。ID だけを見る。
  const firstAccountId = data?.[0]?.id
  useEffect(() => {
    if (value === '' && firstAccountId !== undefined) {
      onChange(firstAccountId)
    }
  }, [firstAccountId, value, onChange])

  if (loading && !data) {
    return <span className="muted">口座を読み込み中…</span>
  }
  if (error) {
    return <span className="form-error">口座を取得できませんでした</span>
  }
  if (accounts.length === 0) {
    return <span className="form-error">先に口座を登録してください</span>
  }

  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} required>
      {accounts.map((account) => (
        <option key={account.id} value={account.id}>
          {account.name}
        </option>
      ))}
    </select>
  )
}
