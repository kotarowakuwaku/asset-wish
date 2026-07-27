package usecase_test

import (
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
	"github.com/kotarowakuwaku/asset-wish/server/internal/usecase"
)

func TestTransactionUsecase_List(t *testing.T) {
	h := newHarness(t)
	data := h.data
	transactions := usecase.NewTransactionUsecase(&fakeTransactions{data: data})

	accountID := uuid.New()
	for _, day := range []int{10, 25, 3} {
		ref := uuid.New()
		tr, err := domain.NewTransaction(
			uuid.New(), accountID, -1000, domain.TransactionLendingCreated, &ref,
			date(2026, time.June, day),
		)
		if err != nil {
			t.Fatalf("NewTransaction: %v", err)
		}
		data.transactions = append(data.transactions, tr)
	}

	got, err := transactions.List(h.ctx, 2)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("2件のはず: got %d", len(got))
	}
	if !got[0].OccurredOn.Equal(date(2026, time.June, 25)) {
		t.Errorf("降順になっていない: 先頭=%v", got[0].OccurredOn)
	}

	// limit が 0 以下なら既定値を使う。全件（3件）が返る。
	all, err := transactions.List(h.ctx, 0)
	if err != nil {
		t.Fatalf("List(0): %v", err)
	}
	if len(all) != 3 {
		t.Errorf("既定の件数で全件返るはず: got %d", len(all))
	}
}
