-- name: ListLendings :many
SELECT * FROM lendings ORDER BY occurred_on DESC;

-- name: ListOutstandingLendings :many
SELECT * FROM lendings
WHERE collected_amount < amount
ORDER BY occurred_on DESC;

-- name: GetLending :one
SELECT * FROM lendings WHERE id = $1;

-- name: CreateLending :exec
INSERT INTO lendings (id, counterparty, description, amount, collected_amount, occurred_on)
VALUES ($1, $2, $3, $4, $5, $6);

-- 立替に対する更新操作は回収だけ。
--
-- API は登録・回収・削除の3つで、内容を編集する PATCH は無い（design.md 5.1）。
-- 全カラムを上書きするクエリを置くと、回収のついでに amount を書き換えられる
-- 経路ができる。amount が動くと未回収残高（amount - collected_amount）の
-- 意味が変わるため、SQL 側から塞いでおく。
--
-- 加算（collected_amount + $2）にしないのは、過回収の判定を SQL に持たせない
-- ため。回収後の金額は domain が検証したうえで確定させ、ここはその結果を
-- 書くだけにする（不変条件4の判定責務は domain）。DB の CHECK 制約は
-- 最後の防波堤として残っている。
--
-- name: UpdateLendingCollectedAmount :exec
UPDATE lendings SET collected_amount = $2, updated_at = now()
WHERE id = $1;

-- name: DeleteLending :exec
DELETE FROM lendings WHERE id = $1;
