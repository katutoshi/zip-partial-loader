# リリース手順

このパッケージは [release-it](https://github.com/release-it/release-it) を使い、
GitHub Actions ワークフロー (`.github/workflows/release.yml`) から手動でリリースする。

## 前提

- **設定が必要なシークレットは 1 つだけ**
  - `NPM_TOKEN`: npmjs.org へ publish 可能なアクセストークン (Automation token 推奨) を
    リポジトリの Actions シークレットに登録する
  - `GITHUB_TOKEN` は Actions が実行時に自動で払い出す (`secrets.GITHUB_TOKEN`) ので追加設定不要
- ワークフローの `permissions` は `contents: write` のみ (タグ push と GitHub Release 作成に必要)
- Node.js 22 / Rust stable / wasm-pack `v0.13.1` / binaryen (`wasm-opt`) はワークフロー内で自動セットアップされる
- リリースは `master` ブランチからのみ実行できる (workflow の `if` ガードと
  `.release-it.js` の `git.requireBranch: 'master'` の二段で担保)

## 事前確認: 次に付けるバージョン

`package.json` の `version` を上げる前に必ず以下を確認する。**npm 側のバージョン
番号が git タグと不整合になっていた過去実績があり、npm publish は E403 で止まる**
ため、既に npm 公開済みの番号は使い回せない。

```sh
npm view zip-partial-loader versions
```

現状の実績:

| 場所 | 最新 |
| ---- | ---- |
| npm レジストリ | `0.10.2` (`0.10.0` / `0.10.1` / `0.10.2` が公開済み) |
| git タグ / GitHub Release | `v0.10.0` のみ |

つまり **次のリリースは最低でも `0.10.3` 以上**にする必要がある (それ未満だと
`npm publish` が 403 で失敗する)。

## 通常のリリース手順 (GitHub Actions から実行)

1. **`package.json` の `version` を更新する**
   - SemVer に従って上げる。上記「事前確認」で得た npm 側最新より必ず大きくする
     (例: 現状なら次は `0.10.3` から)
2. **`CHANGELOG.md` に新バージョンの見出しを追記する**
   - 既存フォーマット (アンダーライン形式) に合わせる。`scripts/release-notes.cjs`
     が `package.json` の `version` に完全一致する見出しのブロックを抽出し
     GitHub Release 本文として使う。**見出しが無いとリリースは `release-notes:
     セクションが見つかりません` エラーで停止**するため、必ず追記する。
   - 例:

     ```markdown
     0.10.3
     ------

     - 不具合修正: XXX が YYY のとき ZZZ になっていた問題
     - 機能追加: AAA

     0.9.0
     -----

     - Fixed a bug that caused Warning in IE
     ```

3. **上記変更を `master` にマージする**
   - PR 経由で `master` に取り込む。**タグ・Release 作成は release-it が行うので手動でタグを打たない**
   - マージ後、`master` の CI (`.github/workflows/ci.yml`) が green になっているのを Actions タブで確認する
4. **Actions から `Release` ワークフローを手動実行する**
   - GitHub の Actions タブ → 左メニュー `Release` → `Run workflow` → ブランチ `master` を選択して実行
   - `master` 以外を選ぶと `if: github.ref == 'refs/heads/master'` ガードでジョブが
     Skipped となり何も走らない (誤操作の安全側フォールバック)
   - ワークフローは以下を順に行う
     1. Lint / テスト (失敗したら以降は走らない)
     2. wasm ビルド (`./wasm/build.sh` fail-fast)
     3. `npx release-it --ci --no-increment` を実行
        - `before:release` フックで `NODE_ENV=production` の元 `npm pack` が走り
          `<name>-<version>.tgz` が生成される
        - `npm publish` (npmjs.org)
        - `git tag v<version>` と `git push --follow-tags`
        - GitHub Release 作成 (`CHANGELOG.md` から抜き出した本文と `.tgz` を asset として添付)

## 半端リリースが発生したときのリカバリ

**過去に「npm publish は成功したが GitHub Release が作られていない」半端状態が
発生している**。同じバージョンで再実行しても `npm publish` が E403 で必ず止まる
ため、以下の手順で **git 側だけ辻褄合わせをする**。

1. npm 側で公開されているバージョンを確認する
   ```sh
   npm view zip-partial-loader versions
   ```
2. そのバージョンに一致する `package.json` / `CHANGELOG.md` の状態のコミット SHA
   を `master` 上で特定する (Merge PR や history から探す)
3. ローカルで annotated タグを打ち、push する
   ```sh
   git checkout master
   git pull
   git tag -a v0.10.1 <commit-sha> -m "Release 0.10.1"
   git push origin v0.10.1
   ```
4. GitHub の `Releases` → `Draft a new release` から、上記タグを選択し、
   タイトル `v0.10.1`、本文に `CHANGELOG.md` の当該セクションを貼り付けて公開する
5. さらに asset の tgz も添付したい場合は、対応コミットを checkout してから
   `NODE_ENV=production npm ci && npm pack` で `zip-partial-loader-0.10.1.tgz`
   を作り、GitHub Release の Assets にドラッグアップロードする

このリカバリ後、**次の通常リリースは再開できる**が、必ず「事前確認」の
`npm view` で番号を再チェックしてから version を上げること。

## ローカルからリリースする場合 (緊急時のみ推奨)

CI が使えないときの手順。基本は GitHub Actions を使う運用にする。

1. `master` を checkout して pull し、`package.json` / `CHANGELOG.md` を更新したコミットが取り込まれた状態にする (上記 1〜3 と同じ)
   ```sh
   git checkout master && git pull
   ```
   別ブランチのままだと `.release-it.js` の `git.requireBranch: 'master'` で止まる。
2. 必要なツールをローカルに用意する
   - Node.js 22 系
   - Rust stable + `wasm32-unknown-unknown` ターゲット
   - `wasm-pack` v0.13.1
   - `wasm-opt` (binaryen)
3. 環境変数を用意する
   - `GITHUB_TOKEN`: `repo` スコープ (少なくとも `public_repo`) を持つ Personal Access Token
   - `npm login` 済みか、`~/.npmrc` に publish 可能なトークンがある状態
4. ドライラン (何も変更しない、実行計画を確認する)

   ```sh
   npm ci
   npm run lint
   npm run test:run
   NODE_ENV=production ./wasm/build.sh
   GITHUB_TOKEN=xxxx NODE_ENV=production npx release-it --ci --no-increment --dry-run
   ```

5. 問題なければ本実行

   ```sh
   GITHUB_TOKEN=xxxx NODE_ENV=production npx release-it --ci --no-increment
   ```

`release-it` は devDependency (`21.0.1` exact pin) として lockfile に固定されているので、
`npx release-it` はローカル解決される (`npx --yes release-it@X.Y.Z` のように
実行時取得はしない)。

## 補足

- **バージョンを勝手に上げさせない**: `--no-increment` を必ず付ける。付けないと release-it
  が対話プロンプトを出す (CI では失敗) か、自動で patch bump してしまう
- **CHANGELOG 追記忘れは release-it 実行時にエラーで止まる**: `scripts/release-notes.cjs`
  が `package.json.version` に一致する見出しを CHANGELOG.md 内に見つけられない場合は
  非 0 exit する。旧実装は最上部を無条件に取っていたため古い notes を貼る事故があった
- **tgz は毎回 `npm pack` で生成する**: `package.json` の `prepack` が `npm run build` を
  呼ぶので、`npm pack` を走らせるだけで `dist/` を再ビルドしたうえで tarball を作る
- **`NODE_ENV=production` を忘れない**: `webpack` の `--mode=${NODE_ENV:-development}` を
  経由するので、指定しないと minify されない dev ビルドが npm publish / tgz asset に
  混入する
- **手動タグを打たない**: release-it が `v<version>` 形式で annotated tag を作る。手動で
  同名タグを先に作ってしまうと release-it 側で衝突する (半端リカバリ手順は除く)
- **`master` 以外では走らない**: workflow_dispatch で誤ってブランチを選んでも
  `if: github.ref == 'refs/heads/master'` でジョブがスキップされ、ローカルでも
  `.release-it.js` の `git.requireBranch: 'master'` で release-it 起動時に止まる
