import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 0.12 以降は src 側から wasm バイナリを直接 import しない
  // (wasm-pack の `init()` に URL 解決を委譲する) ため、専用の alias は不要。
  // lszr.js の import は各テストで `vi.mock('../../wasm/pkg/lszr.js', ...)` により
  // モックされるので、実 wasm が無い CI でも通る。
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
