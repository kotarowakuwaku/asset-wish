package domain_test

import (
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
)

func newWish(t *testing.T, status domain.WishStatus) domain.Wish {
	t.Helper()
	w, err := domain.NewWish(uuid.New(), "test", domain.Money(1000), domain.WishCategoryItem, 0, nil)
	if err != nil {
		t.Fatalf("NewWish: %v", err)
	}
	w.Status = status
	return w
}

func TestWish_Transitions(t *testing.T) {
	type op struct {
		name string
		fn   func(*domain.Wish) error
	}
	commit := op{"Commit", (*domain.Wish).Commit}
	pay := op{"Pay", (*domain.Wish).Pay}
	drop := op{"Drop", (*domain.Wish).Drop}

	tests := []struct {
		name       string
		initial    domain.WishStatus
		op         op
		wantStatus domain.WishStatus
		wantErr    error
	}{
		{"E-1: considering→Commit ok", domain.WishConsidering, commit, domain.WishCommitted, nil},
		{"E-2: committed→Commit err", domain.WishCommitted, commit, domain.WishCommitted, domain.ErrInvalidTransition},
		{"E-3: done→Commit err", domain.WishDone, commit, domain.WishDone, domain.ErrInvalidTransition},
		{"E-4: dropped→Commit err", domain.WishDropped, commit, domain.WishDropped, domain.ErrInvalidTransition},
		{"E-5: committed→Pay ok", domain.WishCommitted, pay, domain.WishDone, nil},
		{"E-6: considering→Pay err", domain.WishConsidering, pay, domain.WishConsidering, domain.ErrInvalidTransition},
		{"E-7: done→Pay err", domain.WishDone, pay, domain.WishDone, domain.ErrInvalidTransition},
		{"E-8: considering→Drop ok", domain.WishConsidering, drop, domain.WishDropped, nil},
		{"E-9: committed→Drop ok", domain.WishCommitted, drop, domain.WishDropped, nil},
		{"E-10: done→Drop err", domain.WishDone, drop, domain.WishDone, domain.ErrInvalidTransition},
		{"E-11: dropped→Drop err", domain.WishDropped, drop, domain.WishDropped, domain.ErrInvalidTransition},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := newWish(t, tt.initial)
			err := tt.op.fn(&w)
			if !errors.Is(err, tt.wantErr) {
				t.Errorf("err=%v want %v", err, tt.wantErr)
			}
			// エラー時に状態が変化していないことも検証する（最も気づきにくい不具合になるため）
			if w.Status != tt.wantStatus {
				t.Errorf("status=%s want %s", w.Status, tt.wantStatus)
			}
		})
	}
}
