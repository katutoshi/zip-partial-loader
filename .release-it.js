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
  },
  github: {
    release: true,
    releaseName: tagName,
    assets: [`${artifact}.tgz`],
    releaseNotes: `node -pe "require('fs').readFileSync('CHANGELOG.md', 'utf8').split(/(?:\\n)?\\d+\\.\\d+\\.\\d+(?:(?:-|\\+).*)?\\n-+\\n(?:\\n)?/g)[1]"`,
    tokenRef: 'GITHUB_TOKEN',
  },
  npm: {
    publish: true,
  },
};
