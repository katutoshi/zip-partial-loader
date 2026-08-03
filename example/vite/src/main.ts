// 消費側から見た "モダン" な使い方サンプル。
// - `import LSZL from 'zip-partial-loader'` の 1 行だけ
// - vite.config.ts にはカスタムプラグイン無し
// - Worker JS / wasm は Vite が自動でハッシュ付きチャンクとして配置する
import LSZL from 'zip-partial-loader';

const output = document.getElementById('output') as HTMLPreElement;

async function main() {
  const lszl = new LSZL({ url: '/sample.epub' });
  const buf = await lszl.getBuffer('mimetype');
  const text = new TextDecoder().decode(buf);
  output.textContent = `mimetype = ${text}`;
}

main().catch((err) => {
  output.textContent = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  console.error(err);
});
