-- name: ListRecentMonthlyBalances :many
SELECT * FROM monthly_balances ORDER BY year_month DESC LIMIT $1;

-- name: ListAllMonthlyBalances :many
SELECT * FROM monthly_balances ORDER BY year_month DESC;

-- ON CONFLICT により PUT /api/monthly-balances/{yearMonth} が冪等になる。
--
-- id を返すのは、競合したときに渡した $1 が採用されないため。既存行の id は
-- そのまま維持されるので、呼び出し側が生成した UUID は捨てられる。それに
-- 気付かずレスポンスへ載せると、DB に存在しない id を返すことになる。
-- DO UPDATE は必ず1行返すので :one で受けられる。
--
-- name: UpsertMonthlyBalance :one
INSERT INTO monthly_balances (id, year_month, income, expense)
VALUES ($1, $2, $3, $4)
ON CONFLICT (year_month) DO UPDATE
SET income = EXCLUDED.income, expense = EXCLUDED.expense, updated_at = now()
RETURNING id;
