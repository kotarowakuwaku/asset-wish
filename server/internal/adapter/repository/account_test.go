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

func TestAccountRepository_CreateAndGet(t *testing.T) {
	store, _, ctx := newStore(t)
	repo := repository.NewAccountRepository(store)

	want := newAccount(t, "生活用", domain.AccountKindCash, 500000)
	if err := repo.Create(ctx, want); err != nil {
		t.Fatalf("Create: %v", err)
	}

	got, err := repo.Get(ctx, want.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}

	if got.ID != want.ID || got.Name != want.Name || got.Kind != want.Kind {
		t.Errorf("往復で値が変わった: got %+v want %+v", got, want)
	}
	if got.Balance != want.Balance {
		t.Errorf("Balance=%d want %d", got.Balance, want.Balance)
	}
	if !got.UpdatedAt.Equal(want.UpdatedAt) {
		t.Errorf("UpdatedAt=%v want %v", got.UpdatedAt, want.UpdatedAt)
	}
	// 投資口座かどうかの判定がドメイン型として復元できていること（不変条件1）。
	if !got.CountsTowardNetAsset() {
		t.Error("cash は実質資産に算入されるはず")
	}
}

func TestAccountRepository_GetNotFound(t *testing.T) {
	store, _, ctx := newStore(t)
	repo := repository.NewAccountRepository(store)

	_, err := repo.Get(ctx, uuid.New())
	if !errors.Is(err, usecase.ErrNotFound) {
		t.Errorf("err=%v want usecase.ErrNotFound", err)
	}
}

// TestAccountRepository_UpdateKeepsKind は、更新で口座種別が動かないことを
// 確かめる。
//
// kind が cash から investment に変わると、その口座は実質資産の計算から
// 丸ごと外れる（不変条件1）。Update に kind を渡さない設計が、あとで
// 崩されていないかを見張る。
func TestAccountRepository_UpdateKeepsKind(t *testing.T) {
	store, _, ctx := newStore(t)
	repo := repository.NewAccountRepository(store)

	a := newAccount(t, "生活用", domain.AccountKindCash, 500000)
	if err := repo.Create(ctx, a); err != nil {
		t.Fatalf("Create: %v", err)
	}

	// ドメイン側で種別を書き換えたうえで保存しても、DB には効かない。
	a.Kind = domain.AccountKindInvestment
	a.Name = "生活用（改名）"
	a.UpdateBalance(450000, date(2026, time.July, 2))
	if err := repo.Update(ctx, a); err != nil {
		t.Fatalf("Update: %v", err)
	}

	got, err := repo.Get(ctx, a.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Kind != domain.AccountKindCash {
		t.Errorf("Update で kind が変わってはならない: got %q", got.Kind)
	}
	if got.Name != "生活用（改名）" || got.Balance != 450000 {
		t.Errorf("名称と残高は反映されるはず: %+v", got)
	}
	if !got.UpdatedAt.Equal(date(2026, time.July, 2)) {
		t.Errorf("UpdatedAt=%v want %v", got.UpdatedAt, date(2026, time.July, 2))
	}
}

func TestAccountRepository_List(t *testing.T) {
	store, _, ctx := newStore(t)
	repo := repository.NewAccountRepository(store)

	empty, err := repo.List(ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if empty == nil {
		t.Error("0件のときは nil ではなく空スライスを返すこと")
	}
	if len(empty) != 0 {
		t.Errorf("0件のはず: got %d", len(empty))
	}

	for _, a := range []domain.Account{
		newAccount(t, "生活用", domain.AccountKindCash, 500000),
		newAccount(t, "証券", domain.AccountKindInvestment, 350000),
	} {
		if err := repo.Create(ctx, a); err != nil {
			t.Fatalf("Create: %v", err)
		}
	}

	got, err := repo.List(ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("2件のはず: got %d", len(got))
	}

	// 実質資産に算入するのは cash のみ（不変条件1）。
	// 絞り込みは domain の責務なので、ここでは両方返ることだけ確かめる。
	var cash, investment int
	for _, a := range got {
		if a.CountsTowardNetAsset() {
			cash++
		} else {
			investment++
		}
	}
	if cash != 1 || investment != 1 {
		t.Errorf("cash=%d investment=%d want 1, 1", cash, investment)
	}
}

func TestAccountRepository_Delete(t *testing.T) {
	store, _, ctx := newStore(t)
	repo := repository.NewAccountRepository(store)

	a := newAccount(t, "予備", domain.AccountKindCash, 0)
	if err := repo.Create(ctx, a); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := repo.Delete(ctx, a.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}

	if _, err := repo.Get(ctx, a.ID); !errors.Is(err, usecase.ErrNotFound) {
		t.Errorf("削除後の Get は ErrNotFound のはず: %v", err)
	}
}

// TestAccountRepository_RejectsBrokenKind は、DB に壊れた値が入っていた
// ときにドメイン層へ渡さないことを確かめる。
//
// CHECK 制約があるので通常は起きないが、この検証は最後の関門にあたる
// （detailed-design 4.1）。制約を外して壊れた行を作り、Get が error に
// なることを見る。
func TestAccountRepository_RejectsBrokenKind(t *testing.T) {
	store, conn, ctx := newStore(t)
	repo := repository.NewAccountRepository(store)

	if _, err := conn.Exec(`ALTER TABLE accounts DROP CONSTRAINT accounts_kind_check`); err != nil {
		t.Fatalf("CHECK 制約の解除に失敗（制約名が変わった可能性）: %v", err)
	}

	id := uuid.New()
	if _, err := conn.Exec(
		`INSERT INTO accounts (id, name, kind, balance, updated_at)
		 VALUES ($1, '壊れた口座', 'crypto', 1, now())`, id); err != nil {
		t.Fatalf("壊れた行の作成に失敗: %v", err)
	}

	if _, err := repo.Get(ctx, id); err == nil {
		t.Error("不正な kind がそのままドメイン層へ渡ってしまった")
	}

	if _, err := repo.List(ctx); err == nil {
		t.Error("List も不正な kind を弾くこと")
	}
}
