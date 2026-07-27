// Command api は HTTP サーバーを起動する。
//
// 依存の組み立ては手書きで行う。DI コンテナは使わない。依存関係を
// 追うのに別の仕組みを覚える必要がなく、結線が1箇所に見えるほうが
// 学習目的に合う。
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/kotarowakuwaku/asset-wish/server/internal/adapter/handler"
	"github.com/kotarowakuwaku/asset-wish/server/internal/adapter/repository"
	"github.com/kotarowakuwaku/asset-wish/server/internal/infra"
	"github.com/kotarowakuwaku/asset-wish/server/internal/usecase"
)

const (
	readHeaderTimeout = 10 * time.Second
	writeTimeout      = 30 * time.Second
	idleTimeout       = 60 * time.Second
	// shutdownTimeout は終了時に進行中の処理を待つ時間。
	// Cloud Run は SIGTERM のあとしばらくして強制終了する。
	shutdownTimeout = 10 * time.Second
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	if err := run(); err != nil {
		slog.Error("起動に失敗", "error", err)
		os.Exit(1)
	}
}

func run() error {
	// SIGTERM / SIGINT で停止に入る。
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	cfg, err := infra.LoadConfig()
	if err != nil {
		return err
	}

	db, err := infra.OpenDB(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()

	// ここから下が結線。依存の向きは handler → usecase → domain。
	store := repository.NewStore(db)
	accountRepo := repository.NewAccountRepository(store)
	lendingRepo := repository.NewLendingRepository(store)
	wishRepo := repository.NewWishRepository(store)
	balanceRepo := repository.NewMonthlyBalanceRepository(store)
	transactionRepo := repository.NewTransactionRepository(store)

	now := usecase.Clock(usecase.SystemClock)
	newID := usecase.IDGenerator(usecase.NewUUID)

	h := handler.New(
		usecase.NewAccountUsecase(accountRepo, now, newID),
		usecase.NewLendingUsecase(store, lendingRepo, accountRepo, transactionRepo, now, newID),
		usecase.NewWishUsecase(store, wishRepo, accountRepo, transactionRepo, now, newID),
		usecase.NewMonthlyBalanceUsecase(balanceRepo, newID),
		usecase.NewTransactionUsecase(transactionRepo),
		usecase.NewDashboardUsecase(accountRepo, lendingRepo, wishRepo, balanceRepo),
		now,
	)

	// CORS を認証より外側に置く。事前検査（OPTIONS）には Authorization が
	// 付かないため、内側に置くと 401 を返してブラウザが本リクエストを
	// 送らなくなる。
	root := handler.Chain(h.Routes(),
		handler.RequestLog(),
		handler.CORS(cfg.AllowedOrigins),
		handler.Auth(cfg.AuthToken),
	)

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           root,
		ReadHeaderTimeout: readHeaderTimeout,
		WriteTimeout:      writeTimeout,
		IdleTimeout:       idleTimeout,
	}

	errCh := make(chan error, 1)
	go func() {
		slog.Info("listening", "port", cfg.Port)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		slog.Info("停止します")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		return err
	}
	return nil
}
