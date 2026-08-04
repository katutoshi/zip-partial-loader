#[macro_use]
mod utils;
mod zip;

use js_sys::{Array, Error};
use std::collections::HashMap;
use std::io::Cursor;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct KZPL {
    eocd: zip::EOCD,
    entries: Vec<zip::CDHeader>,
    // ファイル名 → entriesインデックスのマップ (O(1)検索用)
    entry_map: HashMap<String, usize>,
    // オフセット順にソートされた (offset, index) のリスト (次エントリ検索用)
    sorted_offsets: Vec<(u32, usize)>,
}

#[wasm_bindgen]
#[derive(Copy, Clone)]
pub struct Range {
    #[wasm_bindgen(readonly, js_name=offset)]
    pub offset: u32,
    #[wasm_bindgen(readonly, js_name=size)]
    pub size: u32,
}

#[wasm_bindgen]
impl KZPL {
    #[wasm_bindgen(constructor)]
    pub fn new(data: Vec<u8>) -> Result<KZPL, JsValue> {
        let len = data.len();
        if len < 22 {
            return Err(JsValue::from(Error::new("Data length invalid.")));
        }
        let mut reader = Cursor::new(data);
        let eocd = zip::parse_eocd(&mut reader)?;

        if eocd.number_of_this_disk != 0 || eocd.number_of_disk_start_eocd != 0 {
            return Err(JsValue::from(Error::new("Disk split is not supported.")));
        }

        if eocd.number_of_this_disk == 0xFFFF {
            return Err(JsValue::from(Error::new("ZIP64 is not supported.")));
        }

        let result = Self {
            eocd,
            entries: vec![],
            entry_map: HashMap::new(),
            sorted_offsets: vec![],
        };

        Result::Ok(result)
    }

    #[wasm_bindgen(js_name = parseCD)]
    pub fn parse_cd(&mut self, data: Vec<u8>) -> Result<Array, JsValue> {
        let mut reader = Cursor::new(data);
        self.entries = zip::parse_cd(
            &mut reader,
            self.eocd.total_number_of_entries_in_cd as usize,
        )?;

        let (entry_map, sorted_offsets) = build_indexes(&self.entries);
        self.entry_map = entry_map;
        self.sorted_offsets = sorted_offsets;

        let names = Array::new();
        for entry in &self.entries {
            names.push(&JsValue::from(&entry.file_name));
        }

        Result::Ok(names)
    }

    #[wasm_bindgen(js_name = getRange)]
    pub fn get_range(&mut self, name: String) -> Result<Range, JsValue> {
        // O(1)でエントリを検索
        let idx = match self.entry_map.get(&name) {
            Some(&idx) => idx,
            None => {
                let message = format!("Entry not found: {}", name);
                return Err(JsValue::from(Error::new(message.as_str())));
            }
        };

        let entry = &self.entries[idx];
        let entry_offset = entry.relative_offset_of_local_header;
        let end = find_end_offset(&self.sorted_offsets, entry_offset, self.eocd.cd_offset);

        Result::Ok(Range {
            offset: entry_offset,
            size: end - entry_offset - 1,
        })
    }

    #[wasm_bindgen(js_name = getData)]
    pub fn get_data(&mut self, name: String, data: Vec<u8>) -> Result<Vec<u8>, JsValue> {
        let entry = self.find_entry(&name)?;
        let reader = Cursor::new(data);
        let result = zip::load_file(reader, entry)?;

        if entry.is_encrypted {
            return Err(JsValue::from(Error::new("encrypted.")));
        }
        Ok(result)
    }

    fn find_entry(&self, name: &str) -> Result<&zip::CDHeader, JsValue> {
        // O(1)でエントリを検索
        match self.entry_map.get(name) {
            Some(&idx) => Result::Ok(&self.entries[idx]),
            None => Err(JsValue::from(Error::new("Entry not found."))),
        }
    }

    #[wasm_bindgen(getter, js_name=cdRange)]
    pub fn cd_range(&self) -> Range {
        Range {
            offset: self.eocd.cd_offset,
            size: self.eocd.cd_size,
        }
    }

    #[wasm_bindgen(getter, js_name=eocdRange)]
    pub fn eocd_range(&self) -> Range {
        Range {
            offset: self.eocd.eocd_offset,
            size: self.eocd.eocd_size,
        }
    }
}

/// entries からファイル名→インデックスの HashMap (O(1)検索用) と、
/// ローカルヘッダオフセット昇順の (offset, index) リスト (次エントリ検索用) を構築する。
///
/// 同名エントリは HashMap::insert の後勝ちで最後のエントリが有効になる。
/// unzip も展開時に後のエントリで上書きするため、これに合わせた挙動。
fn build_indexes(entries: &[zip::CDHeader]) -> (HashMap<String, usize>, Vec<(u32, usize)>) {
    let mut entry_map = HashMap::with_capacity(entries.len());
    let mut sorted_offsets = Vec::with_capacity(entries.len());

    for (idx, entry) in entries.iter().enumerate() {
        entry_map.insert(entry.file_name.clone(), idx);
        sorted_offsets.push((entry.relative_offset_of_local_header, idx));
    }

    // ZIP は通常オフセット順に並んでいるため、ソート済み入力に強い標準の
    // 適応型ソートに任せる (ソート済みなら実質 O(n))
    sorted_offsets.sort_by_key(|(offset, _)| *offset);
    (entry_map, sorted_offsets)
}

