package domain_test

import (
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
)

func TestNewTransaction(t *testing.T) {
	occurredOn := time.Date(2026, 7, 12, 0, 0, 0, 0, time.UTC)
	ref := uuid.New()

	tests := []struct {
		name    string
		amount  domain.Money
		kind    domain.TransactionKind
		refID   *uuid.UUID
		wantErr error
	}{
		{"立替の発生（出金）", -12000, domain.TransactionLendingCreated, &ref, nil},
		{"立替の回収（入金）", 5000, domain.TransactionLendingCollected, &ref, nil},
		{"ウィッシュの支払い", -80000, domain.TransactionWishPaid, &ref, nil},
		{"手動調整は参照先なしでよい", -300, domain.TransactionAdjustment, nil, nil},
		{"金額0は記録する意味が無い", 0, domain.TransactionAdjustment, nil, domain.ErrInvalidAmount},
		{"未知の種別", -100, domain.TransactionKind("refund"), &ref, domain.ErrInvalidTransactionKind},
		{"立替の発生に参照先が無い", -100, domain.TransactionLendingCreated, nil, domain.ErrMissingReference},
		{"立替の回収に参照先が無い", 100, domain.TransactionLendingCollected, nil, domain.ErrMissingReference},
		{"支払いに参照先が無い", -100, domain.TransactionWishPaid, nil, domain.ErrMissingReference},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := domain.NewTransaction(uuid.New(), uuid.New(), tt.amount, tt.kind, tt.refID, occurredOn)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("err=%v want %v", err, tt.wantErr)
			}
			if tt.wantErr != nil {
				return
			}
			if got.Amount != tt.amount {
				t.Errorf("Amount=%d want %d", got.Amount, tt.amount)
			}
			if got.Kind != tt.kind {
				t.Errorf("Kind=%s want %s", got.Kind, tt.kind)
			}
			if got.OccurredOn != occurredOn {
				t.Errorf("OccurredOn=%v want %v", got.OccurredOn, occurredOn)
			}
		})
	}
}

// TestNewTransaction_AdjustmentDropsReference は、adjustment に参照先を
// 渡しても保持しないことを確かめる。
//
// 参照先を持てる種別と持てない種別が混ざると、履歴を辿るときに
// 「ref_id があるのに参照先が無い」行を疑う羽目になる。入口で落とす。
func TestNewTransaction_AdjustmentDropsReference(t *testing.T) {
	ref := uuid.New()
	got, err := domain.NewTransaction(
		uuid.New(), uuid.New(), -300, domain.TransactionAdjustment, &ref,
		time.Date(2026, 7, 12, 0, 0, 0, 0, time.UTC),
	)
	if err != nil {
		t.Fatalf("NewTransaction: %v", err)
	}
	if got.RefID != nil {
		t.Errorf("adjustment は参照先を持たないはず: got %v", *got.RefID)
	}
}

// TestNewTransaction_KeepsReference は参照先がそのまま保持されることを確かめる。
func TestNewTransaction_KeepsReference(t *testing.T) {
	ref := uuid.New()
	got, err := domain.NewTransaction(
		uuid.New(), uuid.New(), -12000, domain.TransactionLendingCreated, &ref,
		time.Date(2026, 7, 12, 0, 0, 0, 0, time.UTC),
	)
	if err != nil {
		t.Fatalf("NewTransaction: %v", err)
	}
	if got.RefID == nil || *got.RefID != ref {
		t.Errorf("RefID=%v want %v", got.RefID, ref)
	}
}

func TestTransactionKind_Valid(t *testing.T) {
	valid := []domain.TransactionKind{
		domain.TransactionLendingCreated,
		domain.TransactionLendingCollected,
		domain.TransactionWishPaid,
		domain.TransactionAdjustment,
	}
	for _, k := range valid {
		if !k.Valid() {
			t.Errorf("%s は有効なはず", k)
		}
	}

	for _, k := range []domain.TransactionKind{"", "unknown", "LENDING_CREATED"} {
		if k.Valid() {
			t.Errorf("%q は無効なはず", k)
		}
	}
}

func TestTransactionKind_RequiresReference(t *testing.T) {
	if domain.TransactionAdjustment.RequiresReference() {
		t.Error("adjustment は参照先を要求しない")
	}
	for _, k := range []domain.TransactionKind{
		domain.TransactionLendingCreated,
		domain.TransactionLendingCollected,
		domain.TransactionWishPaid,
	} {
		if !k.RequiresReference() {
			t.Errorf("%s は参照先を要求する", k)
		}
	}
}
