package usecase_test

import (
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
	"github.com/kotarowakuwaku/asset-wish/server/internal/usecase"
)

// TestLendingUsecase_Create は、立替の登録で口座残高が減り履歴が残ることを
// 確かめる（detailed-design 3.2.1）。
//
// 立て替えた時点で自分の口座から金は出ている。残高を減らさないと、
// 未回収額と残高の両方に同じ金を数えることになり、実質資産が過大に出る。
func TestLendingUsecase_Create(t *testing.T) {
	h := newHarness(t)
	account := h.seedAccount(t, "生活用", domain.AccountKindCash, 500000)

	before := h.netAsset(t)

	l, err := h.lendings.Create(h.ctx, "友人A", "チケット代", 12000, date(2026, time.June, 10), account.ID)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	if got := h.account(t, account.ID).Balance; got != 488000 {
		t.Errorf("残高=%d want 488000", got)
	}
	if got := h.lending(t, l.ID).Outstanding(); got != 12000 {
		t.Errorf("未回収=%d want 12000", got)
	}

	if len(h.data.transactions) != 1 {
		t.Fatalf("履歴は1件のはず: got %d", len(h.data.transactions))
	}
	tr := h.data.transactions[0]
	if tr.Kind != domain.TransactionLendingCreated {
		t.Errorf("Kind=%s want lending_created", tr.Kind)
	}
	if tr.Amount != -12000 {
		t.Errorf("Amount=%d want -12000", tr.Amount)
	}
	if tr.RefID == nil || *tr.RefID != l.ID {
		t.Errorf("RefID=%v want %v", tr.RefID, l.ID)
	}

	// 残高が 12000 減り、未回収が 12000 増えるので、実質資産は動かない。
	if after := h.netAsset(t); after != before {
		t.Errorf("実質資産が変わった: before=%d after=%d", before, after)
	}
}

func TestLendingUsecase_CreateRejectsInvalidInput(t *testing.T) {
	h := newHarness(t)
	account := h.seedAccount(t, "生活用", domain.AccountKindCash, 500000)

	tests := []struct {
		name         string
		counterparty string
		amount       domain.Money
		wantErr      error
	}{
		{"相手が空", "  ", 12000, domain.ErrEmptyCounterparty},
		{"金額0", "友人A", 0, domain.ErrInvalidAmount},
		{"金額が負", "友人A", -1, domain.ErrInvalidAmount},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := h.lendings.Create(h.ctx, tt.counterparty, "", tt.amount, date(2026, time.June, 10), account.ID)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("err=%v want %v", err, tt.wantErr)
			}
			if got := h.account(t, account.ID).Balance; got != 500000 {
				t.Errorf("失敗時に残高が動いている: %d", got)
			}
			if len(h.data.transactions) != 0 {
				t.Errorf("失敗時に履歴が残っている: %d 件", len(h.data.transactions))
			}
		})
	}
}

func TestLendingUsecase_CreateUnknownAccount(t *testing.T) {
	h := newHarness(t)

	_, err := h.lendings.Create(h.ctx, "友人A", "", 12000, date(2026, time.June, 10), uuid.New())
	if !errors.Is(err, usecase.ErrNotFound) {
		t.Fatalf("err=%v want usecase.ErrNotFound", err)
	}
	if len(h.data.lendings) != 0 {
		t.Errorf("口座が無いのに立替が作られている: %d 件", len(h.data.lendings))
	}
}

// TestLendingUsecase_Collect は H-1。
// 回収額・口座残高・取引履歴の3つがすべて更新されること。
func TestLendingUsecase_Collect(t *testing.T) {
	h := newHarness(t)
	account := h.seedAccount(t, "生活用", domain.AccountKindCash, 488000)
	l := h.seedLending(t, "友人A", 12000, 0)

	got, err := h.lendings.Collect(h.ctx, l.ID, 5000, date(2026, time.July, 20), account.ID)
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}

	if got.CollectedAmount != 5000 || got.Outstanding() != 7000 {
		t.Errorf("戻り値が合わない: %+v", got)
	}
	if stored := h.lending(t, l.ID); stored.CollectedAmount != 5000 {
		t.Errorf("回収額=%d want 5000", stored.CollectedAmount)
	}
	if stored := h.account(t, account.ID); stored.Balance != 493000 {
		t.Errorf("残高=%d want 493000", stored.Balance)
	}

	if len(h.data.transactions) != 1 {
		t.Fatalf("履歴は1件のはず: got %d", len(h.data.transactions))
	}
	tr := h.data.transactions[0]
	if tr.Kind != domain.TransactionLendingCollected || tr.Amount != 5000 {
		t.Errorf("履歴が合わない: %+v", tr)
	}
	if tr.RefID == nil || *tr.RefID != l.ID {
		t.Errorf("RefID=%v want %v", tr.RefID, l.ID)
	}
}

