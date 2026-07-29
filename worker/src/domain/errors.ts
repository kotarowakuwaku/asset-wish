// 業務ルール違反を表すエラー。HTTP 422 に対応する。
// 形式エラー（HTTP 400）とは区別する（不変条件13）。
//
// Go 版はエラーの実体を package 変数として持ち、errors.Is で同一性を見ていた。
// TypeScript では throw のたびに新しく作り、code で同一性を見る。
// 共有インスタンスを投げ回すと、スタックトレースが最初に作られた場所を
// 指したままになり、どこで失敗したのか分からなくなる。

// コードとメッセージの対応表。ここに無いコードは使えない（型で弾かれる）。
export const DOMAIN_ERROR_MESSAGES = {
  INVALID_AMOUNT: '金額は1円以上である必要があります',
  NEGATIVE_AMOUNT: '金額に負の値は指定できません',
  EMPTY_TITLE: '名称は必須です',
  EMPTY_COUNTERPARTY: '立替の相手は必須です',
  INVALID_ACCOUNT_KIND: '口座種別が不正です',
  INVALID_WISH_CATEGORY: 'ウィッシュ種別が不正です',
  INVALID_WISH_STATUS: 'ウィッシュ状態が不正です',
  INVALID_TRANSITION: 'この状態からは実行できない操作です',
  COLLECT_EXCEEDS_OUTSTANDING: '回収額が未回収残高を超えています',
  INVALID_YEAR_MONTH: '年月の指定が不正です',
  INVALID_TRANSACTION_KIND: '取引種別が不正です',
  MISSING_REFERENCE: 'この取引種別には参照先が必要です',
  ACCOUNT_IN_USE: '取引履歴が残っている口座は削除できません',
} as const

export type DomainErrorCode = keyof typeof DOMAIN_ERROR_MESSAGES

export class DomainError extends Error {
  readonly code: DomainErrorCode

  constructor(code: DomainErrorCode) {
    super(DOMAIN_ERROR_MESSAGES[code])
    this.name = 'DomainError'
    this.code = code
  }
}

/** 業務ルール違反を投げる。handler はこれを捕まえて 422 にする。 */
export function domainError(code: DomainErrorCode): DomainError {
  return new DomainError(code)
}

/** handler でのステータスコード決定に用いる。 */
export function isDomainError(err: unknown): err is DomainError {
  return err instanceof DomainError
}
