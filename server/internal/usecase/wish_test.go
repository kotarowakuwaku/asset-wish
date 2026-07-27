package usecase_test

import (
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
	"github.com/kotarowakuwaku/asset-wish/server/internal/usecase"
)

// TestWishUsecase_PayKeepsNetAsset は H-3。
//
// 支払いの前後で実質資産が変わらないこと。確定支出が控除から外れると
// 同時に、同額だけ口座残高が減るため、差し引きゼロになる。ここが崩れると
// 「支払った瞬間に資産が増えた（減った）」ように見える。
func TestWishUsecase_PayKeepsNetAsset(t *testing.T) {
	h := newHarness(t)
	account := h.seedAccount(t, "生活用", domain.AccountKindCash, 500000)
	w := h.seedWish(t, "カメラ", 80000, domain.WishCommitted)

	before := h.netAsset(t)

	paid, err := h.wishes.Pay(h.ctx, w.ID, account.ID, date(2026, time.July, 20))
	if err != nil {
		t.Fatalf("Pay: %v", err)
	}

	if paid.Status != domain.WishDone {
		t.Errorf("Status=%s want done", paid.Status)
	}
	if got := h.account(t, account.ID).Balance; got != 420000 {
		t.Errorf("残高=%d want 420000", got)
	}
	if got := h.wish(t, w.ID); got.IsCommitment() {
		t.Error("支払い後は確定支出から外れるはず")
	}

	after := h.netAsset(t)
	if after != before {
		t.Errorf("支払いの前後で実質資産が変わった: before=%d after=%d", before, after)
	}

	if len(h.data.transactions) != 1 {
		t.Fatalf("履歴は1件のはず: got %d", len(h.data.transactions))
	}
	tr := h.data.transactions[0]
	if tr.Kind != domain.TransactionWishPaid || tr.Amount != -80000 {
		t.Errorf("履歴が合わない: %+v", tr)
	}
	if tr.RefID == nil || *tr.RefID != w.ID {
		t.Errorf("RefID=%v want %v", tr.RefID, w.ID)
	}
}

// TestWishUsecase_PayInvalidTransition は H-4。
//
// 検討中のウィッシュは支払えない。エラーになり、副作用も残らない。
func TestWishUsecase_PayInvalidTransition(t *testing.T) {
	h := newHarness(t)
	account := h.seedAccount(t, "生活用", domain.AccountKindCash, 500000)

	for _, status := range []domain.WishStatus{
		domain.WishConsidering, domain.WishDone, domain.WishDropped,
	} {
		t.Run(string(status), func(t *testing.T) {
			w := h.seedWish(t, "カメラ", 80000, status)

			_, err := h.wishes.Pay(h.ctx, w.ID, account.ID, date(2026, time.July, 20))
			if !errors.Is(err, domain.ErrInvalidTransition) {
				t.Fatalf("err=%v want ErrInvalidTransition", err)
			}
			if got := h.wish(t, w.ID).Status; got != status {
				t.Errorf("状態が動いた: %s want %s", got, status)
			}
			if got := h.account(t, account.ID).Balance; got != 500000 {
				t.Errorf("残高が動いた: %d want 500000", got)
			}
			if len(h.data.transactions) != 0 {
				t.Errorf("履歴が残っている: %d 件", len(h.data.transactions))
			}
		})
	}
}

// TestWishUsecase_PayRollsBackOnUnknownAccount は、状態を進めたあとで
// 口座が見つからなかった場合に遷移ごと戻ることを確かめる。
func TestWishUsecase_PayRollsBackOnUnknownAccount(t *testing.T) {
	h := newHarness(t)
	w := h.seedWish(t, "カメラ", 80000, domain.WishCommitted)

	_, err := h.wishes.Pay(h.ctx, w.ID, uuid.New(), date(2026, time.July, 20))
	if !errors.Is(err, usecase.ErrNotFound) {
		t.Fatalf("err=%v want usecase.ErrNotFound", err)
	}
	if got := h.wish(t, w.ID).Status; got != domain.WishCommitted {
		t.Errorf("状態が巻き戻っていない: %s want committed", got)
	}
}

