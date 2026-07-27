package usecase_test

import (
	"errors"
	"testing"
	"time"

	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
)

func yearMonth(t *testing.T, year int, month time.Month) domain.YearMonth {
	t.Helper()

	ym, err := domain.NewYearMonth(year, month)
	if err != nil {
		t.Fatalf("NewYearMonth: %v", err)
	}
	return ym
}

// TestMonthlyBalanceUsecase_UpsertIsIdempotent は、同じ月への再登録が
// 上書きになることを確かめる（design.md 4.3）。
//
// 既存行の ID が返ることも見る。採番した ID をそのまま返すと、
// DB に存在しない ID をレスポンスに載せることになる。
func TestMonthlyBalanceUsecase_UpsertIsIdempotent(t *testing.T) {
	h := newHarness(t)
	ym := yearMonth(t, 2026, time.July)

	first, err := h.balances.Upsert(h.ctx, ym, 320000, 255000)
	if err != nil {
		t.Fatalf("Upsert: %v", err)
	}
	if first.Surplus() != 65000 {
		t.Errorf("Surplus()=%d want 65000", first.Surplus())
	}

	second, err := h.balances.Upsert(h.ctx, ym, 310000, 240000)
	if err != nil {
		t.Fatalf("Upsert: %v", err)
	}
	if second.ID != first.ID {
		t.Errorf("既存の ID が返るはず: got %v want %v", second.ID, first.ID)
	}
	if second.Income != 310000 || second.Expense != 240000 {
		t.Errorf("上書きされていない: %+v", second)
	}

	all, err := h.balances.List(h.ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(all) != 1 {
		t.Errorf("同じ月は1件に集約されるはず: got %d", len(all))
	}
}

func TestMonthlyBalanceUsecase_UpsertRejectsNegative(t *testing.T) {
	h := newHarness(t)
	ym := yearMonth(t, 2026, time.July)

	tests := []struct {
		name    string
		income  domain.Money
		expense domain.Money
	}{
		{"収入が負", -1, 0},
		{"支出が負", 0, -1},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := h.balances.Upsert(h.ctx, ym, tt.income, tt.expense); !errors.Is(err, domain.ErrNegativeAmount) {
				t.Fatalf("err=%v want ErrNegativeAmount", err)
			}
			if len(h.data.balances) != 0 {
				t.Errorf("失敗したのに保存されている: %d 件", len(h.data.balances))
			}
		})
	}
}

// TestMonthlyBalanceUsecase_UpsertRejectsZeroYearMonth は、未初期化の
// 年月を弾くことを確かめる。ゼロ値のまま保存されると、DB では
// 0001-01-01 という無意味な月になる。
func TestMonthlyBalanceUsecase_UpsertRejectsZeroYearMonth(t *testing.T) {
	h := newHarness(t)

	if _, err := h.balances.Upsert(h.ctx, domain.YearMonth{}, 0, 0); !errors.Is(err, domain.ErrInvalidYearMonth) {
		t.Fatalf("err=%v want ErrInvalidYearMonth", err)
	}
}

// TestMonthlyBalanceUsecase_ListIsDescending は年月の降順を確かめる。
func TestMonthlyBalanceUsecase_ListIsDescending(t *testing.T) {
	h := newHarness(t)

	for _, m := range []time.Month{time.May, time.July, time.April, time.June} {
		if _, err := h.balances.Upsert(h.ctx, yearMonth(t, 2026, m), 300000, 250000); err != nil {
			t.Fatalf("Upsert: %v", err)
		}
	}

	got, err := h.balances.List(h.ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	want := []string{"2026-07", "2026-06", "2026-05", "2026-04"}
	if len(got) != len(want) {
		t.Fatalf("%d 件のはず: got %d", len(want), len(got))
	}
	for i, w := range want {
		if got[i].YearMonth.String() != w {
			t.Errorf("%d番目=%s want %s", i, got[i].YearMonth, w)
		}
	}
}
