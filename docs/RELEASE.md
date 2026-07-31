# リリース手順

このパッケージは [release-it](https://github.com/release-it/release-it) を使い、
GitHub Actions ワークフロー (`.github/workflows/release.yml`) から手動でリリースする。

## 前提

- GitHub リポジトリの Actions シークレットに以下を設定していること
  - `NPM_TOKEN`: npmjs.org へ publish 可能なアクセストークン (Automation token 推奨)
  - `GITHUB_TOKEN`: Actions が自動で払い出す `secrets.GITHUB_TOKEN` を使う。追加設定不要
- ワークフローの `permissions` は `contents: write` のみ (タグ push と GitHub Release 作成に必要)
- Node.js 22 / Rust stable / wasm-pack `v0.13.1` / binaryen (`wasm-opt`) がワークフロー内で自動セットアップされる

## 通常のリリース手順 (GitHub Actions から実行)

1. **`package.json` の `version` を更新する**
   - SemVer に従って上げる (例: `0.10.0` → `0.10.1` / `0.11.0`)
2. **`CHANGELOG.md` に新バージョンの見出しを追記する**
   - 既存フォーマット (アンダーライン形式) に合わせる。`release-it` が
     `.release-it.js` の `github.releaseNotes` 設定で、この見出し直下のブロックを
     GitHub Release 本文として抽出する
   - 例:

     ```markdown
     0.10.1
     ------

     - 不具合修正: XXX が YYY のとき ZZZ になっていた問題
     - 機能追加: AAA

     0.10.0
     ------

     ...
     ```

3. **上記変更を `master` にマージする**
   - PR 経由で `master` に取り込む。**タグ・Release 作成は release-it が行うので手動でタグを打たない**
4. **Actions から `Release` ワークフローを手動実行する**
   - GitHub の Actions タブ → 左メニュー `Release` → `Run workflow` → ブランチ `master` を選択して実行
   - ワークフローは以下を順に行う
     1. Lint / テスト (失敗したら以降は走らない)
     2. `wasm` ビルド環境のセットアップ
     3. `npx release-it --ci --no-increment` を実行
        - `before:release` フックで `npm pack` が走り `<name>-<version>.tgz` が生成される
        - `npm publish` (npmjs.org)
        - `git tag v<version>` と `git push --follow-tags`
        - GitHub Release 作成 (`CHANGELOG.md` から抜き出した本文と `.tgz` を asset として添付)

## ローカルからリリースする場合 (緊急時のみ推奨)

CI が使えないときの手順。基本は GitHub Actions を使う運用にする。

1. `master` の最新を fetch し、`package.json` / `CHANGELOG.md` をコミットしておく (上記 1〜3 と同じ)
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
   GITHUB_TOKEN=xxxx npx release-it@21.0.1 --ci --no-increment --dry-run
   ```

5. 問題なければ本実行

   ```sh
   GITHUB_TOKEN=xxxx npx release-it@21.0.1 --ci --no-increment
   ```

## 補足

- **バージョンを勝手に上げさせない**: `--no-increment` を必ず付ける。付けないと release-it
  が対話プロンプトを出す (CI では失敗) か、自動で patch bump してしまう
- **tgz は毎回 `npm pack` で生成する**: `package.json` の `prepack` が `npm run build` を
  呼ぶので、`npm pack` を走らせるだけで `dist/` を再ビルドしたうえで tarball を作る
- **手動タグを打たない**: release-it が `v<version>` 形式で annotated tag を作る。手動で
  同名タグを先に作ってしまうと release-it 側で衝突する
