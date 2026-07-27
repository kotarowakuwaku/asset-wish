package usecase

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
)

type LendingUsecase struct {
	tx           TxManager
	lendings     LendingRepository
	accounts     AccountRepository
	transactions TransactionRepository
	now          Clock
	newID        IDGenerator
}

func NewLendingUsecase(
	tx TxManager,
	lendings LendingRepository,
	accounts AccountRepository,
	transactions TransactionRepository,
	now Clock,
	newID IDGenerator,
) *LendingUsecase {
	return &LendingUsecase{
		tx:           tx,
		lendings:     lendings,
		accounts:     accounts,
		transactions: transactions,
		now:          now,
		newID:        newID,
	}
}

func (u *LendingUsecase) List(ctx context.Context, outstandingOnly bool) ([]domain.Lending, error) {
	return u.lendings.List(ctx, outstandingOnly)
}

// Create は立替を登録し、口座残高を減らして履歴を残す（detailed-design 3.2.1）。
//
// 立て替えた時点で自分の口座からは金が出ている。残高を減らさないと、
// 未回収額と残高の両方に同じ金を数えることになる。
func (u *LendingUsecase) Create(
	ctx context.Context,
	counterparty, description string,
	amount domain.Money,
	occurredOn time.Time,
	accountID uuid.UUID,
) (domain.Lending, error) {
	l, err := domain.NewLending(u.newID(), counterparty, description, amount, occurredOn)
	if err != nil {
		return domain.Lending{}, err
	}

	err = u.tx.RunInTx(ctx, func(ctx context.Context) error {
		account, err := u.accounts.Get(ctx, accountID)
		if err != nil {
			return err
		}
		account.ApplyDelta(-amount, u.now())
		if err := u.accounts.Update(ctx, account); err != nil {
			return err
		}
		if err := u.lendings.Create(ctx, l); err != nil {
			return err
		}
		return u.recordTransaction(ctx, accountID, -amount, domain.TransactionLendingCreated, l.ID, occurredOn)
	})
	if err != nil {
		return domain.Lending{}, err
	}
	return l, nil
}

// Collect は回収を記録し、口座残高を戻して履歴を残す（detailed-design 3.2.2）。
//
// 取得から更新までをトランザクションの内側に置く。取得と更新の間に別の
// 回収が入ると、どちらも未回収残高の範囲内に見えて過回収が成立しうるため
// （不変条件4）。
func (u *LendingUsecase) Collect(
	ctx context.Context,
	lendingID uuid.UUID,
	amount domain.Money,
	occurredOn time.Time,
	accountID uuid.UUID,
) (domain.Lending, error) {
	var collected domain.Lending

	err := u.tx.RunInTx(ctx, func(ctx context.Context) error {
		l, err := u.lendings.Get(ctx, lendingID)
		if err != nil {
			return err
		}
		if err := l.Collect(amount); err != nil {
			return err
		}
		if err := u.lendings.UpdateCollected(ctx, l); err != nil {
			return err
		}

		account, err := u.accounts.Get(ctx, accountID)
		if err != nil {
			return err
		}
		account.ApplyDelta(amount, u.now())
		if err := u.accounts.Update(ctx, account); err != nil {
			return err
		}

		if err := u.recordTransaction(
			ctx, accountID, amount, domain.TransactionLendingCollected, lendingID, occurredOn,
		); err != nil {
			return err
		}

		collected = l
		return nil
	})
	if err != nil {
		return domain.Lending{}, err
	}
	return collected, nil
}

func (u *LendingUsecase) Delete(ctx context.Context, id uuid.UUID) error {
	if _, err := u.lendings.Get(ctx, id); err != nil {
		return err
	}
	return u.lendings.Delete(ctx, id)
}

func (u *LendingUsecase) recordTransaction(
	ctx context.Context,
	accountID uuid.UUID,
	amount domain.Money,
	kind domain.TransactionKind,
	refID uuid.UUID,
	occurredOn time.Time,
) error {
	t, err := domain.NewTransaction(u.newID(), accountID, amount, kind, &refID, occurredOn)
	if err != nil {
		return err
	}
	return u.transactions.Create(ctx, t)
}
