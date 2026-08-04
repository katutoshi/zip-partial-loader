//! wasm32 ブラウザ向けスモークテスト。
//!
//! `#![cfg(target_arch = "wasm32")]` により host ターゲットでは丸ごと除外される。
//! CI では `wasm-pack test --headless --chrome` を回していないので実行はされないが、
//! ci.yml の wasm32 clippy ステップから見えるので、
//!   (1) crate の公開 API が wasm32 でもリンク・コンパイルできること
//!   (2) このファイル自体が clippy 違反を含まないこと
//! を守るゲートとして機能する。
//!
//! 元は `assert_eq!(1 + 1, 2)` のダミーだったが、これは wasm32 clippy で
//! `clippy::eq_op` に引っ掛かる (定数比較の `assertions_on_constants` 系も同様に避ける)。
//! 代わりに、公開 API の `KZPL::new` に不正データを渡して Err が返ることを
//! 実際に呼び出しで検証する形にする。

#![cfg(target_arch = "wasm32")]

extern crate wasm_bindgen_test;
use wasm_bindgen_test::*;

use kzpl::KZPL;

wasm_bindgen_test_configure!(run_in_browser);

#[wasm_bindgen_test]
fn kzpl_new_rejects_short_data() {
    // 22 バイト未満は EOCD 最小長 (ZIP 仕様) を満たさないので KZPL::new は Err を返すのが
    // 期待挙動。wasm32 ターゲットで KZPL の Rust 側 API がリンクし呼べることも同時に確認する。
    let short: Vec<u8> = vec![0u8; 10];
    let result = KZPL::new(short);
    assert!(result.is_err());
}
