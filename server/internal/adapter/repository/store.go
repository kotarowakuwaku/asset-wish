// Package repository は sqlc の生成コードを usecase のインターフェースに
// 適合させる。
//
// この層の責務は2つに尽きる。
//
//   - sqlc 生成型（db.Account など）とドメインエンティティの相互変換
//   - トランザクションへの参加
//
// 計算はしない。実質資産・不足額・到達見込みは domain の純粋関数が持つ
// （不変条件8）。SQL に集計を書かないのも同じ理由で、データ規模が
// 年間数百件のため全件取得で足りる。
package repository

import (
	"context"
	"database/sql"
	"fmt"

	sqlc "github.com/kotarowakuwaku/asset-wish/server/internal/db"
)

// txKey は ctx にトランザクションを載せるための鍵。
// 型を非公開にして、外から取り出せないようにする。
type txKey struct{}

// Store は接続を保持し、各リポジトリに問い合わせ口を渡す。
// usecase.TxManager の実装でもある。
type Store struct {
	db *sql.DB
}

func NewStore(db *sql.DB) *Store {
	return &Store{db: db}
}

// queries は ctx に応じた問い合わせ口を返す。
//
// RunInTx の内側なら、そのトランザクションに紐づいた Queries を返す。
// 外側なら接続プールをそのまま使う。リポジトリ側が「いまトランザクション
// の中か」を意識せずに済むのが狙いで、これがあるおかげでトランザクション
// 境界を usecase 層だけに置ける（不変条件10）。
func (s *Store) queries(ctx context.Context) *sqlc.Queries {
	if tx, ok := ctx.Value(txKey{}).(*sql.Tx); ok {
		return sqlc.New(tx)
	}
	return sqlc.New(s.db)
}

// RunInTx はトランザクションを張り、fn を実行する。
//
// fn が error を返せばロールバックし、その error をそのまま返す。
// panic した場合もロールバックしてから panic を投げ直す。ここで握り
// つぶすと、中途半端に書き込まれた状態が残る。
//
// すでにトランザクションの中なら、新しく張らず既存のものに相乗りする。
// PostgreSQL のセーブポイントを使った入れ子は用意しない。usecase の
// 処理手順（detailed-design 3.2）に入れ子は出てこないため。
func (s *Store) RunInTx(ctx context.Context, fn func(ctx context.Context) error) (err error) {
	if _, ok := ctx.Value(txKey{}).(*sql.Tx); ok {
		return fn(ctx)
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("トランザクションの開始に失敗: %w", err)
	}

	defer func() {
		if p := recover(); p != nil {
			_ = tx.Rollback()
			panic(p)
		}
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	if err = fn(context.WithValue(ctx, txKey{}, tx)); err != nil {
		return err
	}

	if err = tx.Commit(); err != nil {
		return fmt.Errorf("コミットに失敗: %w", err)
	}
	return nil
}

// limitToInt32 は取得件数を sqlc の引数型に落とす。
//
// 負値や int32 に収まらない値は「全件相当」に丸める。呼び出し側の
// 都合で LIMIT が壊れるより、多めに返すほうが害が小さい。データ規模は
// 年間数百件で、全件取得しても問題にならない（不変条件8）。
const maxLimit = int32(1 << 30)

func limitToInt32(limit int) int32 {
	if limit <= 0 || int64(limit) > int64(maxLimit) {
		return maxLimit
	}
	return int32(limit)
}
