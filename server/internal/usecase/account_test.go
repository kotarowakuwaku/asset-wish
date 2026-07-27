package usecase_test

import (
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
	"github.com/kotarowakuwaku/asset-wish/server/internal/usecase"
)

func TestAccountUsecase_Create(t *testing.T) {
	h := newHarness(t)

	a, err := h.accounts.Create(h.ctx, "生活用", domain.AccountKindCash, 500000)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if a.Kind != domain.AccountKindCash || a.Balance != 500000 {
		t.Errorf("値が合わない: %+v", a)
	}
	if !a.UpdatedAt.Equal(fixedNow) {
		t.Errorf("UpdatedAt=%v want %v", a.UpdatedAt, fixedNow)
	}

	if _, err := h.accounts.Create(h.ctx, "  ", domain.AccountKindCash, 0); !errors.Is(err, domain.ErrEmptyTitle) {
		t.Errorf("err=%v want ErrEmptyTitle", err)
	}
	if _, err := h.accounts.Create(h.ctx, "謎", domain.AccountKind("crypto"), 0); !errors.Is(err, domain.ErrInvalidAccountKind) {
		t.Errorf("err=%v want ErrInvalidAccountKind", err)
	}
}

// TestAccountUsecase_UpdateBalanceAdvancesTimestamp は、残高を更新した
// ときだけ更新日時が進むことを確かめる。
//
// 更新日時は「残高がいつ時点のものか」を表す。名前を直しただけで
// 進めてしまうと、古い残高が最新に見えて催促（IsStale）が効かなくなる。
func TestAccountUsecase_UpdateBalanceAdvancesTimestamp(t *testing.T) {
	h := newHarness(t)

	old := fixedNow.AddDate(0, 0, -60)
	a, err := domain.NewAccount(uuid.New(), "生活用", domain.AccountKindCash, 500000, old)
	if err != nil {
		t.Fatalf("NewAccount: %v", err)
	}
	h.data.accounts[a.ID] = a

	name := "生活用（改名）"
	renamed, err := h.accounts.Update(h.ctx, a.ID, usecase.UpdateAccountInput{Name: &name})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if !renamed.UpdatedAt.Equal(old) {
		t.Errorf("名称だけの更新で日時が進んだ: %v", renamed.UpdatedAt)
	}
	if !renamed.IsStale(fixedNow, domain.StaleBalanceThreshold) {
		t.Error("古い残高のままなので stale のはず")
	}

	balance := domain.Money(450000)
	updated, err := h.accounts.Update(h.ctx, a.ID, usecase.UpdateAccountInput{Balance: &balance})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if !updated.UpdatedAt.Equal(fixedNow) {
		t.Errorf("残高の更新で日時が進んでいない: %v", updated.UpdatedAt)
	}
	if updated.IsStale(fixedNow, domain.StaleBalanceThreshold) {
		t.Error("更新直後なので stale ではないはず")
	}
	if stored := h.account(t, a.ID); stored.Balance != 450000 || stored.Name != name {
		t.Errorf("保存されていない: %+v", stored)
	}
}

// TestAccountUsecase_UpdateKeepsKind は、更新で口座種別が動かないことを
// 確かめる（不変条件1）。入力に kind が無いので指定しようがない。
func TestAccountUsecase_UpdateKeepsKind(t *testing.T) {
	h := newHarness(t)
	a := h.seedAccount(t, "生活用", domain.AccountKindCash, 500000)

	name := "改名"
	got, err := h.accounts.Update(h.ctx, a.ID, usecase.UpdateAccountInput{Name: &name})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if got.Kind != domain.AccountKindCash {
		t.Errorf("Kind=%s want cash", got.Kind)
	}
	if !h.account(t, a.ID).CountsTowardNetAsset() {
		t.Error("cash のままのはず")
	}
}

func TestAccountUsecase_UpdateRejectsEmptyName(t *testing.T) {
	h := newHarness(t)
	a := h.seedAccount(t, "生活用", domain.AccountKindCash, 500000)

	empty := "  "
	if _, err := h.accounts.Update(h.ctx, a.ID, usecase.UpdateAccountInput{Name: &empty}); !errors.Is(err, domain.ErrEmptyTitle) {
		t.Fatalf("err=%v want ErrEmptyTitle", err)
	}
	if stored := h.account(t, a.ID); stored.Name != "生活用" {
		t.Errorf("失敗時に名称が書き換わっている: %q", stored.Name)
	}
}

func TestAccountUsecase_UpdateNotFound(t *testing.T) {
	h := newHarness(t)

	name := "改名"
	_, err := h.accounts.Update(h.ctx, uuid.New(), usecase.UpdateAccountInput{Name: &name})
	if !errors.Is(err, usecase.ErrNotFound) {
		t.Errorf("err=%v want usecase.ErrNotFound", err)
	}
}

// TestAccountUsecase_DeleteInUse は、取引履歴が残っている口座を
// 削除できないことを確かめる（detailed-design 6.2）。
//
// 消せてしまうと、過去の残高の裏付けが取れなくなる。
func TestAccountUsecase_DeleteInUse(t *testing.T) {
	h := newHarness(t)
	account := h.seedAccount(t, "生活用", domain.AccountKindCash, 500000)

	// 立替の登録で履歴が1件残る。
	if _, err := h.lendings.Create(
		h.ctx, "友人A", "", 12000, date(2026, time.June, 10), account.ID,
	); err != nil {
		t.Fatalf("Create(lending): %v", err)
	}

	err := h.accounts.Delete(h.ctx, account.ID)
	if !errors.Is(err, domain.ErrAccountInUse) {
		t.Fatalf("err=%v want ErrAccountInUse", err)
	}
	if !domain.IsDomainError(err) {
		t.Error("422 に対応させるため DomainError であること")
	}
	if _, ok := h.data.accounts[account.ID]; !ok {
		t.Error("削除されてしまった")
	}
}

func TestAccountUsecase_Delete(t *testing.T) {
	h := newHarness(t)
	a := h.seedAccount(t, "予備", domain.AccountKindCash, 0)

	if err := h.accounts.Delete(h.ctx, a.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, ok := h.data.accounts[a.ID]; ok {
		t.Error("削除されていない")
	}
	if err := h.accounts.Delete(h.ctx, uuid.New()); !errors.Is(err, usecase.ErrNotFound) {
		t.Errorf("err=%v want usecase.ErrNotFound", err)
	}
}

func TestAccountUsecase_List(t *testing.T) {
	h := newHarness(t)
	h.seedAccount(t, "生活用", domain.AccountKindCash, 500000)
	h.seedAccount(t, "証券", domain.AccountKindInvestment, 350000)

	got, err := h.accounts.List(h.ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 2 {
		t.Errorf("2件のはず: got %d", len(got))
	}
}
