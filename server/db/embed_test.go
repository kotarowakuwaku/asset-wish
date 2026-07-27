package migrations_test

import (
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	migrations "github.com/kotarowakuwaku/asset-wish/server/db"
)

// TestMigrationsUpDown は DDL が実際の PostgreSQL に適用でき、
// かつ元に戻せることを確かめる。
//
// sqlc のパーサを通ることは構文の正しさしか保証しない。CHECK 制約に
// IMMUTABLE でない関数を書いた、といった意味解析のエラーは実物に
// 流して初めて出る。ここが段階2の検証ゲートになる。
func TestMigrationsUpDown(t *testing.T) {
	conn := openDB(t, requireLocalDSN(t))
	resetSchema(t, conn)
	applyMigrations(t, conn)

	// 設計書 2.2 のテーブルが揃っていること。
	// goose が「成功した」と言っても、空のマイグレーションを
	// 流しただけでも成功するため、中身を確かめる。
	for _, table := range []string{
		"accounts", "lendings", "wishes", "monthly_balances", "transactions",
	} {
		var exists bool
		err := conn.QueryRow(
			`SELECT EXISTS (
			     SELECT 1 FROM information_schema.tables
			     WHERE table_schema = 'public' AND table_name = $1
			 )`, table).Scan(&exists)
		if err != nil {
			t.Fatalf("テーブル %s の存在確認に失敗: %v", table, err)
		}
		if !exists {
			t.Errorf("テーブル %s が作られていない", table)
		}
	}

	// down が書かれていないマイグレーションは、失敗したときに
	// 手で戻す羽目になる。up と同時に検証しておく。
	goose.SetBaseFS(migrations.FS)
	if err := goose.DownTo(conn, "migrations", 0); err != nil {
		t.Fatalf("マイグレーションの巻き戻しに失敗: %v", err)
	}
}

// TestMonthlyBalanceFirstDayConstraint は monthly_balances の
// CHECK 制約が効いていることを確かめる。
//
// 不変条件ではないが、YearMonth を月初日の DATE で持つという
// 設計判断（design.md 2.3）を DB 側が支えているかの確認。
// 制約が黙って外れても、Go 側のテストだけでは気付けない。
func TestMonthlyBalanceFirstDayConstraint(t *testing.T) {
	conn := setupDB(t)

	const insert = `INSERT INTO monthly_balances (id, year_month, income, expense)
	                VALUES (gen_random_uuid(), $1, 0, 0)`

	if _, err := conn.Exec(insert, "2026-07-01"); err != nil {
		t.Fatalf("月初日は通るはずが失敗した: %v", err)
	}

	if _, err := conn.Exec(insert, "2026-08-15"); err == nil {
		t.Error("月の途中の日付が通ってしまった。CHECK 制約が効いていない")
	}
}
