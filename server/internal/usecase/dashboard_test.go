package usecase_test

import (
	"testing"
	"time"

	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
)

// TestDashboardUsecase_ExcludesTerminalWishes は H-5。
// 完了・見送りのウィッシュは並べない（detailed-design 6.1）。
func TestDashboardUsecase_ExcludesTerminalWishes(t *testing.T) {
	h := newHarness(t)
	h.seedAccount(t, "生活用", domain.AccountKindCash, 900000)
	h.seedWish(t, "検討中", 100000, domain.WishConsidering)
	h.seedWish(t, "確定", 200000, domain.WishCommitted)
	h.seedWish(t, "完了", 300000, domain.WishDone)
	h.seedWish(t, "見送り", 400000, domain.WishDropped)

	got, err := h.dashboard.Get(h.ctx)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}

	if len(got.Wishes) != 2 {
		t.Fatalf("並べるのは2件のはず: got %d", len(got.Wishes))
	}
	for _, w := range got.Wishes {
		if w.Wish.Status.IsTerminal() {
			t.Errorf("終端状態が含まれている: %+v", w.Wish)
		}
	}

	// 控除されるのは committed のみ（不変条件3）。
	// 完了・見送りの金額が控除に混ざっていないこと。
	if got.Breakdown.Commitments != 200000 {
		t.Errorf("Commitments=%d want 200000", got.Breakdown.Commitments)
	}
}

// TestDashboardUsecase_ExcludesInvestment は、投資口座が実質資産に
// 混ざらないことを確かめる（不変条件1）。ここが壊れるとアプリの目的が消える。
func TestDashboardUsecase_ExcludesInvestment(t *testing.T) {
	h := newHarness(t)
	h.seedAccount(t, "生活用", domain.AccountKindCash, 910000)
	h.seedAccount(t, "証券", domain.AccountKindInvestment, 350000)
	h.seedLending(t, "友人A", 12000, 0)
	h.seedWish(t, "カメラ", 80000, domain.WishCommitted)

	got, err := h.dashboard.Get(h.ctx)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}

	if got.Breakdown.CashTotal != 910000 {
		t.Errorf("CashTotal=%d want 910000（投資が混ざっている）", got.Breakdown.CashTotal)
	}
	if got.Breakdown.OutstandingLendings != 12000 {
		t.Errorf("OutstandingLendings=%d want 12000", got.Breakdown.OutstandingLendings)
	}
	if got.Breakdown.Commitments != 80000 {
		t.Errorf("Commitments=%d want 80000", got.Breakdown.Commitments)
	}
	// 910000 + 12000 - 80000
	if got.NetAsset != 842000 {
		t.Errorf("NetAsset=%d want 842000", got.NetAsset)
	}
	// 投資は別枠の参考値。
	if got.InvestmentTotal != 350000 {
		t.Errorf("InvestmentTotal=%d want 350000", got.InvestmentTotal)
	}
}

// TestDashboardUsecase_ExcludesCollectedLendings は、回収済みの立替が
// 実質資産に足されないことを確かめる。
func TestDashboardUsecase_ExcludesCollectedLendings(t *testing.T) {
	h := newHarness(t)
	h.seedAccount(t, "生活用", domain.AccountKindCash, 500000)
	h.seedLending(t, "友人A", 12000, 12000) // 回収済み
	h.seedLending(t, "友人B", 8000, 3000)   // 一部回収

	got, err := h.dashboard.Get(h.ctx)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Breakdown.OutstandingLendings != 5000 {
		t.Errorf("OutstandingLendings=%d want 5000", got.Breakdown.OutstandingLendings)
	}
}

