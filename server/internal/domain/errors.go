package domain

import "errors"

// DomainError は業務ルール違反を表す。HTTP 422 に対応する。
// 形式エラー（HTTP 400）とは区別する。
type DomainError struct {
	Code    string
	Message string
}

func (e *DomainError) Error() string { return e.Message }

// IsDomainError は err が DomainError かどうかを判定する。
// handler でのステータスコード決定に用いる。
func IsDomainError(err error) bool {
	var de *DomainError
	return errors.As(err, &de)
}

var (
	ErrInvalidAmount             = &DomainError{Code: "INVALID_AMOUNT", Message: "金額は1円以上である必要があります"}
	ErrNegativeAmount            = &DomainError{Code: "NEGATIVE_AMOUNT", Message: "金額に負の値は指定できません"}
	ErrEmptyTitle                = &DomainError{Code: "EMPTY_TITLE", Message: "名称は必須です"}
	ErrEmptyCounterparty         = &DomainError{Code: "EMPTY_COUNTERPARTY", Message: "立替の相手は必須です"}
	ErrInvalidAccountKind        = &DomainError{Code: "INVALID_ACCOUNT_KIND", Message: "口座種別が不正です"}
	ErrInvalidWishCategory       = &DomainError{Code: "INVALID_WISH_CATEGORY", Message: "ウィッシュ種別が不正です"}
	ErrInvalidWishStatus         = &DomainError{Code: "INVALID_WISH_STATUS", Message: "ウィッシュ状態が不正です"}
	ErrInvalidTransition         = &DomainError{Code: "INVALID_TRANSITION", Message: "この状態からは実行できない操作です"}
	ErrCollectExceedsOutstanding = &DomainError{Code: "COLLECT_EXCEEDS_OUTSTANDING", Message: "回収額が未回収残高を超えています"}
	ErrInvalidYearMonth          = &DomainError{Code: "INVALID_YEAR_MONTH", Message: "年月の指定が不正です"}
	ErrInvalidTransactionKind    = &DomainError{Code: "INVALID_TRANSACTION_KIND", Message: "取引種別が不正です"}
	ErrMissingReference          = &DomainError{Code: "MISSING_REFERENCE", Message: "この取引種別には参照先が必要です"}
	ErrAccountInUse              = &DomainError{Code: "ACCOUNT_IN_USE", Message: "取引履歴が残っている口座は削除できません"}
)
