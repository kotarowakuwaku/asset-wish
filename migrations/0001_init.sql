-- 初期スキーマ。docs/design.md 2.2 の DDL を SQLite（D1）に写したもの。
-- Postgres からの差分と、その理由は docs/migration-cloudflare.md 8章にある。
--
-- 型の対応:
--   UUID        -> TEXT       採番は crypto.randomUUID()
--   BIGINT      -> INTEGER    SQLite の INTEGER は最大8バイト
--   TIMESTAMPTZ -> TEXT       ISO8601。文字列比較で時系列順に並ぶ
--   DATE        -> TEXT       'YYYY-MM-DD'
--
-- Postgres では型そのものが日付らしさを保証していたが、TEXT には何の保証も
-- 無い。型が担っていた検査を CHECK + GLOB で埋め直している。

-- 口座
CREATE TABLE accounts (
    id         TEXT    PRIMARY KEY,
    name       TEXT    NOT NULL,
    kind       TEXT    NOT NULL CHECK (kind IN ('cash', 'investment')),
    balance    INTEGER NOT NULL,
    updated_at TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 立替
CREATE TABLE lendings (
    id               TEXT    PRIMARY KEY,
    counterparty     TEXT    NOT NULL,
    description      TEXT    NOT NULL DEFAULT '',
    amount           INTEGER NOT NULL CHECK (amount > 0),
    collected_amount INTEGER NOT NULL DEFAULT 0 CHECK (collected_amount >= 0),
    occurred_on      TEXT    NOT NULL
        CHECK (occurred_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- 過回収を DB 側で塞ぐ最後の防波堤（不変条件4）。
    CONSTRAINT lendings_collected_within_amount
        CHECK (collected_amount <= amount)
);

-- 未回収の一覧が主要な参照パターンのため部分インデックスを張る。
CREATE INDEX idx_lendings_outstanding
    ON lendings (occurred_on DESC)
    WHERE collected_amount < amount;

-- ウィッシュ
CREATE TABLE wishes (
    id         TEXT    PRIMARY KEY,
    title      TEXT    NOT NULL,
    amount     INTEGER NOT NULL CHECK (amount > 0),
    category   TEXT    NOT NULL CHECK (category IN ('item', 'experience', 'goal')),
    status     TEXT    NOT NULL CHECK (status IN ('considering', 'committed', 'done', 'dropped')),
    priority   INTEGER NOT NULL DEFAULT 0,
    deadline   TEXT
        CHECK (deadline IS NULL OR deadline GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_wishes_status_priority ON wishes (status, priority);

-- 月次収支
--
-- Postgres では DATE に月初日を入れ、date_trunc の CHECK でそれを保証していた。
-- SQLite に date_trunc が無いこと、および domain・API・front がいずれも
-- 'YYYY-MM' 形式で年月を扱っていることから、TEXT の 'YYYY-MM' に変更した。
-- 日を持たなければ、日がずれる余地そのものが消える。
CREATE TABLE monthly_balances (
    id         TEXT    PRIMARY KEY,
    year_month TEXT    NOT NULL UNIQUE
        CHECK (year_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
    income     INTEGER NOT NULL CHECK (income  >= 0),
    expense    INTEGER NOT NULL CHECK (expense >= 0),
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 取引履歴
--
-- ref_id は立替またはウィッシュを指す。参照先が2種類あるため外部キーは張れない
-- （docs/design.md 2.3）。
CREATE TABLE transactions (
    id          TEXT    PRIMARY KEY,
    account_id  TEXT    NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    amount      INTEGER NOT NULL,
    kind        TEXT    NOT NULL CHECK (kind IN (
                    'lending_created', 'lending_collected', 'wish_paid', 'adjustment')),
    ref_id      TEXT,
    occurred_on TEXT    NOT NULL
        CHECK (occurred_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_transactions_account_date ON transactions (account_id, occurred_on DESC);