// TestLendingUsecase_CollectExceedsOutstanding は H-2。
//
// 過回収はエラーになり、口座残高も取引履歴も変化しない。
// トランザクション境界が正しいことの検証にあたる。回収の可否判定より
// 先に残高を触る作りだと、ここで残高だけが動いて残る。
func TestLendingUsecase_CollectExceedsOutstanding(t *testing.T) {
	h := newHarness(t)
	account := h.seedAccount(t, "生活用", domain.AccountKindCash, 488000)
	l := h.seedLending(t, "友人A", 12000, 5000)

	_, err := h.lendings.Collect(h.ctx, l.ID, 8000, date(2026, time.July, 20), account.ID)
	if !errors.Is(err, domain.ErrCollectExceedsOutstanding) {
		t.Fatalf("err=%v want ErrCollectExceedsOutstanding", err)
	}

	if stored := h.lending(t, l.ID); stored.CollectedAmount != 5000 {
		t.Errorf("回収額が動いた: %d want 5000", stored.CollectedAmount)
	}
	if stored := h.account(t, account.ID); stored.Balance != 488000 {
		t.Errorf("残高が動いた: %d want 488000", stored.Balance)
	}
	if len(h.data.transactions) != 0 {
		t.Errorf("履歴が残っている: %d 件", len(h.data.transactions))
	}
}

// TestLendingUsecase_CollectRollsBackOnLateFailure は、口座の取得に
// 失敗したときに回収額の更新まで戻ることを確かめる。
//
// 立替の更新は成功したあとで失敗する経路。ここが戻らないと、
// 回収したのに残高が増えていない状態が残る。
func TestLendingUsecase_CollectRollsBackOnLateFailure(t *testing.T) {
	h := newHarness(t)
	l := h.seedLending(t, "友人A", 12000, 0)

	_, err := h.lendings.Collect(h.ctx, l.ID, 5000, date(2026, time.July, 20), uuid.New())
	if !errors.Is(err, usecase.ErrNotFound) {
		t.Fatalf("err=%v want usecase.ErrNotFound", err)
	}

	if stored := h.lending(t, l.ID); stored.CollectedAmount != 0 {
		t.Errorf("回収額が巻き戻っていない: %d want 0", stored.CollectedAmount)
	}
	if len(h.data.transactions) != 0 {
		t.Errorf("履歴が残っている: %d 件", len(h.data.transactions))
	}
}

func TestLendingUsecase_CollectNotFound(t *testing.T) {
	h := newHarness(t)
	account := h.seedAccount(t, "生活用", domain.AccountKindCash, 488000)

	_, err := h.lendings.Collect(h.ctx, uuid.New(), 5000, date(2026, time.July, 20), account.ID)
	if !errors.Is(err, usecase.ErrNotFound) {
		t.Errorf("err=%v want usecase.ErrNotFound", err)
	}
}

func TestLendingUsecase_List(t *testing.T) {
	h := newHarness(t)
	h.seedLending(t, "友人A", 5000, 0)
	h.seedLending(t, "友人B", 8000, 3000)
	h.seedLending(t, "友人C", 2000, 2000)

	all, err := h.lendings.List(h.ctx, false)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(all) != 3 {
		t.Errorf("全件は3件のはず: got %d", len(all))
	}

	outstanding, err := h.lendings.List(h.ctx, true)
	if err != nil {
		t.Fatalf("List(outstandingOnly): %v", err)
	}
	if len(outstanding) != 2 {
		t.Errorf("未回収は2件のはず: got %d", len(outstanding))
	}
}

func TestLendingUsecase_Delete(t *testing.T) {
	h := newHarness(t)
	l := h.seedLending(t, "友人A", 5000, 0)

	if err := h.lendings.Delete(h.ctx, l.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, ok := h.data.lendings[l.ID]; ok {
		t.Error("削除されていない")
	}

	if err := h.lendings.Delete(h.ctx, uuid.New()); !errors.Is(err, usecase.ErrNotFound) {
		t.Errorf("err=%v want usecase.ErrNotFound", err)
	}
}
