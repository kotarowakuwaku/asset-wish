-- 定期入出金（給料・家賃）を足す。
--
-- 背景は docs/decisions.md 2.5。毎月同じ額が動くものを都度打つのは
-- 手間で、打ち忘れると残高がずれる。
--
-- ## 適用の記録を applied_through が持つ
--
-- 適用はアプリを開いたときにまとめて行う（Cron Trigger は使わない）。
-- 2ヶ月開かなければ、開いた時点で2ヶ月分をまとめて適用する。**同じ月を
-- 二度適用しないための記録が applied_through。** 「この年月までは適用済み」
-- を表す。
--
-- NULL を許さないのは、null の場合分けを計算から消すため。登録時に
-- **登録月の前月**を入れておけば、「起点は当月」が値そのもので表現でき、
-- 未適用月の算出は applied_through の翌月から、で一律になる。
--
-- ## transactions を作り直す理由
--
-- 適用の履歴に kind = 'recurring_applied' を使うが、**SQLite は CHECK 制約を
-- 後から足せない。** 制約を変えるにはテーブルを作り直すしかない（0002 で
-- loans を作り直したのと同じ事情）。件数は年間数百件なのでコストは問題に
-- ならない。

CREATE TABLE recurring_entries (
    id         TEXT    PRIMARY KEY,
    name       TEXT    NOT NULL,
    account_id TEXT    NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    -- 符号付き。給料は正、家賃は負。入出金の明細（transactions.amount）と
    -- 同じ約束にしてある。向きを別の列にすると、同じ値の表現が2つになる。
    amount     INTEGER NOT NULL CHECK (amount <> 0),
    -- 毎月の適用日。31 を指定した月末の無い月は、その月の末日に丸める
    -- （丸めは domain が行う。SQL には持たせない）。
    day_of_month INTEGER NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
    -- この年月までは適用済み。次に適用するのはこの翌月から。
    applied_through TEXT NOT NULL
        CHECK (applied_through GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 取引履歴を作り直す。kind に 'recurring_applied' を足すため。
-- 列の構成と既定値は 0001 + 0003（note）と同じ。
CREATE TABLE transactions_new (
    id          TEXT    PRIMARY KEY,
    account_id  TEXT    NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    amount      INTEGER NOT NULL,
    kind        TEXT    NOT NULL CHECK (kind IN (
                    'lending_created', 'lending_collected', 'wish_paid',
                    'adjustment', 'recurring_applied')),
    ref_id      TEXT,
    occurred_on TEXT    NOT NULL
        CHECK (occurred_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    note        TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO transactions_new (
    id, account_id, amount, kind, ref_id, occurred_on, note, created_at
)
SELECT id, account_id, amount, kind, ref_id, occurred_on, note, created_at
FROM transactions;

-- idx_transactions_account_date も一緒に消えるので張り直す。
DROP TABLE transactions;

ALTER TABLE transactions_new RENAME TO transactions;

CREATE INDEX idx_transactions_account_date ON transactions (account_id, occurred_on DESC);

-- 未適用の検出はアプリを開くたびに走る。適用日の判定は domain が行うため、
-- ここでは全件を読む前提の索引は張らない（年間数百件）。
