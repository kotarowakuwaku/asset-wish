package domain

import (
	"strings"
	"time"

	"github.com/google/uuid"
)

type WishCategory string

const (
	WishCategoryItem       WishCategory = "item"       // もの
	WishCategoryExperience WishCategory = "experience" // 体験
	WishCategoryGoal       WishCategory = "goal"       // 目標
)

func (c WishCategory) Valid() bool {
	return c == WishCategoryItem || c == WishCategoryExperience || c == WishCategoryGoal
}

type WishStatus string

const (
	WishConsidering WishStatus = "considering" // 検討中
	WishCommitted   WishStatus = "committed"   // 確定（＝確定支出）
	WishDone        WishStatus = "done"        // 完了
	WishDropped     WishStatus = "dropped"     // 見送り
)

func (s WishStatus) Valid() bool {
	return s == WishConsidering || s == WishCommitted || s == WishDone || s == WishDropped
}

// IsTerminal は終端状態かを返す。done / dropped が true。
func (s WishStatus) IsTerminal() bool {
	return s == WishDone || s == WishDropped
}

type Wish struct {
	ID       uuid.UUID
	Title    string
	Amount   Money
	Category WishCategory
	Status   WishStatus
	Priority int
	Deadline *time.Time
}

// NewWish は検討中の状態でウィッシュを生成する。
// title が空、amount が 1 未満、category が不正なら error を返す。
func NewWish(id uuid.UUID, title string, amount Money, category WishCategory, priority int, deadline *time.Time) (Wish, error) {
	if strings.TrimSpace(title) == "" {
		return Wish{}, ErrEmptyTitle
	}
	if !amount.IsPositive() {
		return Wish{}, ErrInvalidAmount
	}
	if !category.Valid() {
		return Wish{}, ErrInvalidWishCategory
	}
	return Wish{
		ID:       id,
		Title:    title,
		Amount:   amount,
		Category: category,
		Status:   WishConsidering,
		Priority: priority,
		Deadline: deadline,
	}, nil
}

// IsCommitment は確定支出として実質資産から控除されるかを返す。
// committed のときのみ true。他の状態では必ず false。
func (w Wish) IsCommitment() bool {
	return w.Status == WishCommitted
}

// Commit は 検討中 → 確定 に遷移させる。検討中以外からは ErrInvalidTransition。
func (w *Wish) Commit() error {
	if w.Status != WishConsidering {
		return ErrInvalidTransition
	}
	w.Status = WishCommitted
	return nil
}

// Pay は 確定 → 完了 に遷移させる。確定以外からは ErrInvalidTransition。
func (w *Wish) Pay() error {
	if w.Status != WishCommitted {
		return ErrInvalidTransition
	}
	w.Status = WishDone
	return nil
}

// Drop は 検討中 または 確定 → 見送り に遷移させる。終端状態からは ErrInvalidTransition。
func (w *Wish) Drop() error {
	if w.Status != WishConsidering && w.Status != WishCommitted {
		return ErrInvalidTransition
	}
	w.Status = WishDropped
	return nil
}
