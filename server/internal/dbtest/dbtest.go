// Package dbtest は、実物の PostgreSQL を使うテストの下ごしらえを提供する。
//
// db パッケージ（マイグレーションと生成クエリの検証）と
// adapter/repository のテストが共有する。テストからのみ import される
// 前提で testing を受け取る。
//
// 本番のコードパスからは使わない。cmd/ や internal/adapter から
// import してはならない。
package dbtest

import (
	"context"
	"database/sql"
	"net/url"
	"os"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib" // database/sql に pgx を登録する
	"github.com/pressly/goose/v3"

	migrations "github.com/kotarowakuwaku/asset-wish/server/db"
)

// localHosts は破壊的なテストを許可する接続先。
//
// ここでのテストは public スキーマを丸ごと落とす。DATABASE_URL の
// 向き先を間違えたときの被害が取り返しのつかない種類なので、
// ローカル以外は明示的に拒否する。Neon の本番 URL を export した
// まま go test を打つ事故は、いずれ必ず起きる。
var localHosts = map[string]bool{
	"localhost": true,
	"127.0.0.1": true,
	"::1":       true,
}

// RequireLocalDSN は DATABASE_URL を返す。未設定ならテストをスキップし、
// ローカル以外を指していれば失敗させる。
func RequireLocalDSN(t *testing.T) string {
	t.Helper()

	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL が未設定のためスキップ。" +
			"ローカルでは server/ で docker compose up -d したうえで " +
			"export DATABASE_URL='postgres://test:test@localhost:5432/test?sslmode=disable'")
	}

	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("DATABASE_URL を URL として解釈できない: %v", err)
	}

	host := u.Hostname()
	if !localHosts[host] {
		t.Fatalf("DATABASE_URL の接続先が %q。"+
			"このテストは public スキーマを削除するため、ローカル以外では実行しない", host)
	}

	return dsn
}

// schemaLockKey は DB を使うテストを直列化するためのアドバイザリロックの鍵。
// 値そのものに意味は無く、他の用途と衝突しなければよい。
const schemaLockKey int64 = 20260727

// Open は接続を開き、実際に到達できることまで確かめる。
//
// あわせて、テストが終わるまでアドバイザリロックを取る。go test は
// パッケージを並行して走らせるため、DB を使うテストが2パッケージ以上に
// なると、同じ public スキーマを同時に作り直して互いの前提を壊す。
// 単体のパッケージでは通るのに ./... では落ちる、という形で出る。
//
// 直列化しても DB を使うテスト全体で数秒なので、実行時間より
// 「どの順で走っても同じ結果になる」ことを取る。
func Open(t *testing.T, dsn string) *sql.DB {
	t.Helper()

	conn, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("sql.Open に失敗: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	if err := conn.Ping(); err != nil {
		t.Fatalf("DB に接続できない（server/ で docker compose up -d は済んでいるか）: %v", err)
	}

	lockSchema(t, conn)

	return conn
}

// lockSchema はスキーマを触る権利をテスト終了まで確保する。
//
// アドバイザリロックはセッション単位で効くため、接続を1本占有する
// （プールから毎回同じ接続が来る保証は無い）。解放してから返すこと。
// 解放せずに閉じると、プールに戻った接続がロックを握ったままになる。
func lockSchema(t *testing.T, conn *sql.DB) {
	t.Helper()

	ctx := context.Background()
	pinned, err := conn.Conn(ctx)
	if err != nil {
		t.Fatalf("ロック用の接続の確保に失敗: %v", err)
	}

	if _, err := pinned.ExecContext(ctx, `SELECT pg_advisory_lock($1)`, schemaLockKey); err != nil {
		_ = pinned.Close()
		t.Fatalf("アドバイザリロックの取得に失敗: %v", err)
	}

	t.Cleanup(func() {
		if _, err := pinned.ExecContext(ctx, `SELECT pg_advisory_unlock($1)`, schemaLockKey); err != nil {
			t.Errorf("アドバイザリロックの解放に失敗: %v", err)
		}
		_ = pinned.Close()
	})
}

// ResetSchema は public スキーマを作り直し、適用済みバージョンごと消す。
// テストが前回の残骸に依存しないようにするため。
func ResetSchema(t *testing.T, conn *sql.DB) {
	t.Helper()

	if _, err := conn.Exec(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`); err != nil {
		t.Fatalf("public スキーマの初期化に失敗: %v", err)
	}
}

// ApplyMigrations は埋め込んだ SQL を適用する。
func ApplyMigrations(t *testing.T, conn *sql.DB) {
	t.Helper()

	goose.SetBaseFS(migrations.FS)
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatalf("goose の dialect 設定に失敗: %v", err)
	}
	if err := goose.Up(conn, "migrations"); err != nil {
		t.Fatalf("マイグレーションの適用に失敗: %v", err)
	}
}

// Setup はまっさらなスキーマにマイグレーションを流した接続を返す。
//
// テストごとに作り直すのは、実行順序に依存するテストを書けなくするため。
// 前のテストが残したレコードにたまたま助けられている状態を作らない。
func Setup(t *testing.T) *sql.DB {
	t.Helper()

	conn := Open(t, RequireLocalDSN(t))
	ResetSchema(t, conn)
	ApplyMigrations(t, conn)

	return conn
}
