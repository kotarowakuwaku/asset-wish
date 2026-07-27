package usecase_test

import (
	"context"
	"maps"
	"slices"
	"sort"

	"github.com/google/uuid"

	"github.com/kotarowakuwaku/asset-wish/server/internal/domain"
	"github.com/kotarowakuwaku/asset-wish/server/internal/usecase"
)

// usecase 層のテストは手書きの fake を使う。
//
// ここで確かめたいのは「手順が正しいか」——どの順で何を呼び、失敗時に
// どこまで戻すか——であって、SQL が動くかではない。SQL は
// adapter/repository のテストが実物の DB に対して確かめている。
//
// fake は本物の repository と同じ制約を守ること。とくに更新系が
// 特定の項目しか書かない点を再現しないと、ここでは通るのに本番では
// 通らないテストができる。

type fakeData struct {
	accounts     map[uuid.UUID]domain.Account
	lendings     map[uuid.UUID]domain.Lending
	wishes       map[uuid.UUID]domain.Wish
	balances     map[string]domain.MonthlyBalance
	transactions []domain.Transaction
}

func newFakeData() *fakeData {
	return &fakeData{
		accounts: map[uuid.UUID]domain.Account{},
		lendings: map[uuid.UUID]domain.Lending{},
		wishes:   map[uuid.UUID]domain.Wish{},
		balances: map[string]domain.MonthlyBalance{},
	}
}

func (d *fakeData) clone() *fakeData {
	return &fakeData{
		accounts:     maps.Clone(d.accounts),
		lendings:     maps.Clone(d.lendings),
		wishes:       maps.Clone(d.wishes),
		balances:     maps.Clone(d.balances),
		transactions: slices.Clone(d.transactions),
	}
}

// fakeTx は TxManager の fake。
//
// fn が失敗したら、呼ぶ前の状態に丸ごと戻す。本物のロールバックと
// 同じ観測結果になるので、「失敗したのに一部だけ残る」を検出できる。
type fakeTx struct {
	data *fakeData
	// depth は入れ子の深さ。内側で巻き戻さないことを確かめるために持つ。
	depth int
}

func (f *fakeTx) RunInTx(ctx context.Context, fn func(ctx context.Context) error) error {
	if f.depth > 0 {
		// 入れ子は外側に相乗りする。ここで独立して巻き戻すと、
		// 外側が失敗しても内側の書き込みだけが残ることになる。
		return fn(ctx)
	}

	snapshot := f.data.clone()
	f.depth++
	defer func() { f.depth-- }()

	if err := fn(ctx); err != nil {
		*f.data = *snapshot
		return err
	}
	return nil
}

type fakeAccounts struct{ data *fakeData }

func (r *fakeAccounts) List(ctx context.Context) ([]domain.Account, error) {
	accounts := slices.Collect(maps.Values(r.data.accounts))
	sort.Slice(accounts, func(i, j int) bool { return accounts[i].Name < accounts[j].Name })
	return accounts, nil
}

func (r *fakeAccounts) Get(ctx context.Context, id uuid.UUID) (domain.Account, error) {
	a, ok := r.data.accounts[id]
	if !ok {
		return domain.Account{}, usecase.ErrNotFound
	}
	return a, nil
}

func (r *fakeAccounts) Create(ctx context.Context, a domain.Account) error {
	r.data.accounts[a.ID] = a
	return nil
}

// Update は名称・残高・更新日時だけを反映する。Kind は動かさない。
// 本物のクエリが kind を含まないため（不変条件1）。
func (r *fakeAccounts) Update(ctx context.Context, a domain.Account) error {
	stored, ok := r.data.accounts[a.ID]
	if !ok {
		return usecase.ErrNotFound
	}
	stored.Name = a.Name
	stored.Balance = a.Balance
	stored.UpdatedAt = a.UpdatedAt
	r.data.accounts[a.ID] = stored
	return nil
}

func (r *fakeAccounts) Delete(ctx context.Context, id uuid.UUID) error {
	// 取引履歴が残っていれば消せない（DDL の ON DELETE RESTRICT）。
	for _, t := range r.data.transactions {
		if t.AccountID == id {
			return domain.ErrAccountInUse
		}
	}
	delete(r.data.accounts, id)
	return nil
}

type fakeLendings struct{ data *fakeData }

func (r *fakeLendings) List(ctx context.Context, outstandingOnly bool) ([]domain.Lending, error) {
	lendings := make([]domain.Lending, 0, len(r.data.lendings))
	for _, l := range r.data.lendings {
		if outstandingOnly && l.IsFullyCollected() {
			continue
		}
		lendings = append(lendings, l)
	}
	sort.Slice(lendings, func(i, j int) bool {
		return lendings[i].OccurredOn.After(lendings[j].OccurredOn)
	})
	return lendings, nil
}

func (r *fakeLendings) Get(ctx context.Context, id uuid.UUID) (domain.Lending, error) {
	l, ok := r.data.lendings[id]
	if !ok {
		return domain.Lending{}, usecase.ErrNotFound
	}
	return l, nil
}

