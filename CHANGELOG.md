0.12.1
------

- 不具合修正: Chrome 上で `LSZL` の初期化時に `RangeError: WebAssembly.Table.grow(): failed to grow table by 4` で必ず落ち、実質的にライブラリが機能しなかった問題を修正。0.11.0 以降 npm に publish されていた wasm の `__wbindgen_externrefs` エクスポートが funcref テーブル (max 固定) を指していた不整合が原因 (#24)
- 開発基盤: 生成 wasm の export → table 対応を `wasm/verify-exports.py` で assert し、`wasm/build.sh` の最終ゲートに組み込んだ (壊れた wasm が npm publish に流出する経路を build 時点で封じる)
- 開発基盤: CI (`.github/workflows/{release,ci}.yml`) の Binaryen (`wasm-opt`) を `apt-get install` から GitHub Release tarball の pin (`BINARYEN_VERSION: version_131`) に変更し、ubuntu-latest イメージ更新でサイレントに版がずれる経路を塞いだ

0.12.0
------

- 破壊的変更: UMD グローバル (`window.LSZL` 等) での配布を廃止し、ES モジュール (`import LSZL from 'zip-partial-loader'`) 専用の配布に変更
- 破壊的変更: `dist/lszlw.js` を配信ディレクトリに手コピーしてパス文字列 (`worker: '/static/dist/lszlw.js'` 等) で渡す運用を廃止。Worker/wasm はバンドラが `new URL(..., import.meta.url)` を静的解析して自動配置する方式に一本化
- 破壊的変更: `worker` オプション (`string | URL`) 自体は後方互換で残したが、渡す JS は module worker 前提になった (classic worker としての読み込みは非対応)
- 改善: Worker/wasm の解決をバンドラの自動配置に委ねたことで、Vite / webpack 5 / Rollup で copy プラグインや専用設定なしに動作するようになった
- 改善: `package.json` に `exports` フィールド (`.` / `./worker` / `./package.json`) を整備
- 改善: 配布形態を webpack バンドルから tsc + wasm-pack `--target web` の ESM 直配布に切り替え、`dist/lszl/lszl.d.ts` / `dist/lszlw/lszlw.d.ts` などの型定義を同梱するようになった
- 不具合修正: build を常に production モードで固定したうえで webpack バンドル自体を撤去したことで出力から `eval` が消え、Rollup/Vite の `EVAL` warning や CSP (`unsafe-eval` 未許可) 環境で動作しない問題が解消された
- 開発基盤: `example/vite/` に、bundler 側の追加設定なしで動作することを検証する最小サンプルを追加

0.11.1
------

- 不具合修正: npm パッケージに wasm ファイルが同梱されず、Worker が wasm を fetch する際に 404 になっていた問題を修正 (#15)

0.11.0
------

- 性能改善: ZIP エントリ検索を O(m²) から O(1)/O(log n) に最適化
- 性能改善/堅牢化: getRange の終端計算を partition_point に置き換え、壊れた ZIP への耐性を向上
- 不具合修正: WorkerWrapper.terminate() の this 束縛バグを修正
- 不具合修正: FragmentStorage が signal.onabort に未束縛の transaction.abort を渡していた問題を修正
- 不具合修正: cacheInMemory の未 catch Promise チェーンによる unhandled rejection を解消
- 開発基盤: パッケージマネージャを npm から pnpm に移行
- 開発基盤: CI (Biome lint / vitest / rustfmt / clippy) とユニットテストを整備
- 開発基盤: release-it によるリリースワークフローを追加

0.9.0
-----

- Fixed a bug that caused Warning in IE

0.7.0
-----

- Apply MIT License

0.6.2
-----

- Initial release

## [v0.13.0](https://github.com/katutoshi/zip-partial-loader/compare/v0.12.1...v0.13.0) - 2026-08-04

- リリースフローを release-it から tagpr に移行する by @katutoshi in https://github.com/katutoshi/zip-partial-loader/pull/27
- 内部モジュール名 LSZL/lszl/lszlw/lszr を kzpl に統一リネームする by @katutoshi in https://github.com/katutoshi/zip-partial-loader/pull/29
