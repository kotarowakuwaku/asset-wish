package usecase

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
)

type WishUsecase struct {
	tx           TxManager
	wishes       WishRepository
	accounts     AccountRepository
	transactions TransactionRepository
	now          Clock
	newID        IDGenerator
}

func NewWishUsecase(
	tx TxManager,
	wishes WishRepository,
	accounts AccountRepository,
	transactions TransactionRepository,
	now Clock,
	newID IDGenerator,
) *WishUsecase {
	return &WishUsecase{
		tx:           tx,
		wishes:       wishes,
		accounts:     accounts,
		transactions: transactions,
		now:          now,
		newID:        newID,
	}
}

func (u *WishUsecase) List(ctx context.Context, status *domain.WishStatus) ([]domain.Wish, error) {
	return u.wishes.List(ctx, status)
}

func (u *WishUsecase) Create(
	ctx context.Context,
	title string,
	amount domain.Money,
	category domain.WishCategory,
	priority int,
	deadline *time.Time,
) (domain.Wish, error) {
	w, err := domain.NewWish(u.newID(), title, amount, category, priority, deadline)
	if err != nil {
		return domain.Wish{}, err
	}
	if err := u.wishes.Create(ctx, w); err != nil {
		return domain.Wish{}, err
	}
	return w, nil
}

// UpdateWishInput は PATCH の部分更新を表す。nil の項目は変更しない。
//
// Status が無いのは、状態遷移を Commit / Pay / Drop に限るため（不変条件6）。
// ClearDeadline があるのは、Deadline が nil のときに「変更しない」と
// 「期限を外す」を区別できないため。
type UpdateWishInput struct {
	Title         *string
	Amount        *domain.Money
	Category      *domain.WishCategory
	Priority      *int
	Deadline      *time.Time
	ClearDeadline bool
}

func (u *WishUsecase) UpdateContent(ctx context.Context, id uuid.UUID, in UpdateWishInput) (domain.Wish, error) {
	w, err := u.wishes.Get(ctx, id)
	if err != nil {
		return domain.Wish{}, err
	}

	title := w.Title
	if in.Title != nil {
		title = *in.Title
	}
	amount := w.Amount
	if in.Amount != nil {
		amount = *in.Amount
	}
	category := w.Category
	if in.Category != nil {
		category = *in.Category
	}
	priority := w.Priority
	if in.Priority != nil {
		priority = *in.Priority
	}
	deadline := w.Deadline
	switch {
	case in.ClearDeadline:
		deadline = nil
	case in.Deadline != nil:
		deadline = in.Deadline
	}

	// 検証を通すためにコンストラクタを経由する。ここを素通りさせると、
	// 空文字のタイトルや 0 円のウィッシュが更新経由で入り込む。
	updated, err := domain.NewWish(w.ID, title, amount, category, priority, deadline)
	if err != nil {
		return domain.Wish{}, err
	}
	// NewWish は検討中で作るため、現在の状態を戻す。
	// 状態を動かすのは Commit / Pay / Drop だけ。
	updated.Status = w.Status

	if err := u.wishes.UpdateContent(ctx, updated); err != nil {
		return domain.Wish{}, err
	}
	return updated, nil
}

// Commit は 検討中 → 確定 に遷移させる。
// 確定した時点で実質資産から控除される（不変条件3）。
func (u *WishUsecase) Commit(ctx context.Context, id uuid.UUID) (domain.Wish, error) {
	return u.transit(ctx, id, (*domain.Wish).Commit)
}

// Drop は 見送り に遷移させる。
func (u *WishUsecase) Drop(ctx context.Context, id uuid.UUID) (domain.Wish, error) {
	return u.transit(ctx, id, (*domain.Wish).Drop)
}

// transit は取得・遷移・保存をまとめる。
//
// 遷移して良いかの判定は domain.Wish のメソッドが持つ。usecase は
// 「どの遷移を起こしたいか」だけを知る（不変条件6）。
func (u *WishUsecase) transit(
	ctx context.Context,
	id uuid.UUID,
	transition func(*domain.Wish) error,
) (domain.Wish, error) {
	var result domain.Wish

	err := u.tx.RunInTx(ctx, func(ctx context.Context) error {
		w, err := u.wishes.Get(ctx, id)
		if err != nil {
			return err
		}
		if err := transition(&w); err != nil {
			return err
		}
		if err := u.wishes.UpdateStatus(ctx, w); err != nil {
			return err
		}
		result = w
		return nil
	})
	if err != nil {
		return domain.Wish{}, err
	}
	return result, nil
}

// Pay は 確定 → 完了 に遷移させ、口座残高を減らして履歴を残す
// （detailed-design 3.2.3）。
//
// 支払い後、そのウィッシュは確定支出から外れ、同額だけ残高が減る。
// **実質資産は支払いの前後で変わらない。** これが正しい挙動になる。
func (u *WishUsecase) Pay(
	ctx context.Context,
	id uuid.UUID,
	accountID uuid.UUID,
	occurredOn time.Time,
) (domain.Wish, error) {
	var paid domain.Wish

	err := u.tx.RunInTx(ctx, func(ctx context.Context) error {
		w, err := u.wishes.Get(ctx, id)
		if err != nil {
			return err
		}
		if err := w.Pay(); err != nil {
			return err
		}
		if err := u.wishes.UpdateStatus(ctx, w); err != nil {
			return err
		}

		account, err := u.accounts.Get(ctx, accountID)
		if err != nil {
			return err
		}
		account.ApplyDelta(-w.Amount, u.now())
		if err := u.accounts.Update(ctx, account); err != nil {
			return err
		}

		refID := w.ID
		t, err := domain.NewTransaction(
			u.newID(), accountID, -w.Amount, domain.TransactionWishPaid, &refID, occurredOn,
		)
		if err != nil {
			return err
		}
		if err := u.transactions.Create(ctx, t); err != nil {
			return err
		}

		paid = w
		return nil
	})
	if err != nil {
		return domain.Wish{}, err
	}
	return paid, nil
}

func (u *WishUsecase) Delete(ctx context.Context, id uuid.UUID) error {
	if _, err := u.wishes.Get(ctx, id); err != nil {
		return err
	}
	return u.wishes.Delete(ctx, id)
}
