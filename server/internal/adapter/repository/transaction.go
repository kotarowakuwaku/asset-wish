package repository

import (
	"context"
	"fmt"

	"github.com/google/uuid"

	sqlc "github.com/kotarowakuwaku/asset-wish/server/internal/db"
	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
)

type TransactionRepository struct {
	store *Store
}

func NewTransactionRepository(store *Store) *TransactionRepository {
	return &TransactionRepository{store: store}
}

// List は発生日の降順で最大 limit 件を返す。
func (r *TransactionRepository) List(ctx context.Context, limit int) ([]domain.Transaction, error) {
	rows, err := r.store.queries(ctx).ListTransactions(ctx, limitToInt32(limit))
	if err != nil {
		return nil, fmt.Errorf("取引履歴の取得に失敗: %w", err)
	}

	transactions := make([]domain.Transaction, 0, len(rows))
	for _, row := range rows {
		t, err := toDomainTransaction(row)
		if err != nil {
			return nil, err
		}
		transactions = append(transactions, t)
	}
	return transactions, nil
}

func (r *TransactionRepository) Create(ctx context.Context, t domain.Transaction) error {
	err := r.store.queries(ctx).CreateTransaction(ctx, sqlc.CreateTransactionParams{
		ID:         t.ID,
		AccountID:  t.AccountID,
		Amount:     int64(t.Amount),
		Kind:       string(t.Kind),
		RefID:      toNullUUID(t.RefID),
		OccurredOn: t.OccurredOn,
	})
	if err != nil {
		return fmt.Errorf("取引履歴の作成に失敗: %w", err)
	}
	return nil
}

// toDomainTransaction は sqlc 生成型をドメインエンティティに詰め替える。
// kind は string で戻るため、ここで検証する。
func toDomainTransaction(row sqlc.Transaction) (domain.Transaction, error) {
	kind := domain.TransactionKind(row.Kind)
	if !kind.Valid() {
		return domain.Transaction{}, fmt.Errorf("transactions.kind が不正: id=%s kind=%q", row.ID, row.Kind)
	}

	return domain.Transaction{
		ID:         row.ID,
		AccountID:  row.AccountID,
		Amount:     domain.Money(row.Amount),
		Kind:       kind,
		RefID:      fromNullUUID(row.RefID),
		OccurredOn: row.OccurredOn,
	}, nil
}

func toNullUUID(id *uuid.UUID) uuid.NullUUID {
	if id == nil {
		return uuid.NullUUID{}
	}
	return uuid.NullUUID{UUID: *id, Valid: true}
}

func fromNullUUID(n uuid.NullUUID) *uuid.UUID {
	if !n.Valid {
		return nil
	}
	id := n.UUID
	return &id
}
