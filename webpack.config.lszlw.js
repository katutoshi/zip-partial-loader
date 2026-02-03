const path = require('path');
const { execSync } = require('child_process');

// WASMビルドをWebpack起動前に実行
const buildWasm = () => {
  try {
    execSync(path.resolve(__dirname, './wasm/build.sh'), { stdio: 'inherit' });
  } catch (error) {
    console.warn('WASM build failed or skipped:', error.message);
  }
};

// ビルド実行
buildWasm();

module.exports = {
  mode: 'development',
  entry: [path.resolve(__dirname, "./src/lszlw/lszlw.ts")],
  target: 'webworker',
  output: {
    path: path.resolve(__dirname, "./dist"),
    filename: "lszlw.js",
    publicPath: "./"
  },
  module: {
    rules: [
      {
        test: /\.[tj]s$/,
        exclude: /(node_modules|bower_components)/,
        loader: 'esbuild-loader',
        options: {
          loader: 'ts',
          target: 'es2020'
        }
      },
      {
        test: /\.wasm$/,
        type: 'asset/resource'
      }
    ]
  },
  resolve: {
    extensions: [".ts", ".js"]
  }
};
