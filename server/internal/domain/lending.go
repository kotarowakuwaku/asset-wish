package domain

import (
	"strings"
	"time"

	"github.com/google/uuid"
)

// CollectionStatus は回収状態。DB には保存せず、金額から導出する。
type CollectionStatus string

const (
	CollectionUncollected CollectionStatus = "uncollected" // 未回収
	CollectionPartial     CollectionStatus = "partial"     // 一部回収
	CollectionCollected   CollectionStatus = "collected"   // 回収済
)

type Lending struct {
	ID              uuid.UUID
	Counterparty    string
	Description     string
	Amount          Money
	CollectedAmount Money
	OccurredOn      time.Time
}

// NewLending は立替を生成する。CollectedAmount は 0 で初期化される。
// counterparty が空、または amount が 1 未満なら error を返す。
func NewLending(id uuid.UUID, counterparty, description string, amount Money, occurredOn time.Time) (Lending, error) {
	if strings.TrimSpace(counterparty) == "" {
		return Lending{}, ErrEmptyCounterparty
	}
	if !amount.IsPositive() {
		return Lending{}, ErrInvalidAmount
	}
	return Lending{
		ID:              id,
		Counterparty:    counterparty,
		Description:     description,
		Amount:          amount,
		CollectedAmount: 0,
		OccurredOn:      occurredOn,
	}, nil
}

// Outstanding は未回収残高を返す。実質資産への加算対象。
func (l Lending) Outstanding() Money {
	return l.Amount.Sub(l.CollectedAmount)
}

func (l Lending) IsFullyCollected() bool {
	return l.Outstanding().IsZero()
}

// Status は回収状態を導出する。
func (l Lending) Status() CollectionStatus {
	switch {
	case l.CollectedAmount.IsZero():
		return CollectionUncollected
	case l.CollectedAmount < l.Amount:
		return CollectionPartial
	default:
		return CollectionCollected
	}
}

// Collect は回収を記録する。過回収は絶対に許さない。
func (l *Lending) Collect(amount Money) error {
	if !amount.IsPositive() {
		return ErrInvalidAmount
	}
	if amount > l.Outstanding() {
		return ErrCollectExceedsOutstanding
	}
	l.CollectedAmount = l.CollectedAmount.Add(amount)
	return nil
}
