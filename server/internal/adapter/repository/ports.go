package repository

import "github.com/kotarowakuwaku/asset-wish/server/internal/usecase"

// usecase 側のインターフェースを満たしていることをコンパイル時に確かめる。
//
// 実際に結線するのは cmd/api の手書き DI だが、そこまで到達しないと
// 気付けないのでは遅い。メソッドの追加漏れをここで落とす。
var (
	_ usecase.AccountRepository        = (*AccountRepository)(nil)
	_ usecase.LendingRepository        = (*LendingRepository)(nil)
	_ usecase.WishRepository           = (*WishRepository)(nil)
	_ usecase.MonthlyBalanceRepository = (*MonthlyBalanceRepository)(nil)
	_ usecase.TransactionRepository    = (*TransactionRepository)(nil)
	_ usecase.TxManager                = (*Store)(nil)
)
