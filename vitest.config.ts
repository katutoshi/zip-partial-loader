import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Vite は .wasm 拡張子を組み込みで処理しようとして
  // "ESM integration proposal for Wasm is not supported" で失敗する。
  // テスト実行時は wasm 実物を必要としないため、URL 文字列を返すだけのスタブに置換する。
  resolve: {
    alias: {
      '../../wasm/pkg/lszr_bg.wasm': fileURLToPath(new URL('./src/test/wasm-stub.ts', import.meta.url)),
    },
  },
  test: {
    // tsc の outDir (lib/) にコンパイル済みテスト (.test.js) が出力されるため、
    // ビルド後にテストを実行すると同じテストが二重に走る。対象を src/ に限定する。
    include: ['src/**/*.test.ts'],
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**'],
      exclude: ['src/**/*.test.ts', 'src/test/**'],
    },
  },
});
