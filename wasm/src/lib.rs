#[macro_use]
mod utils;
mod zip;

use js_sys::{Array, Error};
use wasm_bindgen::prelude::*;
use std::io::Cursor;
use std::collections::HashMap;

#[wasm_bindgen]
pub struct LSZR {
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
impl LSZR {
    #[wasm_bindgen(constructor, catch)]
    pub fn new(data: Vec<u8>) -> Result<LSZR, JsValue> {
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
            eocd: eocd,
            entries: vec![],
            entry_map: HashMap::new(),
            sorted_offsets: vec![],
        };

        Result::Ok(result)
    }

    #[wasm_bindgen(catch, js_name = parseCD)]
    pub fn parse_cd(&mut self, data: Vec<u8>) -> Result<Array, JsValue> {
        let mut reader = Cursor::new(data);
        self.entries = zip::parse_cd(
            &mut reader,
            self.eocd.total_number_of_entries_in_cd as usize,
        )?;

        let count = self.entries.len();
        self.entry_map = HashMap::with_capacity(count);
        self.sorted_offsets = Vec::with_capacity(count);
        let names = Array::new();

        // 1回のループで全て処理（file_name.clone()を1回に削減）
        for (idx, entry) in self.entries.iter().enumerate() {
            self.entry_map.insert(entry.file_name.clone(), idx);
            self.sorted_offsets.push((entry.relative_offset_of_local_header, idx));
            names.push(&JsValue::from(&entry.file_name));
        }

        // ソート済みかチェック（ZIPは通常オフセット順なのでスキップできる可能性大）
        let needs_sort = self.sorted_offsets.windows(2)
            .any(|w| w[0].0 > w[1].0);
        if needs_sort {
            self.sorted_offsets.sort_by_key(|(offset, _)| *offset);
        }

        Result::Ok(names)
    }

    #[wasm_bindgen(catch, js_name = getRange)]
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

        // 二分探索で次のエントリのオフセットを見つける
        let end = match self.sorted_offsets.binary_search_by_key(&entry_offset, |(offset, _)| *offset) {
            Ok(pos) => {
                // 次のエントリがあればそのオフセット、なければCDの開始位置
                if pos + 1 < self.sorted_offsets.len() {
                    self.sorted_offsets[pos + 1].0
                } else {
                    self.eocd.cd_offset
                }
            }
            Err(_) => self.eocd.cd_offset, // 通常は到達しない
        };

        Result::Ok(Range {
            offset: entry_offset,
            size: end - entry_offset - 1,
        })
    }

    #[wasm_bindgen(catch, js_name = getData)]
    pub fn get_data(&mut self, name: String, data: Vec<u8>) -> Result<Vec<u8>, JsValue> {
        let entry = self.find_entry(name)?;
        let reader = Cursor::new(data);
        let result = zip::load_file(reader, entry)?;

        if entry.is_encrypted {
            return Err(JsValue::from(Error::new("encrypted.")));
        }
        Ok(result)
    }

    fn find_entry(&self, name: String) -> Result<&zip::CDHeader, JsValue> {
        // O(1)でエントリを検索
        match self.entry_map.get(&name) {
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
                    format!("ParseCDError: FileNameConversionError")
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
                zip::LoadFileError::InvalidSignature => "LoadFileError: InvalidSignature".to_string(),
                zip::LoadFileError::UnmatchHeader => "LoadFileError: UnmatchHeader".to_string(),
                zip::LoadFileError::UnsupportedCompressionMethod(m) => format!("LoadFileError: UnsupportedCompressionMethod: {}", m),
                zip::LoadFileError::FileNameConversionError => "LoadFileError: FileNameConversionError".to_string(),
            }
            .as_str(),
        ))
    }
}
