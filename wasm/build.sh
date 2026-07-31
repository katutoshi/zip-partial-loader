#!/bin/sh

set -ex

cd `dirname $0`

rm -rf pkg

if [ -f "$HOME/.cargo/env" ]; then
  . "$HOME/.cargo/env"
fi
wasm-pack build --release --target web
wasm-opt -O3 pkg/lszr_bg.wasm -o pkg/lszr_bg.wasm
