#!/usr/bin/env node
/**
 * 500エントリのEPUB風ZIPファイルを生成するスクリプト
 *
 * Usage: node scripts/generate-test-epub.js
 * Output: static/test-500-entries.epub
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const OUTPUT_DIR = path.join(__dirname, '../static/test-epub-content');
const OUTPUT_FILE = path.join(__dirname, '../static/test-500-entries.epub');

// ディレクトリ構造
const DIRS = [
  'META-INF',
  'OEBPS',
  'OEBPS/styles',
  'OEBPS/images',
  'OEBPS/text',
];

// 画像ファイル数
const IMAGE_COUNT = 200;
// チャプターファイル数 (500 - 5(固定ファイル) - 200(画像) = 295、296にして合計501にならないよう調整)
const CHAPTER_COUNT = 295;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function generateMimetype() {
  return 'application/epub+zip';
}

function generateContainerXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
}

function generateContentOpf(imageCount, chapterCount) {
  let manifest = '';
  let spine = '';

  // スタイルシート
  manifest += '    <item id="style" href="styles/style.css" media-type="text/css"/>\n';

  // 画像
  for (let i = 1; i <= imageCount; i++) {
    const id = `image_${String(i).padStart(3, '0')}`;
    manifest += `    <item id="${id}" href="images/${id}.jpg" media-type="image/jpeg"/>\n`;
  }

  // チャプター
  for (let i = 1; i <= chapterCount; i++) {
    const id = `chapter_${String(i).padStart(3, '0')}`;
    manifest += `    <item id="${id}" href="text/${id}.xhtml" media-type="application/xhtml+xml"/>\n`;
    spine += `    <itemref idref="${id}"/>\n`;
  }

  // NCX
  manifest += '    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n';

  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Test EPUB with 500 Entries</dc:title>
    <dc:identifier id="uid">test-epub-500</dc:identifier>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
${manifest}  </manifest>
  <spine toc="ncx">
${spine}  </spine>
</package>`;
}

function generateTocNcx(chapterCount) {
  let navPoints = '';

  for (let i = 1; i <= chapterCount; i++) {
    const id = `chapter_${String(i).padStart(3, '0')}`;
    navPoints += `    <navPoint id="navpoint-${i}" playOrder="${i}">
      <navLabel><text>Chapter ${i}</text></navLabel>
      <content src="text/${id}.xhtml"/>
    </navPoint>\n`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="test-epub-500"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>Test EPUB with 500 Entries</text></docTitle>
  <navMap>
${navPoints}  </navMap>
</ncx>`;
}

function generateStyleCss() {
  return `body {
  font-family: serif;
  line-height: 1.6;
  margin: 1em;
}
h1, h2, h3 {
  font-family: sans-serif;
}
img {
  max-width: 100%;
  height: auto;
}`;
}

function generateChapterXhtml(chapterNum) {
  const paddedNum = String(chapterNum).padStart(3, '0');
  // 各チャプターに適度なコンテンツを追加（約1KBずつ）
  const paragraphs = [];
  for (let i = 0; i < 5; i++) {
    paragraphs.push(`<p>This is paragraph ${i + 1} of chapter ${chapterNum}. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.</p>`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>Chapter ${chapterNum}</title>
  <link rel="stylesheet" type="text/css" href="../styles/style.css"/>
</head>
<body>
  <h1>Chapter ${chapterNum}</h1>
  ${paragraphs.join('\n  ')}
</body>
</html>`;
}

function generateFakeJpeg(index) {
  // 最小限の有効なJPEGファイル（約300バイト）
  // SOI + APP0 + DQT + SOF0 + DHT + SOS + 画像データ + EOI
  // 簡略化のため、小さなダミーJPEGを生成
  const header = Buffer.from([
    0xFF, 0xD8, // SOI
    0xFF, 0xE0, 0x00, 0x10, // APP0 marker
    0x4A, 0x46, 0x49, 0x46, 0x00, // JFIF
    0x01, 0x01, // version
    0x00, // units
    0x00, 0x01, 0x00, 0x01, // density
    0x00, 0x00, // thumbnail
  ]);

  // ダミーデータを追加して各画像を異なるサイズに
  const dataSize = 200 + (index % 100) * 10;
  const dummyData = Buffer.alloc(dataSize, index % 256);

  const footer = Buffer.from([0xFF, 0xD9]); // EOI

  return Buffer.concat([header, dummyData, footer]);
}

async function main() {
  console.log('Generating test EPUB with 500 entries...');

  // 出力ディレクトリをクリーンアップ
  if (fs.existsSync(OUTPUT_DIR)) {
    fs.rmSync(OUTPUT_DIR, { recursive: true });
  }

  // ディレクトリ作成
  DIRS.forEach(dir => ensureDir(path.join(OUTPUT_DIR, dir)));

  // mimetype（圧縮なし、最初に配置される必要がある）
  fs.writeFileSync(path.join(OUTPUT_DIR, 'mimetype'), generateMimetype());

  // META-INF/container.xml
  fs.writeFileSync(path.join(OUTPUT_DIR, 'META-INF/container.xml'), generateContainerXml());

  // OEBPS/content.opf
  fs.writeFileSync(path.join(OUTPUT_DIR, 'OEBPS/content.opf'), generateContentOpf(IMAGE_COUNT, CHAPTER_COUNT));

  // OEBPS/toc.ncx
  fs.writeFileSync(path.join(OUTPUT_DIR, 'OEBPS/toc.ncx'), generateTocNcx(CHAPTER_COUNT));

  // OEBPS/styles/style.css
  fs.writeFileSync(path.join(OUTPUT_DIR, 'OEBPS/styles/style.css'), generateStyleCss());

  // 画像ファイル
  console.log(`Generating ${IMAGE_COUNT} image files...`);
  for (let i = 1; i <= IMAGE_COUNT; i++) {
    const filename = `image_${String(i).padStart(3, '0')}.jpg`;
    fs.writeFileSync(path.join(OUTPUT_DIR, 'OEBPS/images', filename), generateFakeJpeg(i));
  }

  // チャプターファイル
  console.log(`Generating ${CHAPTER_COUNT} chapter files...`);
  for (let i = 1; i <= CHAPTER_COUNT; i++) {
    const filename = `chapter_${String(i).padStart(3, '0')}.xhtml`;
    fs.writeFileSync(path.join(OUTPUT_DIR, 'OEBPS/text', filename), generateChapterXhtml(i));
  }

  // ZIPファイルを作成
  console.log('Creating EPUB (ZIP) file...');

  // 既存のEPUBファイルを削除
  if (fs.existsSync(OUTPUT_FILE)) {
    fs.unlinkSync(OUTPUT_FILE);
  }

  // EPUBの仕様に従い、mimetypeを最初に圧縮なしで追加
  const cwd = OUTPUT_DIR;
  execSync(`zip -0 -X "${OUTPUT_FILE}" mimetype`, { cwd });

  // 残りのファイルを圧縮して追加
  execSync(`zip -r -9 "${OUTPUT_FILE}" META-INF OEBPS`, { cwd });

  // 結果を表示
  const stats = fs.statSync(OUTPUT_FILE);
  const fileSizeKB = (stats.size / 1024).toFixed(1);

  // エントリ数をカウント
  const zipList = execSync(`unzip -l "${OUTPUT_FILE}" | tail -1`, { encoding: 'utf8' });
  const match = zipList.match(/(\d+)\s+files/);
  const entryCount = match ? match[1] : 'unknown';

  console.log('');
  console.log('=== Generation Complete ===');
  console.log(`Output: ${OUTPUT_FILE}`);
  console.log(`Size: ${fileSizeKB} KB`);
  console.log(`Entries: ${entryCount}`);

  // クリーンアップ
  fs.rmSync(OUTPUT_DIR, { recursive: true });
  console.log('Temporary files cleaned up.');
}

main().catch(console.error);
