const path = require('node:path');
const { execSync } = require('node:child_process');

// WASM ビルドを Webpack 起動前に実行する。
// 以前は失敗を try/catch で握りつぶしていたが、build.sh 冒頭で `rm -rf pkg` するため
// 失敗すると後段の webpack が "Module not found: '../../wasm/pkg/lszr'" という
// 無関係なエラーで落ち、誤診を招いていた。ここで即座に throw して、失敗の根本原因
// (wasm-pack / wasm-opt / cargo) が最上位のログに現れる形にする。
const buildWasm = () => {
  try {
    execSync(path.resolve(__dirname, './wasm/build.sh'), { stdio: 'inherit' });
  } catch (error) {
    throw new Error(
      'WASM ビルドに失敗しました。上に出力されている wasm/build.sh のログ (wasm-pack / wasm-opt / cargo) を確認してください。' +
        ` 元エラー: ${error.message}`,
    );
  }
};

// ビルド実行
buildWasm();

module.exports = {
  mode: 'development',
  entry: [path.resolve(__dirname, './src/lszlw/lszlw.ts')],
  target: 'webworker',
  output: {
    path: path.resolve(__dirname, './dist'),
    filename: 'lszlw.js',
    publicPath: './',
  },
  module: {
    rules: [
      {
        test: /\.[tj]s$/,
        exclude: /(node_modules|bower_components)/,
        loader: 'esbuild-loader',
        options: {
          loader: 'ts',
          target: 'es2020',
        },
      },
      {
        test: /\.wasm$/,
        type: 'asset/resource',
      },
    ],
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
};
