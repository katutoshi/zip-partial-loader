#!/bin/sh

set -ex

cd `dirname $0`

rm -rf pkg

if [ -f "$HOME/.cargo/env" ]; then
  . "$HOME/.cargo/env"
fi
wasm-pack build --release --target web
wasm-opt -O3 pkg/lszr_bg.wasm -o pkg/lszr_bg.wasm

# wasm-pack は pkg/ の中に `*` だけを書いた .gitignore を生成する。
# npm pack はネストされた .gitignore も尊重するため、これを残すと package.json の
# files で `wasm/pkg/*` を許可リストに載せていても実際のタルボールから欠落する
# (0.11.0 で同種の同梱漏れが 1 度発生している。dist の話ではなく wasm 側で同じ罠を踏まないため)。
# また pkg/package.json も残しておくと消費側の Node が誤って別 package として解決する
# 恐れがあるので、この 2 つを削除して "純粋なアセット" ディレクトリにする。
rm -f pkg/.gitignore pkg/package.json
