package domain_test

import (
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
)

func newLending(t *testing.T, amount, collected domain.Money) domain.Lending {
	t.Helper()
	l, err := domain.NewLending(uuid.New(), "田中", "", amount, time.Date(2026, 7, 12, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("NewLending: %v", err)
	}
	l.CollectedAmount = collected
	return l
}

func TestLending_Collect(t *testing.T) {
	tests := []struct {
		name          string
		amount        domain.Money
		collected     domain.Money
		collectAmount domain.Money
		wantErr       error
		wantCollected domain.Money
		wantStatus    domain.CollectionStatus
	}{
		{"F-1: partial collect", 12000, 0, 5000, nil, 5000, domain.CollectionPartial},
		{"F-2: reach full", 12000, 5000, 7000, nil, 12000, domain.CollectionCollected},
		{"F-3: over collect (already partial)", 12000, 5000, 8000, domain.ErrCollectExceedsOutstanding, 5000, domain.CollectionPartial},
		{"F-4: over collect (already full)", 12000, 12000, 1, domain.ErrCollectExceedsOutstanding, 12000, domain.CollectionCollected},
		{"F-5: zero amount", 12000, 0, 0, domain.ErrInvalidAmount, 0, domain.CollectionUncollected},
		{"F-6: negative amount", 12000, 0, -100, domain.ErrInvalidAmount, 0, domain.CollectionUncollected},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			l := newLending(t, tt.amount, tt.collected)
			err := l.Collect(tt.collectAmount)
			if !errors.Is(err, tt.wantErr) {
				t.Errorf("err=%v want %v", err, tt.wantErr)
			}
			if l.CollectedAmount != tt.wantCollected {
				t.Errorf("CollectedAmount=%d want %d", l.CollectedAmount, tt.wantCollected)
			}
			if l.Status() != tt.wantStatus {
				t.Errorf("Status()=%s want %s", l.Status(), tt.wantStatus)
			}
		})
	}
}

func TestLending_OutstandingAndStatus(t *testing.T) {
	l := newLending(t, 12000, 0)
	if got := l.Outstanding(); got != 12000 {
		t.Errorf("F-7: Outstanding()=%d want 12000", got)
	}
	if got := l.Status(); got != domain.CollectionUncollected {
		t.Errorf("F-7: Status()=%s want uncollected", got)
	}
}
