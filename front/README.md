# front

資産ウィッシュのフロントエンド。Vite + React + TypeScript の SPA。

まだ画面は作っていない（段階6）。現時点で入っているのは**検証の骨組み**だけで、
それが実際に動くことを1本ずつのテストで確かめてある。

## セットアップ

```bash
npm ci
npx playwright install chromium

# Linux / WSL のみ。sudo が要るので手動で実行する。
# これが無いと libnspr4.so が見つからずブラウザが起動しない。
sudo npx playwright install-deps chromium
```

## 検証

```bash
npm run check
```

typecheck → oxlint → Vitest → Playwright の順に走る。**個別のコマンドを覚えるより、これ一本を通す。**
CI の front ジョブも同じコマンドを実行しているので、ここが緑なら CI も緑になる。

| コマンド | 内容 |
| --- | --- |
| `npm run dev` | 開発サーバー |
| `npm run check` | 上記4つを一括。ループの停止条件 |
| `npx playwright test --ui` | E2E を目視で追う |

## 方針

- **E2E で計算結果を検証しない。** 実質資産・不足額・到達見込みの正しさは
  `worker/src/domain` のユニットテストが担保している。E2E は導線（登録できる、
  一覧に出る、ボタンが効く）に絞る。混ぜると、遅くて壊れやすいテストで二度検証することになる
- E2E は dev サーバーではなく `build` した成果物に対して実行する。配信するのはビルド結果なので、
  検証対象を本番と揃える
- linter は eslint ではなく oxlint。理由は `docs/requirements.md` 9.1 #12。
  型情報を使うルールが必要になったら `oxlint-tsgolint` を入れて `.oxlintrc.json` に
  `"options": { "typeAware": true }` を足せば有効にできる
