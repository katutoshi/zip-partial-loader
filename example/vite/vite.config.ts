// 検証基準: この設定にはカスタムプラグインを一切書かない。
// `import LSZL from 'zip-partial-loader'` だけで
//   - Worker (dist/lszlw/lszlw.js) が自動的に別チャンクとして出力される
//   - wasm (wasm/pkg/lszr_bg.wasm) がハッシュ付きアセットとして自動配置される
// ことを確認する。もしここに `copyWorkerPlugin` 相当を書く必要が出たら
// zip-partial-loader 側の配布形態が退行している合図。
import { defineConfig } from 'vite';

export default defineConfig({});
