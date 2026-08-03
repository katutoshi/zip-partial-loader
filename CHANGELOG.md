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
