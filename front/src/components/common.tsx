import type { ReactNode } from 'react'
import type { ApiError } from '../api/client'
import { formatMoney } from '../lib/format'

// 画面をまたいで使う表示部品。判断は持たせず、渡された値を並べるだけ。

export function Money({
  amount,
  className,
}: {
  amount: number
  className?: string
}) {
  return <span className={className}>{formatMoney(amount)}</span>
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: 'neutral' | 'warn' | 'good' | 'bad'
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>
}

export function Loading() {
  return <p className="muted">読み込み中…</p>
}

/**
 * ErrorMessage はエラーを表示する。
 *
 * 業務ルール違反（422）はサーバーのメッセージをそのまま出す。
 * 「回収額が未回収残高を超えています」のように、そのまま読んで
 * 意味が通る文言が返ってくるため、front で言い換えない。
 */
export function ErrorMessage({
  error,
  onRetry,
}: {
  error: ApiError
  onRetry?: () => void
}) {
  return (
    <div className="error" role="alert">
      <p>{error.message}</p>
      {error.isUnauthorized && (
        <p className="muted">トークンを設定し直してください。</p>
      )}
      {onRetry && (
        <button type="button" onClick={onRetry}>
          再試行
        </button>
      )}
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="muted">{children}</p>
}

export function Section({
  title,
  children,
  actions,
}: {
  title: string
  children: ReactNode
  actions?: ReactNode
}) {
  return (
    <section className="section">
      <div className="section-head">
        <h2>{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  )
}

export function Field({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
    </label>
  )
}

/** FormError は入力の誤りを伝える。送信前の検証と、サーバーの 422 の両方に使う。 */
export function FormError({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <p className="form-error" role="alert">
      {message}
    </p>
  )
}
