# リリース手順

このパッケージは [tagpr](https://github.com/Songmu/tagpr) を使い、GitHub Actions で
リリースを自動化する。リリースは **「tagpr が作ったリリース PR をマージするだけ」** で完結する。

## フロー概要

1. `master` へ PR がマージされるたび、`.github/workflows/tagpr.yml` が
   **次リリース用 PR**（リリース PR）を自動生成・更新する。この PR は
   `package.json` の `version` と `CHANGELOG.md` を書き換える。
2. リリース PR をマージすると、tagpr が `vX.Y.Z` タグを打ち GitHub Release を作成する。
3. そのタグ push を契機に `.github/workflows/release.yml` がビルドして
   npmjs.org へ `npm publish` する。

人間が手動でタグを打ったり `npm publish` したりする必要はない。

## 前提

- **設定が必要なシークレットは 1 つだけ**
  - `NPM_TOKEN`: npmjs.org へ publish 可能なアクセストークンをリポジトリの Actions
    シークレットに登録する
  - npm の Granular Access Token を発行する場合、対象パッケージの **Packages** 権限を
    **Read and write** にする (Read only では `npm publish` が 403 で失敗する)
  - さらにアカウントの 2FA 設定によっては、トークン発行時に
    **Bypass two-factor authentication** を有効にする。無効のままだと CI 上の
    `npm publish` が対話的に OTP を入力できず `npm error code EOTP` で失敗する
  - `GITHUB_TOKEN` は Actions が実行時に自動で払い出す (`secrets.GITHUB_TOKEN`) ので追加設定不要
- **リポジトリ設定が 1 つ必要**
  - Settings → Actions → General → Workflow permissions で
    **Allow GitHub Actions to create and approve pull requests** を有効化する。
    tagpr がリリース PR を作成するために必要
- Node.js 22 / pnpm (`package.json` の `packageManager` で pin) / Rust (`wasm/rust-toolchain.toml`
  で pin) / wasm-pack `v0.13.1` / binaryen (`wasm-opt`) はワークフロー内で自動セットアップされる
- リリース対象ブランチは `master`（`.tagpr` の `tagpr.releaseBranch = master` で固定）
- タグは `v` プレフィックス付き (`vX.Y.Z`)

## 通常のリリース手順

リリース PR は master への通常マージのたびに tagpr が更新し続ける。リリースしたい
タイミングでその PR をマージするだけ。

1. **リリース PR を確認する**
   - タイトルに `[tagpr]` が付き、`tagpr` ラベルが付いた PR がそれ。
   - 中身は `package.json` の `version` 更新と `CHANGELOG.md` への新セクション追加。
     `CHANGELOG.md` は tagpr がマージ済 PR から自動生成する（gh2changelog）。
2. **バージョンを調整する（必要な場合のみ）**
   - 既定は **patch** バンプ。minor / major にしたい場合はリリース PR に
     `tagpr:minor` / `tagpr:major` ラベルを付ける
     （あるいは `package.json` の `version` を PR 内で直接編集してもよい。
     ファイルの値がラベルより優先される）。
   - 過去のマージ済 PR に `minor` / `major` ラベルがあれば tagpr が自動で
     リリース PR に `tagpr:minor` / `tagpr:major` を付与する。
3. **リリース PR を `master` にマージする**
   - マージと同時に tagpr が `vX.Y.Z` タグを push し GitHub Release を作成する。
   - そのタグ push で `release.yml` が走り、ビルド後に `npm publish` される。
   - 以降の通常リリースは、次に tagpr が作ったリリース PR をまたマージすればよい。

## 初回運用時の注意

- 既存の `CHANGELOG.md` には手書き（AI 生成含む）のエントリが残る。tagpr は新しい
  リリースのセクションを **上に追加** するため、それ以降はフォーマットが混在する。
  許容済みの運用。
- 初めて tagpr が走る push で、現在の `package.json` の `version`（`0.12.0`）を
  ベースに次バージョンを計算する。初回リリース PR のバージョンが意図通りか
  （最低でも `0.12.1` 以上になるはず）マージ前に確認すること。

## 半端リリースが発生したときのリカバリ

`release.yml`（タグ push 時）で **npm publish だけ失敗** した場合、タグと GitHub
Release は既に作成済みだが npm には未公開という半端状態になる。このバージョンは
まだ npm 上に存在しないため、publish をやり直せる。

1. `release.yml` が失敗した原因（認証トークン期限切れ、network 等）を修正する。
2. 同じタグを再 push して `release.yml` を再発火させる（タグは同じコミットを指す）：
   ```sh
   git fetch origin
   git tag -f vX.Y.Z vX.Y.Z^{commit}   # 既存タグと同じコミットを指す
   git push -f origin vX.Y.Z
   ```
   `on: push: tags:` はタグの更新（force push 含む）でも発火するため、
   再度ビルド＋`npm publish` が走る。
3. npm 上で公開されたことを `npm view zip-partial-loader versions` で確認する。

（publish が成功したあとに何らかの手戻りが必要な場合は、npm は一度公開した
バージョンを上書きできない。その場合は patch を上げた新しいリリース PR を
マージして再リリースする。）

## 補足

- **手動でタグ・Release を作らない**: すべて tagpr がリリース PR のマージを契機に行う。
  手動で同名タグを先に作ると tagpr と衝突する。
- **バージョンはリリース PR 内で決まる**: 従来のように `master` に version を
  コミットしておく必要はない。tagpr がリリース PR で書き換える。
- **`package.json` の `prepack` が build を担当**: `release.yml` は `pnpm publish`
  を呼び、`prepack` 経由で `build:wasm`（`./wasm/build.sh`）+ `build:ts`（`tsc`）を
  実行してから `wasm/pkg/` と `dist/` を同梱して publish する。
- **CHANGELOG の自動生成**: tagpr はマージ済 PR のタイトル等から `CHANGELOG.md`
  の新セクションを生成する。PR タイトルの質がそのままリリースノートの質になる。