func (r *fakeLendings) Create(ctx context.Context, l domain.Lending) error {
	r.data.lendings[l.ID] = l
	return nil
}

// UpdateCollected は回収額だけを反映する。立替額は動かさない（不変条件4）。
func (r *fakeLendings) UpdateCollected(ctx context.Context, l domain.Lending) error {
	stored, ok := r.data.lendings[l.ID]
	if !ok {
		return usecase.ErrNotFound
	}
	stored.CollectedAmount = l.CollectedAmount
	r.data.lendings[l.ID] = stored
	return nil
}

func (r *fakeLendings) Delete(ctx context.Context, id uuid.UUID) error {
	delete(r.data.lendings, id)
	return nil
}

type fakeWishes struct{ data *fakeData }

func (r *fakeWishes) List(ctx context.Context, status *domain.WishStatus) ([]domain.Wish, error) {
	wishes := make([]domain.Wish, 0, len(r.data.wishes))
	for _, w := range r.data.wishes {
		if status != nil && w.Status != *status {
			continue
		}
		wishes = append(wishes, w)
	}
	sort.Slice(wishes, func(i, j int) bool { return wishes[i].Priority < wishes[j].Priority })
	return wishes, nil
}

func (r *fakeWishes) Get(ctx context.Context, id uuid.UUID) (domain.Wish, error) {
	w, ok := r.data.wishes[id]
	if !ok {
		return domain.Wish{}, usecase.ErrNotFound
	}
	return w, nil
}

func (r *fakeWishes) Create(ctx context.Context, w domain.Wish) error {
	r.data.wishes[w.ID] = w
	return nil
}

// UpdateContent は内容だけを反映する。Status は動かさない（不変条件6）。
func (r *fakeWishes) UpdateContent(ctx context.Context, w domain.Wish) error {
	stored, ok := r.data.wishes[w.ID]
	if !ok {
		return usecase.ErrNotFound
	}
	stored.Title = w.Title
	stored.Amount = w.Amount
	stored.Category = w.Category
	stored.Priority = w.Priority
	stored.Deadline = w.Deadline
	r.data.wishes[w.ID] = stored
	return nil
}

// UpdateStatus は状態だけを反映する。内容は動かさない。
func (r *fakeWishes) UpdateStatus(ctx context.Context, w domain.Wish) error {
	stored, ok := r.data.wishes[w.ID]
	if !ok {
		return usecase.ErrNotFound
	}
	stored.Status = w.Status
	r.data.wishes[w.ID] = stored
	return nil
}

func (r *fakeWishes) Delete(ctx context.Context, id uuid.UUID) error {
	delete(r.data.wishes, id)
	return nil
}

type fakeBalances struct{ data *fakeData }

func (r *fakeBalances) ListAll(ctx context.Context) ([]domain.MonthlyBalance, error) {
	balances := slices.Collect(maps.Values(r.data.balances))
	sort.Slice(balances, func(i, j int) bool {
		return balances[i].YearMonth.After(balances[j].YearMonth)
	})
	return balances, nil
}

func (r *fakeBalances) ListRecent(ctx context.Context, limit int) ([]domain.MonthlyBalance, error) {
	all, err := r.ListAll(ctx)
	if err != nil {
		return nil, err
	}
	if limit > 0 && len(all) > limit {
		all = all[:limit]
	}
	return all, nil
}

// Upsert は既存があれば ID を維持する。本物の ON CONFLICT DO UPDATE と同じ。
func (r *fakeBalances) Upsert(ctx context.Context, m domain.MonthlyBalance) (domain.MonthlyBalance, error) {
	key := m.YearMonth.String()
	if stored, ok := r.data.balances[key]; ok {
		m.ID = stored.ID
	}
	r.data.balances[key] = m
	return m, nil
}

type fakeTransactions struct{ data *fakeData }

func (r *fakeTransactions) List(ctx context.Context, limit int) ([]domain.Transaction, error) {
	transactions := slices.Clone(r.data.transactions)
	sort.Slice(transactions, func(i, j int) bool {
		return transactions[i].OccurredOn.After(transactions[j].OccurredOn)
	})
	if limit > 0 && len(transactions) > limit {
		transactions = transactions[:limit]
	}
	return transactions, nil
}

func (r *fakeTransactions) Create(ctx context.Context, t domain.Transaction) error {
	r.data.transactions = append(r.data.transactions, t)
	return nil
}

// インターフェースを満たしていることをコンパイル時に確かめる。
var (
	_ usecase.AccountRepository        = (*fakeAccounts)(nil)
	_ usecase.LendingRepository        = (*fakeLendings)(nil)
	_ usecase.WishRepository           = (*fakeWishes)(nil)
	_ usecase.MonthlyBalanceRepository = (*fakeBalances)(nil)
	_ usecase.TransactionRepository    = (*fakeTransactions)(nil)
	_ usecase.TxManager                = (*fakeTx)(nil)
)
