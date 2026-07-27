package domain

import (
	"strings"
	"time"

	"github.com/google/uuid"
)

// StaleBalanceThreshold は残高が古いと判断する閾値。
const StaleBalanceThreshold = 45 * 24 * time.Hour

type AccountKind string

const (
	AccountKindCash       AccountKind = "cash"       // 現金・預金。実質資産に算入する
	AccountKindInvestment AccountKind = "investment" // 投資。実質資産に算入しない
)

func (k AccountKind) Valid() bool {
	return k == AccountKindCash || k == AccountKindInvestment
}

type Account struct {
	ID        uuid.UUID
	Name      string
	Kind      AccountKind
	Balance   Money
	UpdatedAt time.Time
}

// NewAccount は口座を生成する。
// name が空、または kind が不正なら error を返す。
// balance は負値を許容する（当座借越などを想定）。
func NewAccount(id uuid.UUID, name string, kind AccountKind, balance Money, now time.Time) (Account, error) {
	if strings.TrimSpace(name) == "" {
		return Account{}, ErrEmptyTitle
	}
	if !kind.Valid() {
		return Account{}, ErrInvalidAccountKind
	}
	return Account{
		ID:        id,
		Name:      name,
		Kind:      kind,
		Balance:   balance,
		UpdatedAt: now,
	}, nil
}

// CountsTowardNetAsset は実質資産の計算に算入すべきかを返す。
// investment は必ず false を返す（実質資産の存在意義に関わる不変条件）。
func (a Account) CountsTowardNetAsset() bool {
	return a.Kind == AccountKindCash
}

// UpdateBalance は残高を更新し、更新日時を now にする。
func (a *Account) UpdateBalance(balance Money, now time.Time) {
	a.Balance = balance
	a.UpdatedAt = now
}

// ApplyDelta は残高を増減させる。立替の発生・回収、ウィッシュの支払いで用いる。
func (a *Account) ApplyDelta(delta Money, now time.Time) {
	a.Balance = a.Balance.Add(delta)
	a.UpdatedAt = now
}

// IsStale は最終更新から threshold 以上経過しているかを返す。
// 残高更新の催促表示に用いる。
func (a Account) IsStale(now time.Time, threshold time.Duration) bool {
	return now.Sub(a.UpdatedAt) >= threshold
}