// TestDashboardUsecase_AverageSurplusAndMonths は、平均月間余剰と
// 到達見込みの算出を確かめる。
func TestDashboardUsecase_AverageSurplusAndMonths(t *testing.T) {
	h := newHarness(t)
	h.seedAccount(t, "生活用", domain.AccountKindCash, 100000)
	h.seedWish(t, "カメラ", 400000, domain.WishConsidering)

	// 直近3ヶ月の余剰は 100000 / 100000 / 100000。それより前は対象外。
	h.seedBalance(t, 2026, time.July, 300000, 200000)
	h.seedBalance(t, 2026, time.June, 300000, 200000)
	h.seedBalance(t, 2026, time.May, 300000, 200000)
	h.seedBalance(t, 2026, time.April, 900000, 0)

	got, err := h.dashboard.Get(h.ctx)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}

	if !got.HasAverageSurplus {
		t.Fatal("平均が算出できるはず")
	}
	if got.AverageSurplus != 100000 {
		t.Errorf("AverageSurplus=%d want 100000（4ヶ月目が混ざっている可能性）", got.AverageSurplus)
	}

	if len(got.Wishes) != 1 {
		t.Fatalf("1件のはず: got %d", len(got.Wishes))
	}
	w := got.Wishes[0]
	// 400000 - 100000
	if w.Shortfall != 300000 {
		t.Errorf("Shortfall=%d want 300000", w.Shortfall)
	}
	if !w.HasMonthsToReach || w.MonthsToReach != 3 {
		t.Errorf("MonthsToReach=%d ok=%v want 3, true", w.MonthsToReach, w.HasMonthsToReach)
	}
}

// TestDashboardUsecase_NoMonthsToReach は「算出不可」になる場合を確かめる。
//
// 月次収支が1件も無い、または余剰が 0 以下なら、到達見込みは出せない。
// ここで 0 や巨大な数を返すと、クライアントが「今月中に届く」と誤って表示する。
func TestDashboardUsecase_NoMonthsToReach(t *testing.T) {
	tests := []struct {
		name     string
		balances func(h *harness, t *testing.T)
	}{
		{
			name:     "月次収支が無い",
			balances: func(h *harness, t *testing.T) {},
		},
		{
			name: "余剰が0",
			balances: func(h *harness, t *testing.T) {
				h.seedBalance(t, 2026, time.July, 250000, 250000)
			},
		},
		{
			name: "赤字",
			balances: func(h *harness, t *testing.T) {
				h.seedBalance(t, 2026, time.July, 200000, 250000)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t)
			h.seedAccount(t, "生活用", domain.AccountKindCash, 100000)
			h.seedWish(t, "カメラ", 400000, domain.WishConsidering)
			tt.balances(h, t)

			got, err := h.dashboard.Get(h.ctx)
			if err != nil {
				t.Fatalf("Get: %v", err)
			}
			if len(got.Wishes) != 1 {
				t.Fatalf("1件のはず: got %d", len(got.Wishes))
			}
			if got.Wishes[0].HasMonthsToReach {
				t.Errorf("算出不可のはず: MonthsToReach=%d", got.Wishes[0].MonthsToReach)
			}
		})
	}
}

// TestDashboardUsecase_AlreadyReachable は、すでに手が届くウィッシュの
// 到達見込みが算出不可になることを確かめる。不足額が 0 以下のため。
func TestDashboardUsecase_AlreadyReachable(t *testing.T) {
	h := newHarness(t)
	h.seedAccount(t, "生活用", domain.AccountKindCash, 500000)
	h.seedWish(t, "本", 3000, domain.WishConsidering)
	h.seedBalance(t, 2026, time.July, 300000, 200000)

	got, err := h.dashboard.Get(h.ctx)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if len(got.Wishes) != 1 {
		t.Fatalf("1件のはず: got %d", len(got.Wishes))
	}
	if got.Wishes[0].Shortfall >= 0 {
		t.Errorf("不足額は負のはず: %d", got.Wishes[0].Shortfall)
	}
	if got.Wishes[0].HasMonthsToReach {
		t.Error("すでに届くので算出不可のはず")
	}
}

func TestDashboardUsecase_Empty(t *testing.T) {
	h := newHarness(t)

	got, err := h.dashboard.Get(h.ctx)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.NetAsset != 0 || got.InvestmentTotal != 0 {
		t.Errorf("すべて0のはず: %+v", got)
	}
	if got.HasAverageSurplus {
		t.Error("データが無いので算出不可のはず")
	}
	if got.Wishes == nil {
		t.Error("0件のときは nil ではなく空スライスを返すこと")
	}
}
