// 表示整形。外部依存を持たない純粋関数だけを置く。
//
// 計算はしない。実質資産・不足額・到達見込みはサーバーの domain が
// 算出済みで、front は受け取った値を並べるだけ（CLAUDE.md 不変条件8）。
// ここで再計算すると、同じ式が2箇所に増えて必ずずれる。

/**
 * formatMoney は金額を「¥1,234,567」の形にする。
 * 負値は「-¥1,234」。server の domain.Money.String() と同じ体裁。
 */
export function formatMoney(amount: number): string {
  const negative = amount < 0
  const digits = Math.abs(amount).toString()

  let grouped = ''
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) {
      grouped += ','
    }
    grouped += digits[i]
  }
  return `${negative ? '-' : ''}¥${grouped}`
}

/**
 * formatMonths は到達見込みを表示用にする。
 *
 * null は「算出不可」。0 と混同してはいけない。平均月間余剰が 0 以下、
 * または月次収支が1件も無いときにこうなる。ここで「0ヶ月」と出すと
 * 「今月中に届く」と読めてしまう。
 */
export function formatMonths(months: number | null): string {
  if (months === null) {
    return '算出不可'
  }
  return `あと${months}ヶ月`
}

/**
 * formatShortfall は不足額を表示用にする。
 * 0 以下ならすでに手が届いている。
 */
export function formatShortfall(shortfall: number): string {
  if (shortfall <= 0) {
    return '到達済み'
  }
  return `あと${formatMoney(shortfall)}`
}

/**
 * formatMonthlySaving は「毎月いくら貯めればよいか」を表示用にする。
 *
 * null は算出不可。期限が無い、期限が過ぎている、すでに手が届く、のいずれか。
 * 0 円と書くと「貯めなくてよい」に見えるため、必ず区別する。
 */
export function formatMonthlySaving(amount: number | null): string {
  if (amount === null) {
    return '—'
  }
  return `毎月${formatMoney(amount)}`
}

const wishStatusLabels: Record<string, string> = {
  considering: '検討中',
  committed: '確定',
  done: '完了',
  dropped: '見送り',
}

export function wishStatusLabel(status: string): string {
  return wishStatusLabels[status] ?? status
}

const wishCategoryLabels: Record<string, string> = {
  item: 'もの',
  experience: '体験',
  goal: '目標',
}

export function wishCategoryLabel(category: string): string {
  return wishCategoryLabels[category] ?? category
}

const settlementStatusLabels: Record<string, string> = {
  unsettled: '未精算',
  partial: '一部精算',
  settled: '精算済み',
}

export function settlementStatusLabel(status: string): string {
  return settlementStatusLabels[status] ?? status
}

// 向きは金額の符号に表れない（どちらも正）。画面ではこのラベルだけが
// 貸したのか借りたのかを伝える。
const loanDirectionLabels: Record<string, string> = {
  lent: '貸した',
  borrowed: '借りた',
}

export function loanDirectionLabel(direction: string): string {
  return loanDirectionLabels[direction] ?? direction
}

const accountKindLabels: Record<string, string> = {
  cash: '現金・預金',
  investment: '投資',
}

export function accountKindLabel(kind: string): string {
  return accountKindLabels[kind] ?? kind
}

const transactionKindLabels: Record<string, string> = {
  // 貸し借りの2種はもう新しく作られない。貸し借りは口座残高を動かさなくなったため
  // （不変条件4）。2026-07-30 より前の履歴を表示するために残してある。
  lending_created: '貸し借りの発生',
  lending_collected: '貸し借りの精算',
  wish_paid: 'ウィッシュの支払い',
  // 手入力の明細。以前は「残高の調整」と呼んでいたが、作る経路が無く
  // 1件も存在しなかった。入出金を打てるようにしたのに伴い意味を与えた。
  adjustment: '入出金',
}

export function transactionKindLabel(kind: string): string {
  return transactionKindLabels[kind] ?? kind
}

/**
 * formatSurplus は月間余剰を符号つきで表示する。
 * 黒字と赤字を一目で分かるようにするため（要件 F-17）。
 */
export function formatSurplus(surplus: number): string {
  if (surplus > 0) {
    return `+${formatMoney(surplus)}`
  }
  return formatMoney(surplus)
}

/** formatDate は YYYY-MM-DD を「2026/07/12」の形にする。 */
export function formatDate(date: string): string {
  return date.replaceAll('-', '/')
}

/** todayISO は今日の日付を YYYY-MM-DD で返す。フォームの初期値に使う。 */
export function todayISO(now: Date = new Date()): string {
  const year = now.getFullYear().toString().padStart(4, '0')
  const month = (now.getMonth() + 1).toString().padStart(2, '0')
  const day = now.getDate().toString().padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** currentYearMonth は今月を YYYY-MM で返す。 */
export function currentYearMonth(now: Date = new Date()): string {
  return todayISO(now).slice(0, 7)
}

/**
 * parseAmount は入力欄の文字列を金額に変換する。
 *
 * 空・数値でない・小数・負値は受け付けない。小数を弾くのは、
 * 円未満の金額が存在しないため（server も整数で持つ）。
 */
export function parseAmount(input: string): number | null {
  const trimmed = input.trim()
  if (trimmed === '' || !/^\d+$/.test(trimmed)) {
    return null
  }
  const value = Number(trimmed)
  return Number.isSafeInteger(value) ? value : null
}
