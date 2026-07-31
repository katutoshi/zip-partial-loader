#!/usr/bin/env node
// CHANGELOG.md から package.json の version に一致するセクションだけを抽出し
// stdout に出す。release-it の github.releaseNotes で呼ばれる想定。
//
// 実装意図:
//   - 「最上部のセクションを無条件に抽出する」旧実装は、CHANGELOG.md に新バージョン
//     を書き忘れたまま release-it を走らせると、古い過去バージョンの notes を
//     GitHub Release にそのまま貼ってしまう事故を起こしていた。
//   - version に対応するセクションが見つからない・空・CHANGELOG.md が読めない
//     ケースは全て非 0 exit で release-it を停止させ、リリースを進めさせない。
//   - CRLF 混じりの CHANGELOG.md でも body が壊れないよう先に LF 化する。
//   - 本文中に "1.2.3" 単独行 + "---" 行のような偶然のパターンがあっても
//     見出しに誤認しないよう、「先頭 or 直前が空行」を要求する行頭アンカーで
//     セクションヘッダを検出する。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const pkgPath = path.join(repoRoot, 'package.json');
const changelogPath = path.join(repoRoot, 'CHANGELOG.md');

const fail = (msg) => {
  process.stderr.write(`release-notes: ${msg}\n`);
  process.exit(1);
};

let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
} catch (err) {
  fail(`package.json を読めません: ${err.message}`);
}

const version = pkg && pkg.version;
if (typeof version !== 'string' || version.length === 0) {
  fail('package.json に version が定義されていません。');
}

let raw;
try {
  raw = fs.readFileSync(changelogPath, 'utf8');
} catch (err) {
  fail(`CHANGELOG.md を読めません: ${err.message}`);
}

// CRLF -> LF 正規化 (BOM も落とす)
const normalized = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
const lines = normalized.split('\n');

// 見出し検出: 行頭に "N.N.N" (プレリリース/ビルドメタ付きも許容)、次行が "-" のみで構成、
// かつ 先頭 or 直前行が空。これで本文内の偶発的な "1.2.3\n---" を弾く。
const headerRe = /^(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/;
const underlineRe = /^-+$/;

const sections = [];
for (let i = 0; i + 1 < lines.length; i++) {
  const m = headerRe.exec(lines[i]);
  if (!m) continue;
  if (!underlineRe.test(lines[i + 1])) continue;
  if (i !== 0 && lines[i - 1] !== '') continue;
  sections.push({ version: m[1], headerLine: i, bodyStart: i + 2 });
}

const idx = sections.findIndex((s) => s.version === version);
if (idx === -1) {
  fail(
    `CHANGELOG.md に version "${version}" のセクションが見つかりません。 ` +
      'CHANGELOG.md 先頭に該当バージョンの見出しを追記してください (例: "0.10.3\\n------\\n\\n- ...")。'
  );
}

const start = sections[idx].bodyStart;
const end = idx + 1 < sections.length ? sections[idx + 1].headerLine : lines.length;
const body = lines
  .slice(start, end)
  .join('\n')
  .replace(/^\n+/, '')
  .replace(/\n+$/, '');

if (body.length === 0) {
  fail(`CHANGELOG.md の version "${version}" セクション本文が空です。`);
}

process.stdout.write(`${body}\n`);
