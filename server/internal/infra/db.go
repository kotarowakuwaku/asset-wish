package infra

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib" // database/sql に pgx を登録する
)

const (
	// maxOpenConns は同時に開く接続の上限。
	//
	// Neon の無料枠は接続数に上限があり、Cloud Run のインスタンスが
	// 増えるとインスタンス数×この値だけ掴みにいく。単一ユーザーの
	// アプリで並列度は要らないので、小さく固定する（不変条件15・16）。
	maxOpenConns = 4
	// maxIdleConns は使い回すために保つ接続数。
	maxIdleConns = 2
	// connMaxLifetime は接続を作り直す間隔。
	// サーバーレス DB は一定時間で接続を切るため、こちらから先に畳む。
	connMaxLifetime = 5 * time.Minute
	// connMaxIdleTime はアイドル接続を閉じるまでの時間。
	connMaxIdleTime = time.Minute
	// pingTimeout は起動時の疎通確認の待ち時間。
	pingTimeout = 5 * time.Second
)

// OpenDB は接続プールを開き、疎通を確かめる。
//
// 起動時に一度確かめるのは、設定ミスを最初のリクエストではなく
// 起動時に見つけるため。
func OpenDB(ctx context.Context, dsn string) (*sql.DB, error) {
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, fmt.Errorf("DB 接続の初期化に失敗: %w", err)
	}

	db.SetMaxOpenConns(maxOpenConns)
	db.SetMaxIdleConns(maxIdleConns)
	db.SetConnMaxLifetime(connMaxLifetime)
	db.SetConnMaxIdleTime(connMaxIdleTime)

	pingCtx, cancel := context.WithTimeout(ctx, pingTimeout)
	defer cancel()

	if err := db.PingContext(pingCtx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("DB に接続できない: %w", err)
	}
	return db, nil
}
