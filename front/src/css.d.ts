// Expo テンプレート由来の CSS import に型を与えるための暫定シム。
// これが無いと tsc が TS2307 / TS2882 で落ち、front の検証ゲートが常時赤になる。
//
// front を Vite + React に作り直した時点で、vite/client の型定義
// （`/// <reference types="vite/client" />`）が同じ役割を担うため、
// このファイルは削除してよい。

declare module '*.module.css' {
  const classes: Record<string, string>;
  export default classes;
}

declare module '*.css';
