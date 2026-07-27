package usecase

import (
	"context"

	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
)

// DefaultTransactionLimit は取引履歴の既定の取得件数。
//
// 履歴は「残高が動いた理由を後から辿る」ためのもので、古いものまで
// 一度に見る場面が無い。データ規模は年間数百件なので、上限を設けても
// 実用上は困らない。
const DefaultTransactionLimit = 100

type TransactionUsecase struct {
	transactions TransactionRepository
}

func NewTransactionUsecase(transactions TransactionRepository) *TransactionUsecase {
	return &TransactionUsecase{transactions: transactions}
}

// List は発生日の降順で返す。limit が 0 以下なら既定の件数を使う。
func (u *TransactionUsecase) List(ctx context.Context, limit int) ([]domain.Transaction, error) {
	if limit <= 0 {
		limit = DefaultTransactionLimit
	}
	return u.transactions.List(ctx, limit)
}
