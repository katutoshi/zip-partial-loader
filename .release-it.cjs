const pkg = require('./package.json');
const artifact = `${pkg.name}-${pkg.version}`;
const tagName = `v${pkg.version}`;

module.exports = {
  hooks: {
    // GitHub Release の assets に `${artifact}.tgz` を確実に用意するため、
    // release ライフサイクル全体の直前 (npm publish / git tag+push / github release
    // asset upload のいずれよりも前) に `npm pack` を走らせて tgz を CWD に生成する。
    // release-it の実装 (lib/index.js) 上、`before:release` は最初のプラグイン
    // (npm) の release フェーズが動く前に 1 度だけ発火するため、この配置なら
    // pack 失敗時に publish/tag/release がまったく走らず安全。
    'before:release': 'npm pack',
  },
  git: {
    commit: false,
    tag: true,
    requireUpstream: false,
    push: true,
    tagName,
    // 多層防御: master 以外のブランチでは release-it 自体が起動段階で止まる。
    // ローカル実行時の暴発防止。CI 側でも .github/workflows/release.yml で
    // `if: github.ref == 'refs/heads/master'` を張っている。
    requireBranch: 'master',
  },
  github: {
    release: true,
    releaseName: tagName,
    assets: [`${artifact}.tgz`],
    // CHANGELOG.md の該当バージョン節を抽出するのは scripts/release-notes.cjs
    // に切り出した。旧実装 (node -pe の split[1]) は
    //   - 「最上部を無条件に取る」ため CHANGELOG 追記忘れで古い notes を貼る
    //   - 見つからない / 空 / CRLF で "undefined" 文字列や壊れた本文が入る
    //   - 本文中の "x.y.z" + "---" を見出しに誤認して途中で切れる
    // の実害が実証されていたため、非 0 exit で release-it を止める実装に置き換え。
    releaseNotes: 'node scripts/release-notes.cjs',
    tokenRef: 'GITHUB_TOKEN',
  },
  npm: {
    publish: true,
  },
};
