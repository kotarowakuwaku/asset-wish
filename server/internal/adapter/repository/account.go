package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/google/uuid"

	sqlc "github.com/kotarowakuwaku/asset-wish/server/internal/db"
	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
	"github.com/kotarowakuwaku/asset-wish/server/internal/usecase"
)

type AccountRepository struct {
	store *Store
}

func NewAccountRepository(store *Store) *AccountRepository {
	return &AccountRepository{store: store}
}

func (r *AccountRepository) List(ctx context.Context) ([]domain.Account, error) {
	rows, err := r.store.queries(ctx).ListAccounts(ctx)
	if err != nil {
		return nil, fmt.Errorf("口座一覧の取得に失敗: %w", err)
	}

	accounts := make([]domain.Account, 0, len(rows))
	for _, row := range rows {
		a, err := toDomainAccount(row)
		if err != nil {
			return nil, err
		}
		accounts = append(accounts, a)
	}
	return accounts, nil
}

func (r *AccountRepository) Get(ctx context.Context, id uuid.UUID) (domain.Account, error) {
	row, err := r.store.queries(ctx).GetAccount(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Account{}, usecase.ErrNotFound
	}
	if err != nil {
		return domain.Account{}, fmt.Errorf("口座の取得に失敗: %w", err)
	}
	return toDomainAccount(row)
}

func (r *AccountRepository) Create(ctx context.Context, a domain.Account) error {
	err := r.store.queries(ctx).CreateAccount(ctx, sqlc.CreateAccountParams{
		ID:        a.ID,
		Name:      a.Name,
		Kind:      string(a.Kind),
		Balance:   int64(a.Balance),
		UpdatedAt: a.UpdatedAt,
	})
	if err != nil {
		return fmt.Errorf("口座の作成に失敗: %w", err)
	}
	return nil
}

// Update は名称・残高・更新日時を反映する。Kind は渡さない。
// 種別が変わると、その口座が実質資産の計算から外れるため（不変条件1）。
func (r *AccountRepository) Update(ctx context.Context, a domain.Account) error {
	err := r.store.queries(ctx).UpdateAccount(ctx, sqlc.UpdateAccountParams{
		ID:        a.ID,
		Name:      a.Name,
		Balance:   int64(a.Balance),
		UpdatedAt: a.UpdatedAt,
	})
	if err != nil {
		return fmt.Errorf("口座の更新に失敗: %w", err)
	}
	return nil
}

func (r *AccountRepository) Delete(ctx context.Context, id uuid.UUID) error {
	if err := r.store.queries(ctx).DeleteAccount(ctx, id); err != nil {
		return fmt.Errorf("口座の削除に失敗: %w", err)
	}
	return nil
}

// toDomainAccount は sqlc 生成型をドメインエンティティに詰め替える。
//
// kind は string で戻ってくるため、ここで検証する。DB の CHECK 制約が
// あるので不正な値が入っている見込みは薄いが、ドメイン層に壊れた値を
// 渡さない最後の関門になる（detailed-design 4.1）。
func toDomainAccount(row sqlc.Account) (domain.Account, error) {
	kind := domain.AccountKind(row.Kind)
	if !kind.Valid() {
		return domain.Account{}, fmt.Errorf("accounts.kind が不正: id=%s kind=%q", row.ID, row.Kind)
	}

	return domain.Account{
		ID:        row.ID,
		Name:      row.Name,
		Kind:      kind,
		Balance:   domain.Money(row.Balance),
		UpdatedAt: row.UpdatedAt,
	}, nil
}
