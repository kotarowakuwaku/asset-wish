package repository_test

import (
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/kotarowakuwaku/asset-wish/server/internal/adapter/repository"
	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
	"github.com/kotarowakuwaku/asset-wish/server/internal/usecase"
)

func TestLendingRepository_CreateAndGet(t *testing.T) {
	store, _, ctx := newStore(t)
	repo := repository.NewLendingRepository(store)

	want := newLending(t, "友人A", 12000)
	if err := repo.Create(ctx, want); err != nil {
		t.Fatalf("Create: %v", err)
	}

	got, err := repo.Get(ctx, want.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}

	if got.ID != want.ID || got.Counterparty != want.Counterparty || got.Description != want.Description {
		t.Errorf("往復で値が変わった: got %+v want %+v", got, want)
	}
	if got.Amount != want.Amount || got.CollectedAmount != 0 {
		t.Errorf("金額が合わない: got %+v", got)
	}
	if !got.OccurredOn.Equal(want.OccurredOn) {
		t.Errorf("OccurredOn=%v want %v", got.OccurredOn, want.OccurredOn)
	}

	// 回収状態は列を持たず金額から導出する（不変条件12）。
	// 復元後もそれが成り立つこと。
	if got.Outstanding() != 12000 {
		t.Errorf("Outstanding()=%d want 12000", got.Outstanding())
	}
	if got.Status() != domain.CollectionUncollected {
		t.Errorf("Status()=%s want uncollected", got.Status())
	}
}

func TestLendingRepository_GetNotFound(t *testing.T) {
	store, _, ctx := newStore(t)
	repo := repository.NewLendingRepository(store)

	if _, err := repo.Get(ctx, uuid.New()); !errors.Is(err, usecase.ErrNotFound) {
		t.Errorf("err=%v want usecase.ErrNotFound", err)
	}
}

// TestLendingRepository_UpdateCollected は、回収額の反映で立替額が
// 動かないことを確かめる。
//
// amount が動くと未回収残高（amount - collected_amount）の意味が
// 変わる（不変条件4）。更新できる範囲を回収額だけに絞った設計が
// 保たれているかを見る。
func TestLendingRepository_UpdateCollected(t *testing.T) {
	store, _, ctx := newStore(t)
	repo := repository.NewLendingRepository(store)

	l := newLending(t, "友人A", 12000)
	if err := repo.Create(ctx, l); err != nil {
		t.Fatalf("Create: %v", err)
	}

	if err := l.Collect(5000); err != nil {
		t.Fatalf("Collect: %v", err)
	}
	// ドメイン側で立替額を書き換えても DB には効かない。
	l.Amount = 999999
	if err := repo.UpdateCollected(ctx, l); err != nil {
		t.Fatalf("UpdateCollected: %v", err)
	}

	got, err := repo.Get(ctx, l.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Amount != 12000 {
		t.Errorf("立替額が変わってはならない: got %d want 12000", got.Amount)
	}
	if got.CollectedAmount != 5000 {
		t.Errorf("CollectedAmount=%d want 5000", got.CollectedAmount)
	}
	if got.Outstanding() != 7000 {
		t.Errorf("Outstanding()=%d want 7000", got.Outstanding())
	}
	if got.Status() != domain.CollectionPartial {
		t.Errorf("Status()=%s want partial", got.Status())
	}
}

// TestLendingRepository_UpdateCollectedRejectsOverCollection は、domain の
// 判定を通さずに過回収の値を書こうとすると DB が拒むことを確かめる。
//
// 過回収を弾く責務は domain.Lending.Collect にあるが、そこを通らない
// 経路が生まれたときの最後の防波堤が CHECK 制約になる（不変条件4）。
func TestLendingRepository_UpdateCollectedRejectsOverCollection(t *testing.T) {
	store, _, ctx := newStore(t)
	repo := repository.NewLendingRepository(store)

	l := newLending(t, "友人A", 12000)
	if err := repo.Create(ctx, l); err != nil {
		t.Fatalf("Create: %v", err)
	}

	l.CollectedAmount = 12001 // domain の Collect を通さずに壊した値
	if err := repo.UpdateCollected(ctx, l); err == nil {
		t.Error("過回収が書き込めてしまった。CHECK 制約が効いていない")
	}
}

func TestLendingRepository_ListOutstandingOnly(t *testing.T) {
	store, _, ctx := newStore(t)
	repo := repository.NewLendingRepository(store)

	uncollected := newLending(t, "友人A", 5000)
	partial := newLending(t, "友人B", 8000)
	collected := newLending(t, "友人C", 2000)

	for _, l := range []domain.Lending{uncollected, partial, collected} {
		if err := repo.Create(ctx, l); err != nil {
			t.Fatalf("Create: %v", err)
		}
	}

	if err := partial.Collect(3000); err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if err := repo.UpdateCollected(ctx, partial); err != nil {
		t.Fatalf("UpdateCollected: %v", err)
	}
	if err := collected.Collect(2000); err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if err := repo.UpdateCollected(ctx, collected); err != nil {
		t.Fatalf("UpdateCollected: %v", err)
	}

	all, err := repo.List(ctx, false)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(all) != 3 {
		t.Errorf("全件は3件のはず: got %d", len(all))
	}

	outstanding, err := repo.List(ctx, true)
	if err != nil {
		t.Fatalf("List(outstandingOnly): %v", err)
	}
	if len(outstanding) != 2 {
		t.Fatalf("未回収は2件のはず: got %d", len(outstanding))
	}
	for _, l := range outstanding {
		if l.IsFullyCollected() {
			t.Errorf("回収済みが混ざっている: %+v", l)
		}
	}
}

func TestLendingRepository_Delete(t *testing.T) {
	store, _, ctx := newStore(t)
	repo := repository.NewLendingRepository(store)

	l := newLending(t, "友人A", 5000)
	if err := repo.Create(ctx, l); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := repo.Delete(ctx, l.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := repo.Get(ctx, l.ID); !errors.Is(err, usecase.ErrNotFound) {
		t.Errorf("削除後の Get は ErrNotFound のはず: %v", err)
	}
}
