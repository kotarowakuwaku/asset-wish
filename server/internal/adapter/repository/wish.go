package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	sqlc "github.com/kotarowakuwaku/asset-wish/server/internal/db"
	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
	"github.com/kotarowakuwaku/asset-wish/server/internal/usecase"
)

type WishRepository struct {
	store *Store
}

func NewWishRepository(store *Store) *WishRepository {
	return &WishRepository{store: store}
}

// List は status が nil なら全件を返す。
func (r *WishRepository) List(ctx context.Context, status *domain.WishStatus) ([]domain.Wish, error) {
	q := r.store.queries(ctx)

	var (
		rows []sqlc.Wish
		err  error
	)
	if status != nil {
		rows, err = q.ListWishesByStatus(ctx, string(*status))
	} else {
		rows, err = q.ListWishes(ctx)
	}
	if err != nil {
		return nil, fmt.Errorf("ウィッシュ一覧の取得に失敗: %w", err)
	}

	wishes := make([]domain.Wish, 0, len(rows))
	for _, row := range rows {
		w, err := toDomainWish(row)
		if err != nil {
			return nil, err
		}
		wishes = append(wishes, w)
	}
	return wishes, nil
}

func (r *WishRepository) Get(ctx context.Context, id uuid.UUID) (domain.Wish, error) {
	row, err := r.store.queries(ctx).GetWish(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Wish{}, usecase.ErrNotFound
	}
	if err != nil {
		return domain.Wish{}, fmt.Errorf("ウィッシュの取得に失敗: %w", err)
	}
	return toDomainWish(row)
}

func (r *WishRepository) Create(ctx context.Context, w domain.Wish) error {
	err := r.store.queries(ctx).CreateWish(ctx, sqlc.CreateWishParams{
		ID:       w.ID,
		Title:    w.Title,
		Amount:   int64(w.Amount),
		Category: string(w.Category),
		Status:   string(w.Status),
		Priority: int32(w.Priority),
		Deadline: toNullTime(w.Deadline),
	})
	if err != nil {
		return fmt.Errorf("ウィッシュの作成に失敗: %w", err)
	}
	return nil
}

// UpdateContent は内容だけを反映する。Status は動かさない。
// 遷移の判定を domain のメソッドに閉じ込めるため（不変条件6）。
func (r *WishRepository) UpdateContent(ctx context.Context, w domain.Wish) error {
	err := r.store.queries(ctx).UpdateWishContent(ctx, sqlc.UpdateWishContentParams{
		ID:       w.ID,
		Title:    w.Title,
		Amount:   int64(w.Amount),
		Category: string(w.Category),
		Priority: int32(w.Priority),
		Deadline: toNullTime(w.Deadline),
	})
	if err != nil {
		return fmt.Errorf("ウィッシュの更新に失敗: %w", err)
	}
	return nil
}

// UpdateStatus は状態だけを反映する。
// 遷移してよいかは domain.Wish の Commit / Pay / Drop が判定済み。
func (r *WishRepository) UpdateStatus(ctx context.Context, w domain.Wish) error {
	err := r.store.queries(ctx).UpdateWishStatus(ctx, sqlc.UpdateWishStatusParams{
		ID:     w.ID,
		Status: string(w.Status),
	})
	if err != nil {
		return fmt.Errorf("ウィッシュの状態更新に失敗: %w", err)
	}
	return nil
}

func (r *WishRepository) Delete(ctx context.Context, id uuid.UUID) error {
	if err := r.store.queries(ctx).DeleteWish(ctx, id); err != nil {
		return fmt.Errorf("ウィッシュの削除に失敗: %w", err)
	}
	return nil
}

// toDomainWish は sqlc 生成型をドメインエンティティに詰め替える。
// category と status は string で戻るため、ここで検証する。
func toDomainWish(row sqlc.Wish) (domain.Wish, error) {
	category := domain.WishCategory(row.Category)
	if !category.Valid() {
		return domain.Wish{}, fmt.Errorf("wishes.category が不正: id=%s category=%q", row.ID, row.Category)
	}

	status := domain.WishStatus(row.Status)
	if !status.Valid() {
		return domain.Wish{}, fmt.Errorf("wishes.status が不正: id=%s status=%q", row.ID, row.Status)
	}

	return domain.Wish{
		ID:       row.ID,
		Title:    row.Title,
		Amount:   domain.Money(row.Amount),
		Category: category,
		Status:   status,
		Priority: int(row.Priority),
		Deadline: fromNullTime(row.Deadline),
	}, nil
}

func toNullTime(t *time.Time) sql.NullTime {
	if t == nil {
		return sql.NullTime{}
	}
	return sql.NullTime{Time: *t, Valid: true}
}

func fromNullTime(n sql.NullTime) *time.Time {
	if !n.Valid {
		return nil
	}
	t := n.Time
	return &t
}
