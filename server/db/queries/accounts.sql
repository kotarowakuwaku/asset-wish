-- name: ListAccounts :many
SELECT * FROM accounts ORDER BY kind, name;

-- name: GetAccount :one
SELECT * FROM accounts WHERE id = $1;

-- name: CreateAccount :exec
INSERT INTO accounts (id, name, kind, balance, updated_at)
VALUES ($1, $2, $3, $4, $5);

-- 更新は名称と残高だけ。kind をここに含めない。
--
-- PATCH /api/accounts/{id} が更新するのは名称・残高のみ（design.md 5.1）。
-- kind を cash から investment に変えられると、その口座が実質資産の計算から
-- 丸ごと消える（CLAUDE.md 不変条件1）。API に無い操作を SQL 側にも残さない。
-- 種別を変えたくなったら、作り直すか専用のクエリを足す。
--
-- name: UpdateAccount :exec
UPDATE accounts SET name = $2, balance = $3, updated_at = $4
WHERE id = $1;

-- name: DeleteAccount :exec
DELETE FROM accounts WHERE id = $1;
