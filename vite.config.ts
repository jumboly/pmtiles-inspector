/// <reference types="vitest/config" />
import { defineConfig } from "vite";

export default defineConfig({
  // GitHub Pages のサブパス (/<repo>/) でも動くよう相対パスで出力する
  base: "./",
  // テスト用 fixture をそのまま「サンプル」として配信する（同じファイルでテストと画面の挙動を揃えるため）
  publicDir: "fixtures",
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
