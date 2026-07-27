package usecase

import (
	"context"

	"github.com/google/uuid"

	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
)

type AccountUsecase struct {
	accounts AccountRepository
	now      Clock
	newID    IDGenerator
}

func NewAccountUsecase(accounts AccountRepository, now Clock, newID IDGenerator) *AccountUsecase {
	return &AccountUsecase{accounts: accounts, now: now, newID: newID}
}

func (u *AccountUsecase) List(ctx context.Context) ([]domain.Account, error) {
	return u.accounts.List(ctx)
}

func (u *AccountUsecase) Create(
	ctx context.Context,
	name string,
	kind domain.AccountKind,
	balance domain.Money,
) (domain.Account, error) {
	a, err := domain.NewAccount(u.newID(), name, kind, balance, u.now())
	if err != nil {
		return domain.Account{}, err
	}
	if err := u.accounts.Create(ctx, a); err != nil {
		return domain.Account{}, err
	}
	return a, nil
}

// UpdateAccountInput は PATCH の部分更新を表す。nil の項目は変更しない。
//
// Kind が無いのは、口座種別を変えられないため。種別が変わると、その口座が
// 実質資産の計算から丸ごと外れる（不変条件1）。
type UpdateAccountInput struct {
	Name    *string
	Balance *domain.Money
}

// Update は名称と残高を更新する。
//
// 残高を触ったときだけ更新日時を進める。名称を直しただけで「残高は最新」
// と見なすと、IsStale による催促が効かなくなるため。
func (u *AccountUsecase) Update(ctx context.Context, id uuid.UUID, in UpdateAccountInput) (domain.Account, error) {
	a, err := u.accounts.Get(ctx, id)
	if err != nil {
		return domain.Account{}, err
	}

	if in.Name != nil {
		renamed, err := domain.NewAccount(a.ID, *in.Name, a.Kind, a.Balance, a.UpdatedAt)
		if err != nil {
			return domain.Account{}, err
		}
		a = renamed
	}
	if in.Balance != nil {
		a.UpdateBalance(*in.Balance, u.now())
	}

	if err := u.accounts.Update(ctx, a); err != nil {
		return domain.Account{}, err
	}
	return a, nil
}

// Delete は口座を削除する。
// 取引履歴が残っている場合は domain.ErrAccountInUse になる。
func (u *AccountUsecase) Delete(ctx context.Context, id uuid.UUID) error {
	if _, err := u.accounts.Get(ctx, id); err != nil {
		return err
	}
	return u.accounts.Delete(ctx, id)
}
