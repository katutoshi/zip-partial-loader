Zip Partial Loader
==================

A library for partial ZIP file loading using Range Requests. Reads the ZIP central directory and fetches only the required files.

Requirements
------------

### 開発環境
- Rust (latest stable)
- wasm-pack `cargo install wasm-pack`
- wasm-opt (Binaryen) `brew install binaryen` または `cargo install wasm-opt`
- Node.js 18+

### ブラウザ対応
- WebAssembly対応ブラウザが必要
- IE11非対応
- Chrome, Firefox, Safari, Edge (モダンブラウザ) 対応

Usage
-----

``` javascript
// LSZL is used as ES6 Class.
const lszl = new LSZL({
  url: 'https://example.com/pass/to/book.epub'
});

const promise = lsld.getBuffer('mimetype'); // returns a promise that will be resolved with an ArrayBuffer.

promise.then((buffer) => {
   // use buffer
});

```

Development
-----------

``` sh
npm install     # install dependencies
npm start       # start webpack-dev-server
npm run build   # build package
```

Acknowledgements
----------------

This project is forked from [lunascape/bibi-zip-loader](https://github.com/lunascape/bibi-zip-loader).
Thanks to the original authors for their excellent work.