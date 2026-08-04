#!/usr/bin/env python3
# ビルドされた wasm の export → table の対応関係が壊れていないかを検証する。
#
# 具体的には `__wbindgen_externrefs` export が **externref テーブル** を指すこと
# を確認する。過去に CI 環境の Binaryen (wasm-opt) が特定条件下でこの対応を
# 壊し、`__wbindgen_externrefs` が funcref テーブル (max 固定) を指してしまう
# 結果、ブラウザ側の glue が `Table.grow()` に失敗して EPUB ロードが即死する
# 事故があった (issue #24)。CI と build.sh の両方でこの assert を通し、壊れた
# wasm が npm publish に流出する経路を根本封じする。

import sys
from pathlib import Path


class WasmParseError(RuntimeError):
    pass


def parse_wasm(path: Path):
    data = path.read_bytes()
    if data[:4] != b"\x00asm":
        raise WasmParseError(f"{path}: not a wasm binary (magic mismatch)")

    def uleb(i: int) -> tuple[int, int]:
        value = 0
        shift = 0
        while True:
            byte = data[i]
            i += 1
            value |= (byte & 0x7F) << shift
            if not (byte & 0x80):
                return value, i
            shift += 7

    def read_str(i: int) -> tuple[str, int]:
        n, i = uleb(i)
        return data[i : i + n].decode("utf-8", "replace"), i + n

    tables: list[tuple[int, int, int, int | None]] = []
    exports: list[tuple[str, int, int]] = []

    i = 8
    while i < len(data):
        section_id = data[i]
        i += 1
        section_size, i = uleb(i)
        end = i + section_size
        if section_id == 4:  # Table
            n, i = uleb(i)
            for idx in range(n):
                elem_type = data[i]
                i += 1
                flags = data[i]
                i += 1
                mn, i = uleb(i)
                mx: int | None
                if flags & 1:
                    mx, i = uleb(i)
                else:
                    mx = None
                tables.append((idx, elem_type, mn, mx))
        elif section_id == 7:  # Export
            n, i = uleb(i)
            for _ in range(n):
                name, i = read_str(i)
                kind = data[i]
                i += 1
                idx, i = uleb(i)
                exports.append((name, kind, idx))
            i = end
        else:
            i = end
    return tables, exports


def elem_type_name(elem_type: int) -> str:
    return {0x70: "funcref", 0x6F: "externref"}.get(elem_type, f"0x{elem_type:x}")


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: verify-exports.py <wasm-path>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1])
    tables, exports = parse_wasm(path)

    externref_indexes = {idx for idx, et, _, _ in tables if et == 0x6F}
    if not externref_indexes:
        print(f"NG: {path}: no externref table found", file=sys.stderr)
        return 1

    externrefs_export = next(
        (e for e in exports if e[0] == "__wbindgen_externrefs"), None
    )
    if externrefs_export is None:
        print(
            f"NG: {path}: `__wbindgen_externrefs` export is missing",
            file=sys.stderr,
        )
        return 1

    name, kind, table_idx = externrefs_export
    if kind != 1:
        print(
            f"NG: {path}: `__wbindgen_externrefs` is not a table export (kind={kind})",
            file=sys.stderr,
        )
        return 1

    if table_idx not in externref_indexes:
        target = next((t for t in tables if t[0] == table_idx), None)
        et_str = elem_type_name(target[1]) if target else "?"
        print(
            f"NG: {path}: `__wbindgen_externrefs` -> table[{table_idx}] "
            f"({et_str}); expected externref table (indexes {sorted(externref_indexes)}). "
            "See issue #24.",
            file=sys.stderr,
        )
        return 1

    print(f"OK: {path}: `__wbindgen_externrefs` -> table[{table_idx}] (externref)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
