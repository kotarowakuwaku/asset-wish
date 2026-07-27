-- 集計クエリは書かない。実質資産の計算は Go 側の純粋関数で行う
-- （CLAUDE.md 不変条件8）。

-- name: ListTransactions :many
SELECT * FROM transactions ORDER BY occurred_on DESC, created_at DESC LIMIT $1;

-- name: CreateTransaction :exec
INSERT INTO transactions (id, account_id, amount, kind, ref_id, occurred_on)
VALUES ($1, $2, $3, $4, $5, $6);
