import { beforeEach, describe, expect, it } from 'vitest'
import { fixedClock, newFakes, sequentialIds } from '../../test/fakes'
import { expectRejectedDomainError, instantOf, SOME_INSTANT, yen } from '../../test/support'
import { Account } from '../domain/account'
import { AccountUsecase } from './account'
import { isNotFoundError } from './port'

const NOW = instantOf('2026-07-29T00:00:00Z')

let fakes: ReturnType<typeof newFakes>
let usecase: AccountUsecase

beforeEach(() => {
  fakes = newFakes()
  usecase = new AccountUsecase(fakes.accounts, fixedClock(NOW), sequentialIds('acc'))
})

function given(balance: number, name = 'テスト口座'): Account {
  const a = Account.create('acc-1', name, 'cash', yen(balance), SOME_INSTANT)
  fakes.accounts.seed(a)
  return a
}

describe('create', () => {
  it('採番と時刻は注入されたものを使う', async () => {
    const a = await usecase.create('新しい口座', 'cash', yen(1_000))
    expect(a.id).toBe('acc-1')
    expect(a.updatedAt).toBe(NOW)
    expect(await usecase.list()).toHaveLength(1)
  })

  it('名称が空なら domain が弾く', async () => {
    await expectRejectedDomainError(usecase.create('  ', 'cash', yen(0)), 'EMPTY_TITLE')
    expect(await usecase.list()).toHaveLength(0)
  })
})

describe('update', () => {
  // 名称を直しただけで「残高は最新」と見なすと、isStale による催促が効かなくなる。
  it('名称だけの更新では更新日時を進めない', async () => {
    given(500_000, '旧名')

    const a = await usecase.update('acc-1', { name: '新名' })

    expect(a.name).toBe('新名')
    expect(a.updatedAt).toBe(SOME_INSTANT)
  })

  it('残高を触ったときは更新日時を進める', async () => {
    given(500_000)

    const a = await usecase.update('acc-1', { balance: yen(600_000) })

    expect(a.balance).toBe(600_000)
    expect(a.updatedAt).toBe(NOW)
  })

  it('渡さなかった項目は変えない', async () => {
    given(500_000, '元の名前')
    const a = await usecase.update('acc-1', {})
    expect(a.name).toBe('元の名前')
    expect(a.balance).toBe(500_000)
  })

  it('名称が空なら弾かれ、保存もされない', async () => {
    given(500_000, '元の名前')
    await expectRejectedDomainError(usecase.update('acc-1', { name: '' }), 'EMPTY_TITLE')
    expect((await fakes.accounts.get('acc-1')).name).toBe('元の名前')
  })

  it('無ければ NotFoundError', async () => {
    await expect(usecase.update('missing', { name: 'x' })).rejects.toSatisfy(isNotFoundError)
  })
})

describe('delete', () => {
  it('削除できる', async () => {
    given(0)
    await usecase.delete('acc-1')
    expect(await usecase.list()).toHaveLength(0)
  })

  it('無いものを消そうとすれば NotFoundError', async () => {
    await expect(usecase.delete('missing')).rejects.toSatisfy(isNotFoundError)
  })
})
