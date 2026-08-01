import { expect, test, type Page } from '@playwright/test'

// E2E は導線に絞る。登録できる、一覧に出る、状態遷移のボタンが効く、まで。
//
// 計算結果（実質資産・不足額・到達見込み）はここで検証しない。それは
// server 側の domain のユニットテストが担保している。混ぜると、遅くて
// 壊れやすいテストで同じことを二度検証することになる（docs/architecture.md 8章）。
//
// API はブラウザ側で差し替える。**サーバーも DB も起動しない。**
// ここで見たいのは画面の配線であって、サーバーの正しさではない。
// 実物との噛み合わせは server 側のテストが受け持つ。
//
// 値はすべて架空のもの（CLAUDE.md 不変条件17）。

const token = 'e2e-token'

type Wish = {
  id: string
  title: string
  amount: number
  category: string
  status: string
  priority: number
  deadline: string | null
}

/** setupApi は API の応答を差し替える。状態はブラウザの外（この配列）で持つ。 */
async function setupApi(page: Page, initialWishes: Wish[] = []) {
  const wishes = [...initialWishes]
  const transactions: Record<string, unknown>[] = []

  await page.route('**/api/dashboard', (route) =>
    route.fulfill({
      json: {
        netAsset: 830000,
        breakdown: {
          cashTotal: 910000,
          commitments: 80000,
        },
        investmentTotal: 350000,
        outstandingLent: 12000,
        outstandingBorrowed: 5000,
        averageSurplus: 65000,
        hasAverageSurplus: true,
        pendingRecurringCount: 0,
        pendingRecurringTotal: 0,
        wishes: wishes.map((w) => ({
          ...w,
          shortfall: 358000,
          monthsToReach: 6,
        monthlySavingNeeded: null,
        })),
      },
    }),
  )

  await page.route('**/api/accounts', (route) =>
    route.fulfill({
      json: [
        {
          id: 'account-1',
          name: '生活用',
          kind: 'cash',
          balance: 910000,
          updatedAt: '2026-07-27T10:00:00Z',
          isStale: false,
        },
      ],
    }),
  )

  await page.route('**/api/loans*', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/recurring-entries*', (route) => route.fulfill({ json: [] }))

  // 入出金は状態を持つ。打った明細が一覧に出ることを見たいため。
  await page.route('**/api/transactions**', async (route) => {
    const request = route.request()

    if (request.method() === 'POST') {
      const body = request.postDataJSON() as {
        accountId: string
        amount: number
        occurredOn: string
        note: string
      }
      const created = {
        id: `tx-${transactions.length + 1}`,
        accountId: body.accountId,
        amount: body.amount,
        kind: 'adjustment',
        refId: null,
        occurredOn: body.occurredOn,
        note: body.note,
      }
      transactions.push(created)
      await route.fulfill({ json: created })
      return
    }

    await route.fulfill({ json: transactions })
  })
  await page.route('**/api/monthly-summaries*', (route) =>
    route.fulfill({ json: [] }),
  )

  // ウィッシュだけは状態を持つ。登録と遷移が一覧に反映されることを見たいため。
  await page.route('**/api/wishes**', async (route) => {
    const request = route.request()
    const url = request.url()

    if (request.method() === 'POST' && url.includes('/commit')) {
      const id = url.split('/api/wishes/')[1].split('/')[0]
      const found = wishes.find((w) => w.id === id)
      if (found) found.status = 'committed'
      await route.fulfill({ json: found ?? null })
      return
    }

    if (request.method() === 'POST') {
      const body = request.postDataJSON() as { title: string; amount: number }
      const created: Wish = {
        id: `wish-${wishes.length + 1}`,
        title: body.title,
        amount: body.amount,
        category: 'item',
        status: 'considering',
        priority: 0,
        deadline: null,
      }
      wishes.push(created)
      await route.fulfill({ json: created })
      return
    }

    const status = new URL(url).searchParams.get('status')
    await route.fulfill({
      json: status ? wishes.filter((w) => w.status === status) : wishes,
    })
  })
}

/** signIn はトークンを入れてアプリに入る。 */
async function signIn(page: Page) {
  await page.goto('/')
  await page.getByLabel('トークン').fill(token)
  await page.getByRole('button', { name: '保存する' }).click()
}

test('トークンを入れるとダッシュボードが開く', async ({ page }) => {
  await setupApi(page)
  await signIn(page)

  await expect(page.getByRole('heading', { name: '実質資産' })).toBeVisible()
})

test('画面を切り替えられる', async ({ page }) => {
  await setupApi(page)
  await signIn(page)

  for (const label of [
    '口座',
    '入出金',
    '定期',
    '貸し借り',
    'ウィッシュ',
    '月次収支',
  ] as const) {
    await page.getByRole('button', { name: label, exact: true }).click()
    await expect(
      page.getByRole('heading', { name: label, exact: true }),
    ).toBeVisible()
  }
})

test('ウィッシュを登録すると一覧に出る', async ({ page }) => {
  await setupApi(page)
  await signIn(page)

  await page.getByRole('button', { name: 'ウィッシュ', exact: true }).click()
  await expect(page.getByText('該当するウィッシュはありません。')).toBeVisible()

  await page.getByLabel('タイトル').fill('カメラ')
  await page.getByLabel('金額').fill('120000')
  await page.getByRole('button', { name: '登録する' }).click()

  // 一覧の中を見る。絞り込みのタブにも同じ文言があるため、
  // 画面全体から探すと取り違える。
  const item = page.getByRole('listitem').filter({ hasText: 'カメラ' })
  await expect(item).toBeVisible()
  // 新規は必ず検討中から始まる（不変条件3）。
  await expect(item.getByText('検討中')).toBeVisible()
})

test('確定のボタンが効く', async ({ page }) => {
  await setupApi(page, [
    {
      id: 'wish-1',
      title: 'カメラ',
      amount: 120000,
      category: 'item',
      status: 'considering',
      priority: 0,
      deadline: null,
    },
  ])
  await signIn(page)

  await page.getByRole('button', { name: 'ウィッシュ', exact: true }).click()
  await page.getByRole('button', { name: '確定する' }).click()

  const item = page.getByRole('listitem').filter({ hasText: 'カメラ' })
  await expect(item.getByText('確定', { exact: true })).toBeVisible()
  // 確定済みには「確定する」を出さない。
  await expect(page.getByRole('button', { name: '確定する' })).toHaveCount(0)
})

test('入出金を打つと一覧に出る', async ({ page }) => {
  await setupApi(page)
  await signIn(page)

  await page.getByRole('button', { name: '入出金', exact: true }).click()
  await expect(page.getByText('入出金がまだありません。')).toBeVisible()

  await page.getByLabel('金額').fill('3000')
  await page.getByLabel('メモ').fill('コンビニ')
  await page.getByRole('button', { name: '打つ' }).click()

  const item = page.getByRole('listitem').filter({ hasText: 'コンビニ' })
  await expect(item).toBeVisible()
  // 出金は負で送られ、負のまま戻る。符号がそのまま向きを表す。
  await expect(item.getByText('-¥3,000')).toBeVisible()
})

test('トークンが無ければ入力を求める', async ({ page }) => {
  await setupApi(page)
  await page.goto('/')

  await expect(page.getByLabel('トークン')).toBeVisible()
  await expect(page.getByRole('button', { name: 'ダッシュボード' })).toHaveCount(
    0,
  )
})
