package domain

import (
	"time"

	"github.com/google/uuid"
)

// TransactionKind は取引の種別。DB の CHECK 制約と同じ値を持つ。
type TransactionKind string

const (
	TransactionLendingCreated   TransactionKind = "lending_created"   // 立替の発生。口座から出る
	TransactionLendingCollected TransactionKind = "lending_collected" // 立替の回収。口座に戻る
	TransactionWishPaid         TransactionKind = "wish_paid"         // ウィッシュの支払い。口座から出る
	TransactionAdjustment       TransactionKind = "adjustment"        // 残高の手動調整
)

func (k TransactionKind) Valid() bool {
	switch k {
	case TransactionLendingCreated, TransactionLendingCollected,
		TransactionWishPaid, TransactionAdjustment:
		return true
	default:
		return false
	}
}

// RequiresReference は参照先（立替・ウィッシュ）を必ず伴う種別かを返す。
// adjustment だけが参照先を持たない。
func (k TransactionKind) RequiresReference() bool {
	return k != TransactionAdjustment
}

// Transaction は口座残高が動いた記録。
//
// 残高の裏付けを後から追うためのもので、実質資産の計算には使わない
// （実質資産は accounts.balance から出す）。したがって、この型に
// 集計のためのメソッドは持たせない。
type Transaction struct {
	ID        uuid.UUID
	AccountID uuid.UUID
	// Amount は符号付き。口座から出るときは負、戻るときは正。
	Amount Money
	Kind   TransactionKind
	// RefID は立替またはウィッシュの ID。adjustment のときだけ nil。
	// 参照先が2種類あるため DB では外部キーを張れない（design.md 2.3）。
	RefID      *uuid.UUID
	OccurredOn time.Time
}

// NewTransaction は取引履歴を生成する。
//
// amount が 0 なら ErrInvalidAmount。残高が動かない記録に意味は無い。
// kind が不正なら ErrInvalidTransactionKind。
// adjustment 以外で refID が nil なら ErrMissingReference。参照先を
// 失った履歴は、後から何の取引だったか辿れなくなる。
func NewTransaction(
	id uuid.UUID,
	accountID uuid.UUID,
	amount Money,
	kind TransactionKind,
	refID *uuid.UUID,
	occurredOn time.Time,
) (Transaction, error) {
	if amount.IsZero() {
		return Transaction{}, ErrInvalidAmount
	}
	if !kind.Valid() {
		return Transaction{}, ErrInvalidTransactionKind
	}
	if kind.RequiresReference() && refID == nil {
		return Transaction{}, ErrMissingReference
	}
	if !kind.RequiresReference() {
		// adjustment に参照先を持たせない。渡されても落とす。
		refID = nil
	}
	return Transaction{
		ID:         id,
		AccountID:  accountID,
		Amount:     amount,
		Kind:       kind,
		RefID:      refID,
		OccurredOn: occurredOn,
	}, nil
}
