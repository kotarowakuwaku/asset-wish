package migrations_test

import (
	"database/sql"
	"net/url"
	"os"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	migrations "github.com/kotarowakuwaku/asset-wish/server/db"
)

// このファイルは db パッケージのテストが共有する下ごしらえ。
// embed_test.go（スキーマが流れるかの検証）と queries_test.go
// （生成クエリの検証）の両方から使う。
//
// 段階3で repository のテストが3つ目の利用者になったら、
// テスト用パッケージとして切り出すことを検討する。利用者が2つの
// うちは、同じテストパッケージ内の関数で足りる。

// localHosts は破壊的なテストを許可する接続先。
//
// このテストは public スキーマを丸ごと落とす。DATABASE_URL の向き先を
// 間違えたときの被害が取り返しのつかない種類なので、ローカル以外は
// 明示的に拒否する。Neon の本番 URL を export したまま go test を
// 打つ事故は、いずれ必ず起きる。
var localHosts = map[string]bool{
	"localhost": true,
	"127.0.0.1": true,
	"::1":       true,
}

// requireLocalDSN は DATABASE_URL を返す。未設定ならテストをスキップし、
// ローカル以外を指していれば失敗させる。
func requireLocalDSN(t *testing.T) string {
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

// openDB は接続を開き、実際に到達できることまで確かめる。
func openDB(t *testing.T, dsn string) *sql.DB {
	t.Helper()

	conn, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("sql.Open に失敗: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	if err := conn.Ping(); err != nil {
		t.Fatalf("DB に接続できない（server/ で docker compose up -d は済んでいるか）: %v", err)
	}

	return conn
}

// resetSchema は public スキーマを作り直し、適用済みバージョンごと消す。
// テストが前回の残骸に依存しないようにするため。
func resetSchema(t *testing.T, conn *sql.DB) {
	t.Helper()

	if _, err := conn.Exec(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`); err != nil {
		t.Fatalf("public スキーマの初期化に失敗: %v", err)
	}
}

// applyMigrations は埋め込んだ SQL を適用する。
func applyMigrations(t *testing.T, conn *sql.DB) {
	t.Helper()

	goose.SetBaseFS(migrations.FS)
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatalf("goose の dialect 設定に失敗: %v", err)
	}
	if err := goose.Up(conn, "migrations"); err != nil {
		t.Fatalf("マイグレーションの適用に失敗: %v", err)
	}
}

// setupDB はまっさらなスキーマにマイグレーションを流した接続を返す。
//
// テストごとに作り直すのは、実行順序に依存するテストを書けなくするため。
// 前のテストが残したレコードにたまたま助けられている状態を作らない。
func setupDB(t *testing.T) *sql.DB {
	t.Helper()

	conn := openDB(t, requireLocalDSN(t))
	resetSchema(t, conn)
	applyMigrations(t, conn)

	return conn
}