func TestWishUsecase_Transitions(t *testing.T) {
	tests := []struct {
		name       string
		from       domain.WishStatus
		transit    func(*usecase.WishUsecase, *harness, uuid.UUID) (domain.Wish, error)
		wantStatus domain.WishStatus
		wantErr    error
	}{
		{
			name: "検討中 → 確定",
			from: domain.WishConsidering,
			transit: func(u *usecase.WishUsecase, h *harness, id uuid.UUID) (domain.Wish, error) {
				return u.Commit(h.ctx, id)
			},
			wantStatus: domain.WishCommitted,
		},
		{
			name: "確定から再度 確定はできない",
			from: domain.WishCommitted,
			transit: func(u *usecase.WishUsecase, h *harness, id uuid.UUID) (domain.Wish, error) {
				return u.Commit(h.ctx, id)
			},
			wantStatus: domain.WishCommitted,
			wantErr:    domain.ErrInvalidTransition,
		},
		{
			name: "検討中 → 見送り",
			from: domain.WishConsidering,
			transit: func(u *usecase.WishUsecase, h *harness, id uuid.UUID) (domain.Wish, error) {
				return u.Drop(h.ctx, id)
			},
			wantStatus: domain.WishDropped,
		},
		{
			name: "確定 → 見送り",
			from: domain.WishCommitted,
			transit: func(u *usecase.WishUsecase, h *harness, id uuid.UUID) (domain.Wish, error) {
				return u.Drop(h.ctx, id)
			},
			wantStatus: domain.WishDropped,
		},
		{
			name: "完了からは見送れない",
			from: domain.WishDone,
			transit: func(u *usecase.WishUsecase, h *harness, id uuid.UUID) (domain.Wish, error) {
				return u.Drop(h.ctx, id)
			},
			wantStatus: domain.WishDone,
			wantErr:    domain.ErrInvalidTransition,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t)
			w := h.seedWish(t, "カメラ", 80000, tt.from)

			_, err := tt.transit(h.wishes, h, w.ID)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("err=%v want %v", err, tt.wantErr)
			}
			if got := h.wish(t, w.ID).Status; got != tt.wantStatus {
				t.Errorf("Status=%s want %s", got, tt.wantStatus)
			}
		})
	}
}

// TestWishUsecase_UpdateContentKeepsStatus は、内容の更新で状態が
// 動かないことを確かめる（不変条件6）。
func TestWishUsecase_UpdateContentKeepsStatus(t *testing.T) {
	h := newHarness(t)
	w := h.seedWish(t, "旅行", 120000, domain.WishCommitted)

	title := "旅行（行き先変更）"
	amount := domain.Money(150000)
	category := domain.WishCategoryExperience
	priority := 3

	got, err := h.wishes.UpdateContent(h.ctx, w.ID, usecase.UpdateWishInput{
		Title: &title, Amount: &amount, Category: &category, Priority: &priority,
	})
	if err != nil {
		t.Fatalf("UpdateContent: %v", err)
	}

	if got.Status != domain.WishCommitted {
		t.Errorf("戻り値の Status=%s want committed", got.Status)
	}
	stored := h.wish(t, w.ID)
	if stored.Status != domain.WishCommitted {
		t.Errorf("保存後の Status=%s want committed", stored.Status)
	}
	if stored.Title != title || stored.Amount != amount || stored.Category != category || stored.Priority != priority {
		t.Errorf("内容が反映されていない: %+v", stored)
	}
}

func TestWishUsecase_UpdateContentPartial(t *testing.T) {
	h := newHarness(t)
	deadline := date(2026, time.December, 31)
	w := h.seedWish(t, "カメラ", 120000, domain.WishConsidering)
	w.Deadline = &deadline
	h.data.wishes[w.ID] = w

	// 金額だけ変える。他は据え置き。
	amount := domain.Money(130000)
	got, err := h.wishes.UpdateContent(h.ctx, w.ID, usecase.UpdateWishInput{Amount: &amount})
	if err != nil {
		t.Fatalf("UpdateContent: %v", err)
	}
	if got.Title != "カメラ" || got.Priority != 1 {
		t.Errorf("指定していない項目が変わった: %+v", got)
	}
	if got.Deadline == nil || !got.Deadline.Equal(deadline) {
		t.Errorf("期限が変わった: %v", got.Deadline)
	}

	// 期限を外す。Deadline が nil であることと区別するため専用の指示を使う。
	got, err = h.wishes.UpdateContent(h.ctx, w.ID, usecase.UpdateWishInput{ClearDeadline: true})
	if err != nil {
		t.Fatalf("UpdateContent: %v", err)
	}
	if got.Deadline != nil {
		t.Errorf("期限が外れていない: %v", *got.Deadline)
	}
}

