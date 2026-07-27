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

type LendingRepository struct {
	store *Store
}

func NewLendingRepository(store *Store) *LendingRepository {
	return &LendingRepository{store: store}
}

// List は outstandingOnly が true なら未回収のみ返す。
//
// 絞り込みを SQL に置いているのは、これが計算ではなく取得範囲の指定
// だから。未回収残高そのもの（Outstanding）は domain が持つ。
func (r *LendingRepository) List(ctx context.Context, outstandingOnly bool) ([]domain.Lending, error) {
	q := r.store.queries(ctx)

	var (
		rows []sqlc.Lending
		err  error
	)
	if outstandingOnly {
		rows, err = q.ListOutstandingLendings(ctx)
	} else {
		rows, err = q.ListLendings(ctx)
	}
	if err != nil {
		return nil, fmt.Errorf("立替一覧の取得に失敗: %w", err)
	}

	lendings := make([]domain.Lending, 0, len(rows))
	for _, row := range rows {
		lendings = append(lendings, toDomainLending(row))
	}
	return lendings, nil
}

func (r *LendingRepository) Get(ctx context.Context, id uuid.UUID) (domain.Lending, error) {
	row, err := r.store.queries(ctx).GetLending(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Lending{}, usecase.ErrNotFound
	}
	if err != nil {
		return domain.Lending{}, fmt.Errorf("立替の取得に失敗: %w", err)
	}
	return toDomainLending(row), nil
}

func (r *LendingRepository) Create(ctx context.Context, l domain.Lending) error {
	err := r.store.queries(ctx).CreateLending(ctx, sqlc.CreateLendingParams{
		ID:              l.ID,
		Counterparty:    l.Counterparty,
		Description:     l.Description,
		Amount:          int64(l.Amount),
		CollectedAmount: int64(l.CollectedAmount),
		OccurredOn:      l.OccurredOn,
	})
	if err != nil {
		return fmt.Errorf("立替の作成に失敗: %w", err)
	}
	return nil
}

// UpdateCollected は回収額だけを反映する。
//
// 過回収の判定は domain.Lending.Collect が済ませている前提で、ここは
// 確定した値を書くだけ（不変条件4）。DB の CHECK 制約が最後の防波堤
// として残っているので、判定を通っていない値が来れば書き込みが失敗する。
func (r *LendingRepository) UpdateCollected(ctx context.Context, l domain.Lending) error {
	err := r.store.queries(ctx).UpdateLendingCollectedAmount(ctx, sqlc.UpdateLendingCollectedAmountParams{
		ID:              l.ID,
		CollectedAmount: int64(l.CollectedAmount),
	})
	if err != nil {
		return fmt.Errorf("回収額の更新に失敗: %w", err)
	}
	return nil
}

func (r *LendingRepository) Delete(ctx context.Context, id uuid.UUID) error {
	if err := r.store.queries(ctx).DeleteLending(ctx, id); err != nil {
		return fmt.Errorf("立替の削除に失敗: %w", err)
	}
	return nil
}

// toDomainLending は sqlc 生成型をドメインエンティティに詰め替える。
//
// 回収状態（CollectionStatus）は列を持たず、金額から導出する
// （不変条件12）ので、ここで詰めるものは無い。
func toDomainLending(row sqlc.Lending) domain.Lending {
	return domain.Lending{
		ID:              row.ID,
		Counterparty:    row.Counterparty,
		Description:     row.Description,
		Amount:          domain.Money(row.Amount),
		CollectedAmount: domain.Money(row.CollectedAmount),
		OccurredOn:      row.OccurredOn,
	}
}
