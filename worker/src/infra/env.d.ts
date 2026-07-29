// wrangler types が生成する Cloudflare.Env に、secret を足す。
//
// secret は wrangler.jsonc に書けない（このリポジトリは public。不変条件17）。
// ローカルでは .dev.vars、本番では `wrangler secret put` で与える。
// 生成物に現れないため、型はここで宣言する。
//
// 省略可能にしているのは、未設定という状態が実際に起こりうるため。
// 型で「必ずある」ことにすると、無いまま起動して認証が素通りになる。
// wrangler types は Cloudflare.Env と、グローバルの Env の2つを出す。
// 片方だけ足すと構造が食い違って代入できなくなるため、両方に足す。
declare global {
  namespace Cloudflare {
    interface Env {
      AUTH_TOKEN?: string
    }
  }

  interface Env {
    AUTH_TOKEN?: string
  }
}

export {}
