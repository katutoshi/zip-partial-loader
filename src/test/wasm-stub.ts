// wasm/pkg/lszr_bg.wasm 用のテスト時スタブ。
// Vite は .wasm 拡張子を特別扱いして "ESM integration proposal for Wasm is not supported"
// で失敗するため、vitest.config.ts の alias でこのスタブに差し替えて回避する。
// 実際のバイト列は不要で、URL 文字列があれば十分 (テスト側で vi.mock '../../wasm/pkg/lszr' が
// init(wasmUrl) を no-op にするので、この値は参照されない)。
export default 'stub-wasm-url';
