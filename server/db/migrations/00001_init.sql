-- 初期スキーマ。docs/design.md 2.2 の DDL をそのまま写したもの。
-- 変更するときは設計書の側も必ず合わせて直すこと。

-- +goose Up

-- 口座
CREATE TABLE accounts (
    id          UUID PRIMARY KEY,
    name        TEXT        NOT NULL,
    kind        TEXT        NOT NULL CHECK (kind IN ('cash', 'investment')),
    balance     BIGINT      NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 立替
CREATE TABLE lendings (
    id               UUID        PRIMARY KEY,
    counterparty     TEXT        NOT NULL,
    description      TEXT        NOT NULL DEFAULT '',
    amount           BIGINT      NOT NULL CHECK (amount > 0),
    collected_amount BIGINT      NOT NULL DEFAULT 0 CHECK (collected_amount >= 0),
    occurred_on      DATE        NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT lendings_collected_within_amount
        CHECK (collected_amount <= amount)
);

-- 未回収の一覧が主要な参照パターンのため部分インデックスを張る。
CREATE INDEX idx_lendings_outstanding
    ON lendings (occurred_on DESC)
    WHERE collected_amount < amount;

-- ウィッシュ
CREATE TABLE wishes (
    id         UUID        PRIMARY KEY,
    title      TEXT        NOT NULL,
    amount     BIGINT      NOT NULL CHECK (amount > 0),
    category   TEXT        NOT NULL CHECK (category IN ('item', 'experience', 'goal')),
    status     TEXT        NOT NULL CHECK (status IN ('considering', 'committed', 'done', 'dropped')),
    priority   INTEGER     NOT NULL DEFAULT 0,
    deadline   DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_wishes_status_priority ON wishes (status, priority);

-- 月次収支
CREATE TABLE monthly_balances (
    id         UUID        PRIMARY KEY,
    year_month DATE        NOT NULL UNIQUE,
    income     BIGINT      NOT NULL CHECK (income  >= 0),
    expense    BIGINT      NOT NULL CHECK (expense >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT monthly_balances_is_first_day
        CHECK (year_month = date_trunc('month', year_month)::date)
);

-- 取引履歴
CREATE TABLE transactions (
    id          UUID        PRIMARY KEY,
    account_id  UUID        NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    amount      BIGINT      NOT NULL,
    kind        TEXT        NOT NULL CHECK (kind IN (
                    'lending_created', 'lending_collected', 'wish_paid', 'adjustment')),
    ref_id      UUID,
    occurred_on DATE        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_transactions_account_date ON transactions (account_id, occurred_on DESC);

-- +goose Down

DROP TABLE transactions;
DROP TABLE monthly_balances;
DROP TABLE wishes;
DROP TABLE lendings;
DROP TABLE accounts;
