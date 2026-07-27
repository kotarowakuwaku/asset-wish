// Package handler は HTTP と usecase の橋渡しをする。
//
// 責務は JSON の変換とエラーのステータスコードへの対応づけに限る。
// 業務判断はここに書かない。金額の妥当性も状態遷移の可否も domain が
// 持ち、usecase がそれを呼ぶ。
package handler

import (
	"context"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
	"github.com/kotarowakuwaku/asset-wish/server/internal/usecase"
)

// 使う側がインターフェースを定義する。実装は usecase の構造体。
// テストでは canned な値を返すスタブを差し込み、HTTP の関心事——
// ステータスコード、JSON の形、エラーの対応づけ——だけを検証する。

type AccountService interface {
	List(ctx context.Context) ([]domain.Account, error)
	Create(ctx context.Context, name string, kind domain.AccountKind, balance domain.Money) (domain.Account, error)
	Update(ctx context.Context, id uuid.UUID, in usecase.UpdateAccountInput) (domain.Account, error)
	Delete(ctx context.Context, id uuid.UUID) error
}

type LendingService interface {
	List(ctx context.Context, outstandingOnly bool) ([]domain.Lending, error)
	Create(ctx context.Context, counterparty, description string, amount domain.Money,
		occurredOn time.Time, accountID uuid.UUID) (domain.Lending, error)
	Collect(ctx context.Context, lendingID uuid.UUID, amount domain.Money,
		occurredOn time.Time, accountID uuid.UUID) (domain.Lending, error)
	Delete(ctx context.Context, id uuid.UUID) error
}

type WishService interface {
	List(ctx context.Context, status *domain.WishStatus) ([]domain.Wish, error)
	Create(ctx context.Context, title string, amount domain.Money, category domain.WishCategory,
		priority int, deadline *time.Time) (domain.Wish, error)
	UpdateContent(ctx context.Context, id uuid.UUID, in usecase.UpdateWishInput) (domain.Wish, error)
	Commit(ctx context.Context, id uuid.UUID) (domain.Wish, error)
	Pay(ctx context.Context, id uuid.UUID, accountID uuid.UUID, occurredOn time.Time) (domain.Wish, error)
	Drop(ctx context.Context, id uuid.UUID) (domain.Wish, error)
	Delete(ctx context.Context, id uuid.UUID) error
}

type MonthlyBalanceService interface {
	List(ctx context.Context) ([]domain.MonthlyBalance, error)
	Upsert(ctx context.Context, ym domain.YearMonth, income, expense domain.Money) (domain.MonthlyBalance, error)
}

type TransactionService interface {
	List(ctx context.Context, limit int) ([]domain.Transaction, error)
}

type DashboardService interface {
	Get(ctx context.Context) (usecase.Dashboard, error)
}

type Handler struct {
	accounts     AccountService
	lendings     LendingService
	wishes       WishService
	balances     MonthlyBalanceService
	transactions TransactionService
	dashboard    DashboardService
	// now は口座の残高が古いか（IsStale）の判定に使う。表示のための
	// 導出値だが、実時刻を直に読むとテストが日付をまたいだ瞬間に落ちる。
	now usecase.Clock
}

func New(
	accounts AccountService,
	lendings LendingService,
	wishes WishService,
	balances MonthlyBalanceService,
	transactions TransactionService,
	dashboard DashboardService,
	now usecase.Clock,
) *Handler {
	return &Handler{
		accounts:     accounts,
		lendings:     lendings,
		wishes:       wishes,
		balances:     balances,
		transactions: transactions,
		dashboard:    dashboard,
		now:          now,
	}
}

// Routes は経路を組み立てる。
//
// 状態遷移は PATCH ではなく専用の経路にする。クライアントが不正な
// 状態を組み立てられないようにするため（design.md 4.1）。
func (h *Handler) Routes() *http.ServeMux {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/dashboard", h.getDashboard)

	mux.HandleFunc("GET /api/accounts", h.listAccounts)
	mux.HandleFunc("POST /api/accounts", h.createAccount)
	mux.HandleFunc("PATCH /api/accounts/{id}", h.updateAccount)
	mux.HandleFunc("DELETE /api/accounts/{id}", h.deleteAccount)

	mux.HandleFunc("GET /api/lendings", h.listLendings)
	mux.HandleFunc("POST /api/lendings", h.createLending)
	mux.HandleFunc("POST /api/lendings/{id}/collect", h.collectLending)
	mux.HandleFunc("DELETE /api/lendings/{id}", h.deleteLending)

	mux.HandleFunc("GET /api/wishes", h.listWishes)
	mux.HandleFunc("POST /api/wishes", h.createWish)
	mux.HandleFunc("PATCH /api/wishes/{id}", h.updateWish)
	mux.HandleFunc("POST /api/wishes/{id}/commit", h.commitWish)
	mux.HandleFunc("POST /api/wishes/{id}/pay", h.payWish)
	mux.HandleFunc("POST /api/wishes/{id}/drop", h.dropWish)
	mux.HandleFunc("DELETE /api/wishes/{id}", h.deleteWish)

	mux.HandleFunc("GET /api/monthly-balances", h.listMonthlyBalances)
	mux.HandleFunc("PUT /api/monthly-balances/{yearMonth}", h.upsertMonthlyBalance)

	mux.HandleFunc("GET /api/transactions", h.listTransactions)

	return mux
}
