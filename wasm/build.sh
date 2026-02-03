#!/bin/sh

set -ex

cd `dirname $0`

rm -rf pkg

source ~/.cargo/env
wasm-pack build --release --target web
wasm-opt -O3 pkg/lszr_bg.wasm -o pkg/lszr_bg.wasm
