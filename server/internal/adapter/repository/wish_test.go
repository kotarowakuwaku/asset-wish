package repository_test

import (
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/kotarowakuwaku/asset-wish/server/internal/adapter/repository"
	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
	"github.com/kotarowakuwaku/asset-wish/server/internal/usecase"
)

// TestWishRepository_DeadlineRoundTrip は deadline の NULL 往復を確かめる。
// *time.Time と sql.NullTime の変換は取り違えても型では落ちない。
func TestWishRepository_DeadlineRoundTrip(t *testing.T) {
	store, _, ctx := newStore(t)
	repo := repository.NewWishRepository(store)

	deadline := date(2026, time.December, 31)

	tests := []struct {
		name     string
		deadline *time.Time
	}{
		{name: "期限あり", deadline: &deadline},
		{name: "期限なし", deadline: nil},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := newWish(t, "旅行", 120000, tt.deadline)
			if err := repo.Create(ctx, w); err != nil {
				t.Fatalf("Create: %v", err)
			}

			got, err := repo.Get(ctx, w.ID)
			if err != nil {
				t.Fatalf("Get: %v", err)
			}

			switch {
			case tt.deadline == nil && got.Deadline != nil:
				t.Errorf("期限なしのはずが %v", *got.Deadline)
			case tt.deadline != nil && got.Deadline == nil:
				t.Error("期限ありのはずが nil")
			case tt.deadline != nil && !got.Deadline.Equal(*tt.deadline):
				t.Errorf("Deadline=%v want %v", *got.Deadline, *tt.deadline)
			}
		})
	}
}