func TestWishUsecase_UpdateContentRejectsInvalid(t *testing.T) {
	h := newHarness(t)
	w := h.seedWish(t, "カメラ", 120000, domain.WishConsidering)

	empty := "  "
	zero := domain.Money(0)

	tests := []struct {
		name    string
		in      usecase.UpdateWishInput
		wantErr error
	}{
		{"タイトルが空", usecase.UpdateWishInput{Title: &empty}, domain.ErrEmptyTitle},
		{"金額0", usecase.UpdateWishInput{Amount: &zero}, domain.ErrInvalidAmount},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := h.wishes.UpdateContent(h.ctx, w.ID, tt.in); !errors.Is(err, tt.wantErr) {
				t.Fatalf("err=%v want %v", err, tt.wantErr)
			}
			if stored := h.wish(t, w.ID); stored.Title != "カメラ" || stored.Amount != 120000 {
				t.Errorf("失敗時に内容が書き換わっている: %+v", stored)
			}
		})
	}
}

func TestWishUsecase_Create(t *testing.T) {
	h := newHarness(t)

	w, err := h.wishes.Create(h.ctx, "カメラ", 120000, domain.WishCategoryItem, 2, nil)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	// 新規は必ず検討中から始まる。いきなり確定にはしない（不変条件3）。
	if w.Status != domain.WishConsidering {
		t.Errorf("Status=%s want considering", w.Status)
	}
	if h.wish(t, w.ID).Amount != 120000 {
		t.Error("保存されていない")
	}

	if _, err := h.wishes.Create(h.ctx, "", 120000, domain.WishCategoryItem, 0, nil); !errors.Is(err, domain.ErrEmptyTitle) {
		t.Errorf("err=%v want ErrEmptyTitle", err)
	}
	if _, err := h.wishes.Create(h.ctx, "本", 0, domain.WishCategoryItem, 0, nil); !errors.Is(err, domain.ErrInvalidAmount) {
		t.Errorf("err=%v want ErrInvalidAmount", err)
	}
	if _, err := h.wishes.Create(h.ctx, "本", 100, domain.WishCategory("misc"), 0, nil); !errors.Is(err, domain.ErrInvalidWishCategory) {
		t.Errorf("err=%v want ErrInvalidWishCategory", err)
	}
}

func TestWishUsecase_ListByStatus(t *testing.T) {
	h := newHarness(t)
	h.seedWish(t, "A", 1000, domain.WishConsidering)
	h.seedWish(t, "B", 2000, domain.WishCommitted)
	h.seedWish(t, "C", 3000, domain.WishCommitted)

	all, err := h.wishes.List(h.ctx, nil)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(all) != 3 {
		t.Errorf("全件は3件のはず: got %d", len(all))
	}

	committed := domain.WishCommitted
	got, err := h.wishes.List(h.ctx, &committed)
	if err != nil {
		t.Fatalf("List(committed): %v", err)
	}
	if len(got) != 2 {
		t.Errorf("committed は2件のはず: got %d", len(got))
	}
}

func TestWishUsecase_Delete(t *testing.T) {
	h := newHarness(t)
	w := h.seedWish(t, "カメラ", 120000, domain.WishConsidering)

	if err := h.wishes.Delete(h.ctx, w.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, ok := h.data.wishes[w.ID]; ok {
		t.Error("削除されていない")
	}
	if err := h.wishes.Delete(h.ctx, uuid.New()); !errors.Is(err, usecase.ErrNotFound) {
		t.Errorf("err=%v want usecase.ErrNotFound", err)
	}
}