/// entry_offset より真に大きい最小のローカルヘッダオフセットを返す。
/// 見つからなければ cd_offset (最終エントリの終端は Central Directory の直前) を返す。
///
/// 「真に大きい」ものだけを候補にすることで、同一オフセットを持つ壊れた ZIP でも
/// end == entry_offset とならず、呼び出し側の size 計算 (end - offset - 1) が
/// u32 アンダーフローしないことを保証する。
fn find_end_offset(sorted_offsets: &[(u32, usize)], entry_offset: u32, cd_offset: u32) -> u32 {
    let pos = sorted_offsets.partition_point(|&(offset, _)| offset <= entry_offset);
    match sorted_offsets.get(pos) {
        Some(&(offset, _)) => offset,
        None => cd_offset,
    }
}

impl From<zip::ParseEOCDError> for JsValue {
    fn from(err: zip::ParseEOCDError) -> Self {
        JsValue::from(Error::new(
            match err {
                zip::ParseEOCDError::IOError(err) => format!("ParseEOCDError: {}", err),
                zip::ParseEOCDError::InvalidSignature => {
                    "ParseEOCDError: InvalidSignature".to_string()
                }
                zip::ParseEOCDError::TooShortDataLength => {
                    "ParseEOCDError: TooShortDataLength".to_string()
                }
            }
            .as_str(),
        ))
    }
}

impl From<zip::ParseCDError> for JsValue {
    fn from(err: zip::ParseCDError) -> Self {
        JsValue::from(Error::new(
            match err {
                zip::ParseCDError::IOError(err) => format!("ParseCDError: {}", err),
                zip::ParseCDError::FileNameConversionError => {
                    "ParseCDError: FileNameConversionError".to_string()
                }
                zip::ParseCDError::InvalidSignature => "ParseCDError: InvalidSignature".to_string(),
            }
            .as_str(),
        ))
    }
}

impl From<zip::LoadFileError> for JsValue {
    fn from(err: zip::LoadFileError) -> Self {
        JsValue::from(Error::new(
            match err {
                zip::LoadFileError::IOError(err) => format!("LoadFileError: {}", err),
                zip::LoadFileError::InvalidSignature => {
                    "LoadFileError: InvalidSignature".to_string()
                }
                zip::LoadFileError::UnmatchHeader => "LoadFileError: UnmatchHeader".to_string(),
                zip::LoadFileError::UnsupportedCompressionMethod(m) => {
                    format!("LoadFileError: UnsupportedCompressionMethod: {}", m)
                }
                zip::LoadFileError::FileNameConversionError => {
                    "LoadFileError: FileNameConversionError".to_string()
                }
            }
            .as_str(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cd_header(name: &str, offset: u32) -> zip::CDHeader {
        zip::CDHeader {
            signature: zip::CD_SIGNATURE,
            version_made_by: 20,
            version_needed_to_extract: 20,
            general_purpose_bit_flag: 0,
            compression_method: 0,
            last_mod_file_time: 0,
            last_mod_file_date: 0,
            crc32: 0,
            compressed_size: 0,
            uncompressed_size: 0,
            file_name_length: name.len() as u16,
            extra_field_length: 0,
            file_comment_length: 0,
            disk_number_start: 0,
            internal_file_attributes: 0,
            external_file_attributes: 0,
            relative_offset_of_local_header: offset,
            file_name: name.to_string(),
            extra_field: vec![],
            file_comment: vec![],
            is_utf8: true,
            is_encrypted: false,
        }
    }

    #[test]
    fn build_indexes_maps_names_and_sorts_offsets() {
        // CD 内の並びがオフセット順でない ZIP でも昇順に整列されること
        let entries = vec![
            cd_header("b.txt", 300),
            cd_header("a.txt", 100),
            cd_header("c.txt", 200),
        ];
        let (entry_map, sorted_offsets) = build_indexes(&entries);

        assert_eq!(entry_map["a.txt"], 1);
        assert_eq!(entry_map["b.txt"], 0);
        assert_eq!(entry_map["c.txt"], 2);
        assert_eq!(sorted_offsets, vec![(100, 1), (200, 2), (300, 0)]);
    }

    #[test]
    fn build_indexes_last_entry_wins_for_duplicate_names() {
        // 同名エントリは unzip の展開挙動 (後のエントリで上書き) に合わせて後勝ち
        let entries = vec![
            cd_header("dup.txt", 100),
            cd_header("other.txt", 200),
            cd_header("dup.txt", 300),
        ];
        let (entry_map, _) = build_indexes(&entries);

        assert_eq!(entry_map["dup.txt"], 2);
    }

    #[test]
    fn find_end_offset_returns_next_entry_offset() {
        let sorted = vec![(0, 0), (100, 1), (250, 2)];

        assert_eq!(find_end_offset(&sorted, 0, 1000), 100);
        assert_eq!(find_end_offset(&sorted, 100, 1000), 250);
    }

    #[test]
    fn find_end_offset_falls_back_to_cd_offset_for_last_entry() {
        let sorted = vec![(0, 0), (100, 1), (250, 2)];

        assert_eq!(find_end_offset(&sorted, 250, 1000), 1000);
    }

    #[test]
    fn find_end_offset_skips_duplicate_offsets() {
        // 同一オフセットを持つ壊れた ZIP でも end > entry_offset を維持し、
        // size 計算 (end - offset - 1) が u32 アンダーフローしないこと
        let sorted = vec![(100, 0), (100, 1), (200, 2)];
        assert_eq!(find_end_offset(&sorted, 100, 1000), 200);

        // 重複が末尾にあるケースは cd_offset にフォールバックする
        let tail_dup = vec![(50, 0), (100, 1), (100, 2)];
        assert_eq!(find_end_offset(&tail_dup, 100, 1000), 1000);
    }
}
