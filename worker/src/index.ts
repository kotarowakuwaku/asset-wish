// Worker のエントリポイント。
//
// /api/* だけがここに来る。それ以外のパスは front/dist の静的アセットが
// 手前で処理する（wrangler.jsonc の assets.run_worker_first を参照）。
//
// 依存の組み立ては手書きで行う。DI コンテナは使わない。依存関係を追うのに
// 別の仕組みを覚える必要がなく、結線が1箇所に見えるほうが学習目的に合う。

import { D1AccountRepository } from './adapter/repository/account'
import { D1LoanRepository } from './adapter/repository/loan'
import { D1MonthlyBalanceRepository } from './adapter/repository/monthlyBalance'
import { D1RecurringRepository } from './adapter/repository/recurring'
import { D1TransactionRepository } from './adapter/repository/transaction'
import { D1WishRepository } from './adapter/repository/wish'
import { D1AtomicWriter } from './adapter/repository/writer'
import { createApp } from './adapter/handler/app'
import { toErrorResponse } from './adapter/handler/errors'
import type { Deps } from './adapter/handler/services'
import { loadConfig } from './infra/config'
import { AccountUsecase } from './usecase/account'
import { DashboardUsecase } from './usecase/dashboard'
import { LoanUsecase } from './usecase/loan'
import { MonthlySummaryUsecase } from './usecase/monthlySummary'
import { RecurringUsecase } from './usecase/recurring'
import { newUUID, systemClock } from './usecase/port'
import { TransactionUsecase } from './usecase/transaction'
import { WishUsecase } from './usecase/wish'

/**
 * 結線。テストからも呼べるように公開している（統合テストで実 D1 に当てる）。
 */
export function buildDeps(env: Env): Deps {
  const { authToken } = loadConfig(env)

  // ここから下が結線。依存の向きは handler → usecase → domain。
  const accountRepo = new D1AccountRepository(env.DB)
  const loanRepo = new D1LoanRepository(env.DB)
  const wishRepo = new D1WishRepository(env.DB)
  const balanceRepo = new D1MonthlyBalanceRepository(env.DB)
  const transactionRepo = new D1TransactionRepository(env.DB)
  const recurringRepo = new D1RecurringRepository(env.DB)
  const writer = new D1AtomicWriter(env.DB)

  const now = systemClock
  const newID = newUUID

  return {
    accounts: new AccountUsecase(accountRepo, now, newID),
    // 貸し借りは口座を触らない（不変条件4）。accountRepo も Clock も要らない。
    loans: new LoanUsecase(writer, loanRepo, newID),
    wishes: new WishUsecase(writer, wishRepo, accountRepo, now, newID),
    // 月次の収支は明細から集計する。手入力の経路はもう無い。
    summaries: new MonthlySummaryUsecase(transactionRepo, balanceRepo),
    // 明細の登録・削除は口座残高を動かすため、writer と accountRepo が要る。
    transactions: new TransactionUsecase(writer, transactionRepo, accountRepo, now, newID),
    // 定期入出金は口座残高を動かすため、writer と accountRepo が要る。
    recurring: new RecurringUsecase(writer, recurringRepo, accountRepo, now, newID),
    dashboard: new DashboardUsecase(
      accountRepo,
      loanRepo,
      wishRepo,
      transactionRepo,
      balanceRepo,
      recurringRepo,
      now,
    ),
    now,
    authToken,
  }
}

// isolate が使い回される間は組み立て直さない。env の実体が変わったときだけ作る。
let cached: { env: Env; app: ReturnType<typeof createApp> } | null = null

function getApp(env: Env): ReturnType<typeof createApp> {
  if (cached === null || cached.env !== env) {
    cached = { env, app: createApp(buildDeps(env)) }
  }
  return cached.app
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      return await getApp(env).fetch(request, env, ctx)
    } catch (err) {
      // 設定不備はここに来る。起動の瞬間が無いランタイムなので、
      // 「起動させない」の代わりに「必ず 500 で落とす」で安全側に倒す。
      const { status, body } = toErrorResponse(err)
      return Response.json(body, { status })
    }
  },
} satisfies ExportedHandler<Env>
