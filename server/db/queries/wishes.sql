-- name: ListWishes :many
SELECT * FROM wishes ORDER BY priority, created_at;

-- name: ListWishesByStatus :many
SELECT * FROM wishes WHERE status = $1 ORDER BY priority, created_at;

-- name: GetWish :one
SELECT * FROM wishes WHERE id = $1;

-- name: CreateWish :exec
INSERT INTO wishes (id, title, amount, category, status, priority, deadline)
VALUES ($1, $2, $3, $4, $5, $6, $7);

-- 内容の更新と状態遷移でクエリを分ける。
--
-- 1本の UPDATE で status も書けるようにすると、handler が
-- 「PATCH で status を渡せば済む」経路を作れてしまい、遷移の可否を
-- 判定する domain のエンティティメソッドを迂回できる（不変条件6）。
-- SQL で書けなければ、そもそも間違えようがない。

-- 内容の更新。PATCH /api/wishes/{id} が触る範囲（detailed-design 6.4）に対応する。
--
-- category は含める。もの・体験・目標の付け替えは、どの不変条件にも
-- 触れない単なる分類の変更なので、status と同じ扱いにする理由が無い。
--
-- name: UpdateWishContent :exec
UPDATE wishes
SET title = $2, amount = $3, category = $4, priority = $5, deadline = $6,
    updated_at = now()
WHERE id = $1;

-- 状態遷移。/commit /pay /drop の3エンドポイントが共通で使う。
-- 遷移して良いかは domain の Wish が判定済みである前提で、結果だけを書く。
--
-- name: UpdateWishStatus :exec
UPDATE wishes SET status = $2, updated_at = now()
WHERE id = $1;

-- name: DeleteWish :exec
DELETE FROM wishes WHERE id = $1;