func TestWishRepository_CreateAndGet(t *testing.T) {
	store, _, ctx := newStore(t)
	repo := repository.NewWishRepository(store)

	want := newWish(t, "カメラ", 120000, nil)
	if err := repo.Create(ctx, want); err != nil {
		t.Fatalf("Create: %v", err)
	}

	got, err := repo.Get(ctx, want.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.ID != want.ID || got.Title != want.Title || got.Amount != want.Amount {
		t.Errorf("往復で値が変わった: got %+v want %+v", got, want)
	}
	if got.Category != domain.WishCategoryItem || got.Priority != 1 {
		t.Errorf("category / priority が合わない: %+v", got)
	}
	// 新規は検討中から始まる。確定支出として控除されるのは committed のみ（不変条件3）。
	if got.Status != domain.WishConsidering {
		t.Errorf("Status=%s want considering", got.Status)
	}
	if got.IsCommitment() {
		t.Error("considering は確定支出ではない")
	}
}

func TestWishRepository_GetNotFound(t *testing.T) {
	store, _, ctx := newStore(t)
	repo := repository.NewWishRepository(store)

	if _, err := repo.Get(ctx, uuid.New()); !errors.Is(err, usecase.ErrNotFound) {
		t.Errorf("err=%v want usecase.ErrNotFound", err)
	}
}

// TestWishRepository_UpdateContentKeepsStatus は、内容の更新が状態を
// 巻き込まないことを確かめる。
//
// 内容更新の経路から status を書けると、遷移の可否を判定する
// domain.Wish のメソッドを迂回できる（不変条件6）。
func TestWishRepository_UpdateContentKeepsStatus(t *testing.T) {
	store, _, ctx := newStore(t)
	repo := repository.NewWishRepository(store)

	w := newWish(t, "旅行", 120000, nil)
	if err := repo.Create(ctx, w); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := w.Commit(); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if err := repo.UpdateStatus(ctx, w); err != nil {
		t.Fatalf("UpdateStatus: %v", err)
	}

	// ドメイン側で状態を壊してから内容だけ更新する。
	w.Status = domain.WishDone
	w.Title = "旅行（行き先変更）"
	w.Amount = 150000
	w.Priority = 3
	if err := repo.UpdateContent(ctx, w); err != nil {
		t.Fatalf("UpdateContent: %v", err)
	}

	got, err := repo.Get(ctx, w.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Status != domain.WishCommitted {
		t.Errorf("内容の更新で status が変わってはならない: got %s", got.Status)
	}
	if got.Title != "旅行（行き先変更）" || got.Amount != 150000 || got.Priority != 3 {
		t.Errorf("内容が反映されていない: %+v", got)
	}
}

// TestWishRepository_UpdateStatusKeepsContent は、状態遷移が内容を
// 巻き込まないことを確かめる。
func TestWishRepository_UpdateStatusKeepsContent(t *testing.T) {
	store, _, ctx := newStore(t)
	repo := repository.NewWishRepository(store)

	w := newWish(t, "旅行", 120000, nil)
	if err := repo.Create(ctx, w); err != nil {
		t.Fatalf("Create: %v", err)
	}

	if err := w.Commit(); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	// ドメイン側で内容を書き換えてから状態だけ更新する。
	w.Title = "書き換わってはいけない"
	w.Amount = 1
	if err := repo.UpdateStatus(ctx, w); err != nil {
		t.Fatalf("UpdateStatus: %v", err)
	}

	got, err := repo.Get(ctx, w.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Status != domain.WishCommitted {
		t.Errorf("Status=%s want committed", got.Status)
	}
	if got.Title != "旅行" || got.Amount != 120000 {
		t.Errorf("状態の更新で内容が巻き込まれている: %+v", got)
	}
	// committed は確定支出として実質資産から控除される（不変条件3）。
	if !got.IsCommitment() {
		t.Error("committed は確定支出のはず")
	}
}

func TestWishRepository_ListByStatus(t *testing.T) {
	store, _, ctx := newStore(t)
	repo := repository.NewWishRepository(store)

	for i, status := range []domain.WishStatus{
		domain.WishConsidering, domain.WishCommitted, domain.WishCommitted, domain.WishDone,
	} {
		w := newWish(t, "ウィッシュ", domain.Money(10000*(i+1)), nil)
		if err := repo.Create(ctx, w); err != nil {
			t.Fatalf("Create: %v", err)
		}
		if status != domain.WishConsidering {
			w.Status = status
			if err := repo.UpdateStatus(ctx, w); err != nil {
				t.Fatalf("UpdateStatus: %v", err)
			}
		}
	}

	all, err := repo.List(ctx, nil)
	if err != nil {
		t.Fatalf("List(nil): %v", err)
	}
	if len(all) != 4 {
		t.Errorf("全件は4件のはず: got %d", len(all))
	}

	committed := domain.WishCommitted
	got, err := repo.List(ctx, &committed)
	if err != nil {
		t.Fatalf("List(committed): %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("committed は2件のはず: got %d", len(got))
	}
	for _, w := range got {
		if !w.IsCommitment() {
			t.Errorf("committed 以外が混ざっている: %+v", w)
		}
	}

	dropped := domain.WishDropped
	none, err := repo.List(ctx, &dropped)
	if err != nil {
		t.Fatalf("List(dropped): %v", err)
	}
	if none == nil {
		t.Error("0件のときは nil ではなく空スライスを返すこと")
	}
	if len(none) != 0 {
		t.Errorf("dropped は0件のはず: got %d", len(none))
	}
}

func TestWishRepository_Delete(t *testing.T) {
	store, _, ctx := newStore(t)
	repo := repository.NewWishRepository(store)

	w := newWish(t, "カメラ", 120000, nil)
	if err := repo.Create(ctx, w); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := repo.Delete(ctx, w.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := repo.Get(ctx, w.ID); !errors.Is(err, usecase.ErrNotFound) {
		t.Errorf("削除後の Get は ErrNotFound のはず: %v", err)
	}
}

// TestWishRepository_RejectsBrokenStatus は、DB に壊れた状態が入っていた
// ときにドメイン層へ渡さないことを確かめる（detailed-design 4.1）。
func TestWishRepository_RejectsBrokenStatus(t *testing.T) {
	store, conn, ctx := newStore(t)
	repo := repository.NewWishRepository(store)

	if _, err := conn.Exec(`ALTER TABLE wishes DROP CONSTRAINT wishes_status_check`); err != nil {
		t.Fatalf("CHECK 制約の解除に失敗（制約名が変わった可能性）: %v", err)
	}

	id := uuid.New()
	if _, err := conn.Exec(
		`INSERT INTO wishes (id, title, amount, category, status, priority)
		 VALUES ($1, '壊れたウィッシュ', 1000, 'item', 'archived', 0)`, id); err != nil {
		t.Fatalf("壊れた行の作成に失敗: %v", err)
	}

	if _, err := repo.Get(ctx, id); err == nil {
		t.Error("不正な status がそのままドメイン層へ渡ってしまった")
	}
}
