import { expect, test } from '@playwright/test'

// 検証の配線が生きていることを確かめる最小の1本。
// ビルド成果物が実際のブラウザで開き、描画されるところまでを見る。
//
// 計算結果（実質資産・不足額・到達見込み）はここで検証しない。
// それは server 側の domain のユニットテストが担保している。
// E2E は導線だけに絞る。混ぜると、遅くて壊れやすいテストで
// 同じことを二度検証することになる（docs/design.md 6章）。
test('トップ画面が開く', async ({ page }) => {
  await page.goto('/')

  await expect(
    page.getByRole('heading', { name: '資産ウィッシュ' }),
  ).toBeVisible()
})
