-- 立替（lendings）を貸借（loans）にする。
--
-- 背景は docs/spec-changes.md の 2b。貸す／借りるの両方を扱うようになったため、
-- 「立替」という語が「借りた金」も指すことになり、名前と概念がずれた。
-- 用語を上位語の「貸借（Loan）」に作り直し、テーブル名・カラム名まで揃える
-- （不変条件14）。
--
-- ## RENAME ではなく作り直す理由
--
-- ALTER TABLE ... RENAME TO / RENAME COLUMN でも中身は移せるが、**名前付きの
-- CHECK 制約の名前は変わらない。** `lendings_collected_within_amount` が
-- loans テーブルに残り、違反時のエラーに旧名が出続ける。制約名を変えるには
-- どうせテーブルを作り直す必要がある。
--
-- 扱う件数は年間数百件なので、作り直しのコストは問題にならない。DDL が
-- 0001 と同じ形で読めることを優先する。
--
-- ## 既存行の direction
--
-- **すべて 'lent'（貸した）で埋める。** 変更前は「他人のために立て替えた金」
-- しか登録できなかったので、既存行はすべて貸した側で確定している。

CREATE TABLE loans (
    id             TEXT    PRIMARY KEY,
    -- 貸した / 借りた。金額は常に正で持ち、向きはこの列だけが表す。
    -- 符号で表さないのは、amount > 0 の CHECK を効かせ続けるため。
    direction      TEXT    NOT NULL CHECK (direction IN ('lent', 'borrowed')),
    counterparty   TEXT    NOT NULL,
    description    TEXT    NOT NULL DEFAULT '',
    amount         INTEGER NOT NULL CHECK (amount > 0),
    -- 精算済みの額。貸した側では回収、借りた側では返済にあたる。
    settled_amount INTEGER NOT NULL DEFAULT 0 CHECK (settled_amount >= 0),
    occurred_on    TEXT    NOT NULL
        CHECK (occurred_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- 過精算を DB 側で塞ぐ最後の防波堤（不変条件4）。
    CONSTRAINT loans_settled_within_amount
        CHECK (settled_amount <= amount)
);

INSERT INTO loans (
    id, direction, counterparty, description, amount, settled_amount,
    occurred_on, created_at, updated_at
)
SELECT
    id, 'lent', counterparty, description, amount, collected_amount,
    occurred_on, created_at, updated_at
FROM lendings;

-- idx_lendings_outstanding も一緒に消える。
DROP TABLE lendings;

-- 未精算の一覧が主要な参照パターンのため部分インデックスを張る。
CREATE INDEX idx_loans_outstanding
    ON loans (occurred_on DESC)
    WHERE settled_amount < amount;
