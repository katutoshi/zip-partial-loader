export function bufferToString(buff: ArrayBuffer): string {
  // Array.prototype.reduce.call を空配列越しに叩く旧実装だと TS 5 の
  // never[].reduce 型推論に噛み合わず noEmit で落ちる。Uint8Array.reduce に
  // 直接繋いで初期値経由で string 型を確定させる。
  return new Uint8Array(buff).reduce<string>((p, c) => p + String.fromCharCode(c), '');
}

export function stringToBuffer(str: string): ArrayBuffer {
  const len = str.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = str.charCodeAt(i);
  }
  return bytes.buffer;
}
