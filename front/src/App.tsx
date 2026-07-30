import { useMemo, useState } from 'react'
import './App.css'
import { createClient } from './api/client'
import { routes, useRoute } from './app/router'
import { clearToken, loadToken, saveToken } from './app/token'
import { Accounts } from './screens/Accounts'
import { Dashboard } from './screens/Dashboard'
import { Loans } from './screens/Loans'
import { MonthlyBalances } from './screens/MonthlyBalances'
import { Wishes } from './screens/Wishes'

/**
 * App は画面の切り替えとトークンの保持だけを行う。
 *
 * データの取得は各画面が自分で行う。ここで全部を抱えると、1画面の
 * 都合で全体が再描画される。
 */
function App() {
  const [token, setToken] = useState<string | null>(() => loadToken())
  const [route, navigate] = useRoute()

  // token が変わらない限りクライアントを作り直さない。
  // 毎回新しいオブジェクトになると useAsync の取得が止まらなくなる。
  const client = useMemo(
    () => (token === null ? null : createClient(token)),
    [token],
  )

  if (client === null) {
    return (
      <TokenGate
        onSubmit={(value) => {
          saveToken(value)
          setToken(value)
        }}
      />
    )
  }

  return (
    <div className="app">
      <header className="app-head">
        <h1>資産ウィッシュ</h1>
        <button
          type="button"
          className="link"
          onClick={() => {
            clearToken()
            setToken(null)
          }}
        >
          トークンを消す
        </button>
      </header>

      <nav className="nav">
        {routes.map((r) => (
          <button
            key={r.path}
            type="button"
            aria-current={route === r.path ? 'page' : undefined}
            onClick={() => navigate(r.path)}
          >
            {r.label}
          </button>
        ))}
      </nav>

      <main>
        {route === 'dashboard' && <Dashboard client={client} />}
        {route === 'accounts' && <Accounts client={client} />}
        {route === 'loans' && <Loans client={client} />}
        {route === 'wishes' && <Wishes client={client} />}
        {route === 'monthly-balances' && <MonthlyBalances client={client} />}
      </main>
    </div>
  )
}

/**
 * TokenGate はトークンが無いときに入力を求める。
 *
 * 単一ユーザーのため、ログイン画面ではなく固定トークンの入力欄にする
 * （docs/design.md 4.5）。ユーザー管理もパスワードも持たない。
 */
function TokenGate({ onSubmit }: { onSubmit: (token: string) => void }) {
  const [value, setValue] = useState('')

  return (
    <div className="app">
      <header className="app-head">
        <h1>資産ウィッシュ</h1>
      </header>

      <main>
        <section className="section">
          <h2>アクセストークン</h2>
          <p className="muted">
            サーバーに設定したトークンを入力してください。この端末にのみ保存されます。
          </p>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault()
              if (value.trim() !== '') {
                onSubmit(value)
              }
            }}
          >
            <label className="field">
              <span className="field-label">トークン</span>
              <input
                type="password"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                autoComplete="off"
                required
              />
            </label>
            <button type="submit">保存する</button>
          </form>
        </section>
      </main>
    </div>
  )
}

export default App
