import { describe, expect, it } from 'vitest'
import { parseHash, routes } from './router'

describe('parseHash', () => {
  it.each([
    ['#/dashboard', 'dashboard'],
    ['#/accounts', 'accounts'],
    ['#/transactions', 'transactions'],
    ['#/loans', 'loans'],
    ['#/wishes', 'wishes'],
    ['#/monthly-balances', 'monthly-balances'],
    ['#accounts', 'accounts'],
  ])('parseHash(%s) = %s', (hash, want) => {
    expect(parseHash(hash)).toBe(want)
  })

  // 直接開かれた URL が壊れていても、白い画面にはしない。
  it.each(['', '#', '#/', '#/unknown', '#/../etc'])(
    'parseHash(%s) は既定の画面にする',
    (hash) => {
      expect(parseHash(hash)).toBe('dashboard')
    },
  )
})

describe('routes', () => {
  it('要件 5.1 の画面が揃っている', () => {
    expect(routes.map((r) => r.path)).toEqual([
      'dashboard',
      'accounts',
      'transactions',
      'loans',
      'wishes',
      'monthly-balances',
    ])
  })

  it('すべてに表示名がある', () => {
    for (const route of routes) {
      expect(route.label).not.toBe('')
    }
  })
})
