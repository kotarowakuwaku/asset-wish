// Package usecase は、アプリケーションの手順を組み立てる層。
//
// 永続化の手段は知らない。必要な操作をインターフェースとして
// ここに定義し、実装は adapter/repository が与える。使う側が
// インターフェースを持つことで、依存の向きを handler → usecase →
// domain に保つ（依存性逆転、design.md 5.1）。
package usecase

import (
	"context"
	"errors"

	"github.com/google/uuid"

	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
)

// ErrNotFound は対象が存在しないことを表す。handler で 404 に対応させる。
//
// domain.DomainError ではない。業務ルール違反（422）と「そもそも無い」
// （404）は別物として扱う。
var ErrNotFound = errors.New("対象が見つかりません")

// 更新系のメソッドを操作ごとに分けている。全項目を書き戻す Update を
// 1本置くと、状態遷移や口座種別まで巻き込んで上書きできてしまい、
// domain の判定を通さない変更経路ができる（CLAUDE.md「更新クエリを
// 操作別に分ける」）。SQL 側でも同じ形に割ってある。

type AccountRepository interface {
	List(ctx context.Context) ([]domain.Account, error)
	Get(ctx context.Context, id uuid.UUID) (domain.Account, error)
	Create(ctx context.Context, a domain.Account) error
	// Update は名称・残高・更新日時を反映する。Kind は変更できない。
	// 種別が変わると、その口座が実質資産の計算から外れるため（不変条件1）。
	Update(ctx context.Context, a domain.Account) error
	Delete(ctx context.Context, id uuid.UUID) error
}

type LendingRepository interface {
	// List は outstandingOnly が true なら未回収（回収額 < 立替額）のみ返す。
	List(ctx context.Context, outstandingOnly bool) ([]domain.Lending, error)
	Get(ctx context.Context, id uuid.UUID) (domain.Lending, error)
	Create(ctx context.Context, l domain.Lending) error
	// UpdateCollected は回収額だけを反映する。
	// 立替額そのものを後から変える操作は API に無い。
	UpdateCollected(ctx context.Context, l domain.Lending) error
	Delete(ctx context.Context, id uuid.UUID) error
}

type WishRepository interface {
	// List は status が nil なら全件を返す。
	List(ctx context.Context, status *domain.WishStatus) ([]domain.Wish, error)
	Get(ctx context.Context, id uuid.UUID) (domain.Wish, error)
	Create(ctx context.Context, w domain.Wish) error
	// UpdateContent は title / amount / priority / deadline を反映する。
	// Status は動かさない。遷移は UpdateStatus を使う。
	UpdateContent(ctx context.Context, w domain.Wish) error
	// UpdateStatus は状態だけを反映する。遷移してよいかの判定は
	// domain.Wish のメソッドが済ませている前提（不変条件6）。
	UpdateStatus(ctx context.Context, w domain.Wish) error
	Delete(ctx context.Context, id uuid.UUID) error
}

type MonthlyBalanceRepository interface {
	// ListRecent は年月の降順で最大 limit 件を返す。
	ListRecent(ctx context.Context, limit int) ([]domain.MonthlyBalance, error)
	ListAll(ctx context.Context) ([]domain.MonthlyBalance, error)
	// Upsert は同一年月があれば更新、なければ作成し、保存後の姿を返す。
	//
	// 戻り値があるのは ID のため。既存行を更新した場合、DB は既存の ID を
	// 維持するので、呼び出し側が採番した ID は使われない。返さないと
	// 存在しない ID をレスポンスに載せることになる。
	Upsert(ctx context.Context, m domain.MonthlyBalance) (domain.MonthlyBalance, error)
}

type TransactionRepository interface {
	// List は発生日の降順で最大 limit 件を返す。
	List(ctx context.Context, limit int) ([]domain.Transaction, error)
	Create(ctx context.Context, t domain.Transaction) error
}

// TxManager はトランザクション境界を提供する。
//
// fn に渡される ctx を使ったリポジトリ操作は、同一トランザクションに
// 参加する。境界を usecase 層に閉じ込めるための仕組みで、handler や
// repository が個別にトランザクションを張ることはしない（不変条件10）。
//
// fn が error を返せばロールバックし、その error をそのまま返す。
type TxManager interface {
	RunInTx(ctx context.Context, fn func(ctx context.Context) error) error
}
