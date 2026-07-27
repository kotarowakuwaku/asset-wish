package repository_test

import (
	"testing"
	"time"

	"github.com/kotarowakuwaku/asset-wish/server/internal/adapter/repository"
	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
)

// TestMonthlyBalanceRepository_UpsertRoundTrip は YearMonth の往復を確かめる。
//
// DB では月初日の DATE として持つ（design.md 2.3）。時刻やタイムゾーンが
// 混ざると月がずれるため、往復して同じ年月に戻ることを見る。
func TestMonthlyBalanceRepository_UpsertRoundTrip(t *testing.T) {
	store, _, ctx := newStore(t)
	repo := repository.NewMonthlyBalanceRepository(store)

	want := newMonthlyBalance(t, 2026, time.July, 320000, 255000)
	saved, err := repo.Upsert(ctx, want)
	if err != nil {
		t.Fatalf("Upsert: %v", err)
	}
	if saved.ID != want.ID {
		t.Errorf("新規なら渡した ID が使われるはず: got %v want %v", saved.ID, want.ID)
	}

	all, err := repo.ListAll(ctx)
	if err != nil {
		t.Fatalf("ListAll: %v", err)
	}
	if len(all) != 1 {
		t.Fatalf("1件のはず: got %d", len(all))
	}

	got := all[0]
	if !got.YearMonth.Equal(want.YearMonth) {
		t.Errorf("YearMonth=%s want %s", got.YearMonth, want.YearMonth)
	}
	if got.Income != 320000 || got.Expense != 255000 {
		t.Errorf("金額が合わない: %+v", got)
	}
	// 月間余剰は導出値。復元後も計算できること。
	if got.Surplus() != 65000 {
		t.Errorf("Surplus()=%d want 65000", got.Surplus())
	}
}

// TestMonthlyBalanceRepository_UpsertKeepsExistingID は、同じ月への
// 再登録で既存の ID が返ることを確かめる。
//
// ON CONFLICT DO UPDATE は既存行の ID を維持するため、呼び出し側が
// 採番した ID は捨てられる。Upsert が保存後の姿を返さないと、DB に
// 存在しない ID を持ったまま処理が進む。
func TestMonthlyBalanceRepository_UpsertKeepsExistingID(t *testing.T) {
	store, _, ctx := newStore(t)
	repo := repository.NewMonthlyBalanceRepository(store)

	first := newMonthlyBalance(t, 2026, time.July, 320000, 255000)
	if _, err := repo.Upsert(ctx, first); err != nil {
		t.Fatalf("Upsert: %v", err)
	}

	second := newMonthlyBalance(t, 2026, time.July, 310000, 240000)
	saved, err := repo.Upsert(ctx, second)
	if err != nil {
		t.Fatalf("Upsert: %v", err)
	}

	if saved.ID != first.ID {
		t.Errorf("既存行の ID が返るはず: got %v want %v", saved.ID, first.ID)
	}
	if saved.Income != 310000 || saved.Expense != 240000 {
		t.Errorf("上書きした値が返るはず: %+v", saved)
	}

	all, err := repo.ListAll(ctx)
	if err != nil {
		t.Fatalf("ListAll: %v", err)
	}
	if len(all) != 1 {
		t.Fatalf("同じ月は1件に集約されるはず: got %d", len(all))
	}
	if all[0].ID != first.ID || all[0].Income != 310000 {
		t.Errorf("保存された姿と返り値が食い違う: %+v", all[0])
	}
}

// TestMonthlyBalanceRepository_ListRecent は降順と件数制限を確かめる。
// 平均月間余剰は直近 N ヶ月から出すため、順序が狂うと対象月がずれる。
func TestMonthlyBalanceRepository_ListRecent(t *testing.T) {
	store, _, ctx := newStore(t)
	repo := repository.NewMonthlyBalanceRepository(store)

	// 登録順と年月の順序をわざとずらす。
	for _, m := range []domain.MonthlyBalance{
		newMonthlyBalance(t, 2026, time.May, 300000, 250000),
		newMonthlyBalance(t, 2026, time.July, 320000, 255000),
		newMonthlyBalance(t, 2026, time.April, 290000, 260000),
		newMonthlyBalance(t, 2026, time.June, 310000, 240000),
	} {
		if _, err := repo.Upsert(ctx, m); err != nil {
			t.Fatalf("Upsert: %v", err)
		}
	}

	got, err := repo.ListRecent(ctx, 3)
	if err != nil {
		t.Fatalf("ListRecent: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("3件のはず: got %d", len(got))
	}

	want := []string{"2026-07", "2026-06", "2026-05"}
	for i, w := range want {
		if got[i].YearMonth.String() != w {
			t.Errorf("%d番目=%s want %s", i, got[i].YearMonth, w)
		}
	}

	// 件数が足りない場合はある分だけ返る。
	few, err := repo.ListRecent(ctx, 10)
	if err != nil {
		t.Fatalf("ListRecent: %v", err)
	}
	if len(few) != 4 {
		t.Errorf("4件のはず: got %d", len(few))
	}
}

// TestMonthlyBalanceRepository_ListRecentNonPositiveLimit は、limit が
// 0 以下でも壊れないことを確かめる。全件相当に丸める。
func TestMonthlyBalanceRepository_ListRecentNonPositiveLimit(t *testing.T) {
	store, _, ctx := newStore(t)
	repo := repository.NewMonthlyBalanceRepository(store)

	if _, err := repo.Upsert(ctx, newMonthlyBalance(t, 2026, time.July, 320000, 255000)); err != nil {
		t.Fatalf("Upsert: %v", err)
	}

	for _, limit := range []int{0, -1} {
		got, err := repo.ListRecent(ctx, limit)
		if err != nil {
			t.Fatalf("ListRecent(%d): %v", limit, err)
		}
		if len(got) != 1 {
			t.Errorf("ListRecent(%d) は全件相当に丸める: got %d", limit, len(got))
		}
	}
}

func TestMonthlyBalanceRepository_ListEmpty(t *testing.T) {
	store, _, ctx := newStore(t)
	repo := repository.NewMonthlyBalanceRepository(store)

	all, err := repo.ListAll(ctx)
	if err != nil {
		t.Fatalf("ListAll: %v", err)
	}
	if all == nil {
		t.Error("0件のときは nil ではなく空スライスを返すこと")
	}

	recent, err := repo.ListRecent(ctx, 3)
	if err != nil {
		t.Fatalf("ListRecent: %v", err)
	}
	if recent == nil {
		t.Error("0件のときは nil ではなく空スライスを返すこと")
	}
}
