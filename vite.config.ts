/// <reference types="vitest/config" />
import { defineConfig } from "vite";

export default defineConfig({
  // GitHub Pages のサブパス (/<repo>/) でも動くよう相対パスで出力する
  base: "./",
  // テスト用 fixture をそのまま「サンプル」として配信する（同じファイルでテストと画面の挙動を揃えるため）
  publicDir: "fixtures",
  build: {
    // MapLibre（約 1 MB）は archive を開いたときに dynamic import で読む別 chunk なので、初期表示の重さにはならない
    chunkSizeWarningLimit: 1100,
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
