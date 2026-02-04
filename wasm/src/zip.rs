use encoding_rs::SHIFT_JIS;
use libflate;
use podio::{LittleEndian, ReadPodExt};
use std::io;
use std::io::prelude::*;
use std::string::FromUtf8Error;

#[derive(Debug)]
#[allow(dead_code)]
pub struct EOCD {
    pub signature: u32,
    pub number_of_this_disk: u16,
    pub number_of_disk_start_eocd: u16,
    pub total_number_of_entries_on_disk: u16,
    pub total_number_of_entries_in_cd: u16,
    pub cd_size: u32,
    pub cd_offset: u32,
    pub comment: Vec<u8>,

    pub eocd_offset: u32,
    pub eocd_size: u32,
}

#[derive(Debug)]
#[allow(dead_code)]
pub struct CDHeader {
    pub signature: u32,
    pub version_made_by: u16,
    pub version_needed_to_extract: u16,
    pub general_purpose_bit_flag: u16,
    pub compression_method: u16,
    pub last_mod_file_time: u16,
    pub last_mod_file_date: u16,
    pub crc32: u32,
    pub compressed_size: u32,
    pub uncompressed_size: u32,
    pub file_name_length: u16,
    pub extra_field_length: u16,
    pub file_comment_length: u16,
    pub disk_number_start: u16,
    pub internal_file_attributes: u16,
    pub external_file_attributes: u32,
    pub relative_offset_of_local_header: u32,

    pub file_name: String,
    pub extra_field: Vec<u8>,
    pub file_comment: Vec<u8>,

    pub is_utf8: bool,
    pub is_encrypted: bool,
}

pub const LFH_SIGNATURE: u32 = 0x04034b50;
pub const CD_SIGNATURE: u32 = 0x02014b50;
pub const EOCD_SIGNATURE: u32 = 0x06054b50;
// pub const ZIP64_EOCD_SIGNATURE : u32 = 0x06064b50;
// const ZIP64_CENTRAL_DIRECTORY_END_LOCATOR_SIGNATURE : u32 = 0x07064b50;

pub const COMPRESSION_METHOD_STORED: u16 = 0;
pub const COMPRESSION_METHOD_DEFLATED: u16 = 8;

#[derive(Debug)]
pub enum ParseEOCDError {
    TooShortDataLength,
    InvalidSignature,
    IOError(io::Error),
}

#[derive(Debug)]
pub enum ParseCDError {
    InvalidSignature,
    FileNameConversionError,
    IOError(io::Error),
}

#[derive(Debug)]
pub enum LoadFileError {
    InvalidSignature,
    FileNameConversionError,
    UnmatchHeader,
    UnsupportedCompressionMethod(u16),
    IOError(io::Error),
}

#[derive(Debug)]
enum FileNameError {
    FromUtf8Error,
    FromSJISError,
}

pub fn parse_eocd(cursor: &mut io::Cursor<Vec<u8>>) -> Result<EOCD, ParseEOCDError> {
    let length = cursor.seek(io::SeekFrom::End(0))?;
    if length < 22 {
        return Result::Err(ParseEOCDError::TooShortDataLength);
    }
    let mut signature: u32;
    cursor.seek(io::SeekFrom::End(-22))?;
    loop {
        signature = cursor.read_u32::<LittleEndian>()?;
        if signature == EOCD_SIGNATURE {
            break;
        }
        cursor.seek(io::SeekFrom::Current(-5))?;
    }
    let eocd_offset = cursor.position() as u32 - 4;

    let number_of_this_disk = cursor.read_u16::<LittleEndian>()?;
    let number_of_disk_start_eocd = cursor.read_u16::<LittleEndian>()?;
    let total_number_of_entries_on_disk = cursor.read_u16::<LittleEndian>()?;
    let total_number_of_entries_in_cd = cursor.read_u16::<LittleEndian>()?;
    let cd_size = cursor.read_u32::<LittleEndian>()?;
    let cd_offset = cursor.read_u32::<LittleEndian>()?;
    let comment_length = cursor.read_u16::<LittleEndian>()? as usize;
    let comment = ReadPodExt::read_exact(cursor, comment_length)?;

    let eocd_size = 4 + 2 + 2 + 2 + 2 + 4 + 4 + 2 + comment_length as u32;

    let eocd = EOCD {
        signature: signature,
        number_of_this_disk: number_of_this_disk,
        number_of_disk_start_eocd: number_of_disk_start_eocd,
        total_number_of_entries_on_disk: total_number_of_entries_on_disk,
        total_number_of_entries_in_cd: total_number_of_entries_in_cd,
        cd_size: cd_size,
        cd_offset: cd_offset,
        comment: comment,
        eocd_offset: eocd_offset,
        eocd_size: eocd_size,
    };
    Result::Ok(eocd)
}

pub fn parse_cd(
    cursor: &mut io::Cursor<Vec<u8>>,
    count: usize,
) -> Result<Vec<CDHeader>, ParseCDError> {
    let mut cdhs: Vec<CDHeader> = Vec::with_capacity(count);
    while cdhs.len() < count {
        let signature = cursor.read_u32::<LittleEndian>()?;
        if signature != CD_SIGNATURE {
            return Result::Err(ParseCDError::InvalidSignature);
        }

        let version_made_by = cursor.read_u16::<LittleEndian>()?;
        let version_needed_to_extract = cursor.read_u16::<LittleEndian>()?;
        let general_purpose_bit_flag = cursor.read_u16::<LittleEndian>()?;
        let compression_method = cursor.read_u16::<LittleEndian>()?;
        let last_mod_file_time = cursor.read_u16::<LittleEndian>()?;
        let last_mod_file_date = cursor.read_u16::<LittleEndian>()?;
        let crc32 = cursor.read_u32::<LittleEndian>()?;
        let compressed_size = cursor.read_u32::<LittleEndian>()?;
        let uncompressed_size = cursor.read_u32::<LittleEndian>()?;
        let file_name_length = cursor.read_u16::<LittleEndian>()?;
        let extra_field_length = cursor.read_u16::<LittleEndian>()?;
        let file_comment_length = cursor.read_u16::<LittleEndian>()?;
        let disk_number_start = cursor.read_u16::<LittleEndian>()?;
        let internal_file_attributes = cursor.read_u16::<LittleEndian>()?;
        let external_file_attributes = cursor.read_u32::<LittleEndian>()?;
        let relative_offset_of_local_header = cursor.read_u32::<LittleEndian>()?;
        let file_name_bytes = ReadPodExt::read_exact(cursor, file_name_length as usize)?;
        let extra_field = ReadPodExt::read_exact(cursor, extra_field_length as usize)?;
        let file_comment = ReadPodExt::read_exact(cursor, file_comment_length as usize)?;

        let is_utf8 = general_purpose_bit_flag & (1 << 11) != 0;
        let is_encrypted = general_purpose_bit_flag & 1 == 1;

        let file_name = decode_file_name(&file_name_bytes, is_utf8)?;

        let cdh = CDHeader {
            signature: signature,
            version_made_by: version_made_by,
            version_needed_to_extract: version_needed_to_extract,
            general_purpose_bit_flag: general_purpose_bit_flag,
            compression_method: compression_method,
            last_mod_file_time: last_mod_file_time,
            last_mod_file_date: last_mod_file_date,
            crc32: crc32,
            compressed_size: compressed_size,
            uncompressed_size: uncompressed_size,
            file_name_length: file_name_length,
            extra_field_length: extra_field_length,
            file_comment_length: file_comment_length,
            disk_number_start: disk_number_start,
            internal_file_attributes: internal_file_attributes,
            external_file_attributes: external_file_attributes,
            relative_offset_of_local_header: relative_offset_of_local_header,
            file_name: file_name,
            extra_field: extra_field,
            file_comment: file_comment,
            is_utf8: is_utf8,
            is_encrypted: is_encrypted,
        };
        cdhs.push(cdh);
    }

    Result::Ok(cdhs)
}

pub fn load_file(
    mut cursor: io::Cursor<Vec<u8>>,
    cdh: &CDHeader,
) -> Result<Vec<u8>, LoadFileError> {
    let signature = cursor.read_u32::<LittleEndian>()?;
    if signature != LFH_SIGNATURE {
        return Result::Err(LoadFileError::UnmatchHeader);
    }
    cursor.seek(io::SeekFrom::Current(2))?;
    let general_purpose_bit_flag = cursor.read_u16::<LittleEndian>()?;
    let compression_method = cursor.read_u16::<LittleEndian>()?;

    cursor.seek(io::SeekFrom::Current(4))?;
    let mut crc32 = cursor.read_u32::<LittleEndian>()?;
    let mut compressed_size = cursor.read_u32::<LittleEndian>()?;
    let mut uncompressed_size = cursor.read_u32::<LittleEndian>()?;

    let file_name_length = cursor.read_u16::<LittleEndian>()?;
    let extra_field_length = cursor.read_u16::<LittleEndian>()?;
    let file_name_bytes = ReadPodExt::read_exact(&mut cursor, file_name_length as usize)?;
    cursor.seek(io::SeekFrom::Current(extra_field_length as i64))?;

    let is_encrypted = general_purpose_bit_flag & 1 == 1;
    let is_utf8 = general_purpose_bit_flag & (1 << 11) != 0;
    let use_fd = general_purpose_bit_flag & (1 << 3) != 0;

    let file_name = decode_file_name(&file_name_bytes, is_utf8)?;

    if use_fd {
        let position = cursor.position();
        cursor.seek(io::SeekFrom::End(-12))?;
        crc32 = cursor.read_u32::<LittleEndian>()?;
        compressed_size = cursor.read_u32::<LittleEndian>()?;
        uncompressed_size = cursor.read_u32::<LittleEndian>()?;
        cursor.set_position(position);
    }

    if file_name != cdh.file_name
        || crc32 != cdh.crc32
        || is_encrypted != cdh.is_encrypted
        || compressed_size != cdh.compressed_size
        || uncompressed_size != cdh.uncompressed_size
    {
        console_log!("crc32: {} vs {}", crc32, cdh.crc32);
        console_log!("file_name: {} vs {}", file_name, cdh.file_name);
        console_log!("is_encrypted: {} vs {}", is_encrypted, cdh.is_encrypted);
        console_log!("compressed_size: {} vs {}", compressed_size, cdh.compressed_size);
        console_log!("uncompressed_size: {} vs {}", uncompressed_size, cdh.uncompressed_size);

        return Result::Err(LoadFileError::UnmatchHeader);
    }

    let start = cursor.position() as usize;
    let end = start + compressed_size as usize;
    let data = cursor.into_inner();
    let data = data[start..end].to_vec();

    match compression_method {
        COMPRESSION_METHOD_STORED => Result::Ok(data),
        COMPRESSION_METHOD_DEFLATED => {
            let cursor = io::Cursor::new(data);
            let mut decoder = libflate::deflate::Decoder::new(cursor);
            let mut buf = Vec::with_capacity(uncompressed_size as usize);
            decoder.read_to_end(&mut buf)?;
            Result::Ok(buf)
        }
        _ => Result::Err(LoadFileError::UnsupportedCompressionMethod(
            compression_method,
        )),
    }
}

fn decode_file_name(buf: &Vec<u8>, is_utf8: bool) -> Result<String, FileNameError> {
    if is_utf8 {
        Result::Ok(String::from_utf8(buf.clone())?)
    } else {
        let (res, _enc, errors) = SHIFT_JIS.decode(buf.as_slice());
        if errors {
            return Result::Err(FileNameError::FromSJISError);
        }
        Result::Ok(res.into_owned())
    }
}

impl From<io::Error> for ParseEOCDError {
    fn from(error: io::Error) -> Self {
        ParseEOCDError::IOError(error)
    }
}

impl From<io::Error> for ParseCDError {
    fn from(error: io::Error) -> Self {
        ParseCDError::IOError(error)
    }
}

impl From<FromUtf8Error> for FileNameError {
    fn from(_error: FromUtf8Error) -> Self {
        FileNameError::FromUtf8Error
    }
}

impl From<FileNameError> for ParseCDError {
    fn from(_: FileNameError) -> Self {
        ParseCDError::FileNameConversionError
    }
}

impl From<io::Error> for LoadFileError {
    fn from(error: io::Error) -> Self {
        LoadFileError::IOError(error)
    }
}

impl From<FileNameError> for LoadFileError {
    fn from(_: FileNameError) -> Self {
        LoadFileError::FileNameConversionError
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Helper: 最小構成のEOCD（22バイト）を生成
    fn create_minimal_eocd(entry_count: u16, cd_size: u32, cd_offset: u32) -> Vec<u8> {
        let mut data = Vec::new();
        // Signature
        data.extend_from_slice(&EOCD_SIGNATURE.to_le_bytes());
        // Number of this disk
        data.extend_from_slice(&0u16.to_le_bytes());
        // Number of disk with CD
        data.extend_from_slice(&0u16.to_le_bytes());
        // Number of entries on this disk
        data.extend_from_slice(&entry_count.to_le_bytes());
        // Total number of entries
        data.extend_from_slice(&entry_count.to_le_bytes());
        // CD size
        data.extend_from_slice(&cd_size.to_le_bytes());
        // CD offset
        data.extend_from_slice(&cd_offset.to_le_bytes());
        // Comment length
        data.extend_from_slice(&0u16.to_le_bytes());
        data
    }

    // Helper: Central Directoryヘッダーを生成
    fn create_cd_header(
        file_name: &str,
        local_header_offset: u32,
        compressed_size: u32,
        uncompressed_size: u32,
        crc32: u32,
        compression_method: u16,
        is_utf8: bool,
    ) -> Vec<u8> {
        let mut data = Vec::new();
        let file_name_bytes = file_name.as_bytes();
        let flag: u16 = if is_utf8 { 1 << 11 } else { 0 };

        // Signature
        data.extend_from_slice(&CD_SIGNATURE.to_le_bytes());
        // Version made by
        data.extend_from_slice(&20u16.to_le_bytes());
        // Version needed
        data.extend_from_slice(&20u16.to_le_bytes());
        // General purpose bit flag
        data.extend_from_slice(&flag.to_le_bytes());
        // Compression method
        data.extend_from_slice(&compression_method.to_le_bytes());
        // Last mod time
        data.extend_from_slice(&0u16.to_le_bytes());
        // Last mod date
        data.extend_from_slice(&0u16.to_le_bytes());
        // CRC32
        data.extend_from_slice(&crc32.to_le_bytes());
        // Compressed size
        data.extend_from_slice(&compressed_size.to_le_bytes());
        // Uncompressed size
        data.extend_from_slice(&uncompressed_size.to_le_bytes());
        // File name length
        data.extend_from_slice(&(file_name_bytes.len() as u16).to_le_bytes());
        // Extra field length
        data.extend_from_slice(&0u16.to_le_bytes());
        // File comment length
        data.extend_from_slice(&0u16.to_le_bytes());
        // Disk number start
        data.extend_from_slice(&0u16.to_le_bytes());
        // Internal file attributes
        data.extend_from_slice(&0u16.to_le_bytes());
        // External file attributes
        data.extend_from_slice(&0u32.to_le_bytes());
        // Relative offset of local header
        data.extend_from_slice(&local_header_offset.to_le_bytes());
        // File name
        data.extend_from_slice(file_name_bytes);
        data
    }

    // Helper: Local File Headerを生成
    fn create_local_file_header(
        file_name: &str,
        file_data: &[u8],
        compression_method: u16,
        crc32: u32,
        is_utf8: bool,
    ) -> Vec<u8> {
        let mut data = Vec::new();
        let file_name_bytes = file_name.as_bytes();
        let flag: u16 = if is_utf8 { 1 << 11 } else { 0 };

        // Signature
        data.extend_from_slice(&LFH_SIGNATURE.to_le_bytes());
        // Version needed
        data.extend_from_slice(&20u16.to_le_bytes());
        // General purpose bit flag
        data.extend_from_slice(&flag.to_le_bytes());
        // Compression method
        data.extend_from_slice(&compression_method.to_le_bytes());
        // Last mod time
        data.extend_from_slice(&0u16.to_le_bytes());
        // Last mod date
        data.extend_from_slice(&0u16.to_le_bytes());
        // CRC32
        data.extend_from_slice(&crc32.to_le_bytes());
        // Compressed size
        data.extend_from_slice(&(file_data.len() as u32).to_le_bytes());
        // Uncompressed size
        data.extend_from_slice(&(file_data.len() as u32).to_le_bytes());
        // File name length
        data.extend_from_slice(&(file_name_bytes.len() as u16).to_le_bytes());
        // Extra field length
        data.extend_from_slice(&0u16.to_le_bytes());
        // File name
        data.extend_from_slice(file_name_bytes);
        // File data
        data.extend_from_slice(file_data);
        data
    }

    // ===== parse_eocd tests =====

    #[test]
    fn test_parse_eocd_valid() {
        let eocd_data = create_minimal_eocd(1, 46, 100);
        let mut cursor = io::Cursor::new(eocd_data);

        let result = parse_eocd(&mut cursor);
        assert!(result.is_ok());

        let eocd = result.unwrap();
        assert_eq!(eocd.signature, EOCD_SIGNATURE);
        assert_eq!(eocd.total_number_of_entries_in_cd, 1);
        assert_eq!(eocd.cd_size, 46);
        assert_eq!(eocd.cd_offset, 100);
        assert_eq!(eocd.eocd_size, 22);
    }

    #[test]
    fn test_parse_eocd_with_comment() {
        let mut data = create_minimal_eocd(0, 0, 0);
        // コメント長を5に変更（オフセット20-21）
        data[20] = 5;
        data[21] = 0;
        // コメント追加
        data.extend_from_slice(b"hello");

        let mut cursor = io::Cursor::new(data);
        let result = parse_eocd(&mut cursor);
        assert!(result.is_ok());

        let eocd = result.unwrap();
        assert_eq!(eocd.comment, b"hello");
        assert_eq!(eocd.eocd_size, 27); // 22 + 5
    }

    #[test]
    fn test_parse_eocd_too_short() {
        let data = vec![0u8; 21]; // 22バイト未満
        let mut cursor = io::Cursor::new(data);

        let result = parse_eocd(&mut cursor);
        assert!(matches!(result, Err(ParseEOCDError::TooShortDataLength)));
    }

    // ===== parse_cd tests =====

    #[test]
    fn test_parse_cd_single_entry() {
        let cd_data = create_cd_header("test.txt", 0, 5, 5, 0x12345678, COMPRESSION_METHOD_STORED, true);
        let mut cursor = io::Cursor::new(cd_data);

        let result = parse_cd(&mut cursor, 1);
        assert!(result.is_ok());

        let headers = result.unwrap();
        assert_eq!(headers.len(), 1);
        assert_eq!(headers[0].file_name, "test.txt");
        assert_eq!(headers[0].compressed_size, 5);
        assert_eq!(headers[0].crc32, 0x12345678);
        assert!(headers[0].is_utf8);
        assert!(!headers[0].is_encrypted);
    }

    #[test]
    fn test_parse_cd_invalid_signature() {
        let mut data = vec![0u8; 46];
        // 不正なシグネチャ
        data[0..4].copy_from_slice(&0x12345678u32.to_le_bytes());

        let mut cursor = io::Cursor::new(data);
        let result = parse_cd(&mut cursor, 1);
        assert!(matches!(result, Err(ParseCDError::InvalidSignature)));
    }

    // ===== load_file tests =====

    #[test]
    fn test_load_file_stored() {
        let file_content = b"Hello";
        let crc32 = 0xF7D18982u32; // CRC32 of "Hello"
        let lfh = create_local_file_header("test.txt", file_content, COMPRESSION_METHOD_STORED, crc32, true);

        let cdh = CDHeader {
            signature: CD_SIGNATURE,
            version_made_by: 20,
            version_needed_to_extract: 20,
            general_purpose_bit_flag: 1 << 11,
            compression_method: COMPRESSION_METHOD_STORED,
            last_mod_file_time: 0,
            last_mod_file_date: 0,
            crc32,
            compressed_size: 5,
            uncompressed_size: 5,
            file_name_length: 8,
            extra_field_length: 0,
            file_comment_length: 0,
            disk_number_start: 0,
            internal_file_attributes: 0,
            external_file_attributes: 0,
            relative_offset_of_local_header: 0,
            file_name: "test.txt".to_string(),
            extra_field: vec![],
            file_comment: vec![],
            is_utf8: true,
            is_encrypted: false,
        };

        let cursor = io::Cursor::new(lfh);
        let result = load_file(cursor, &cdh);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), b"Hello");
    }

    #[test]
    fn test_load_file_invalid_signature() {
        let mut data = vec![0u8; 50];
        // 不正なシグネチャ
        data[0..4].copy_from_slice(&0x12345678u32.to_le_bytes());

        let cdh = CDHeader {
            signature: CD_SIGNATURE,
            version_made_by: 20,
            version_needed_to_extract: 20,
            general_purpose_bit_flag: 0,
            compression_method: COMPRESSION_METHOD_STORED,
            last_mod_file_time: 0,
            last_mod_file_date: 0,
            crc32: 0,
            compressed_size: 0,
            uncompressed_size: 0,
            file_name_length: 0,
            extra_field_length: 0,
            file_comment_length: 0,
            disk_number_start: 0,
            internal_file_attributes: 0,
            external_file_attributes: 0,
            relative_offset_of_local_header: 0,
            file_name: "".to_string(),
            extra_field: vec![],
            file_comment: vec![],
            is_utf8: false,
            is_encrypted: false,
        };

        let cursor = io::Cursor::new(data);
        let result = load_file(cursor, &cdh);
        assert!(matches!(result, Err(LoadFileError::UnmatchHeader)));
    }

    // ===== decode_file_name tests =====

    #[test]
    fn test_decode_file_name_utf8() {
        let name = "test.txt".as_bytes().to_vec();
        let result = decode_file_name(&name, true);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "test.txt");
    }

    #[test]
    fn test_decode_file_name_utf8_japanese() {
        let name = "テスト.txt".as_bytes().to_vec();
        let result = decode_file_name(&name, true);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "テスト.txt");
    }

    #[test]
    fn test_decode_file_name_ascii_as_sjis() {
        // ASCIIはShift_JISでも同じ
        let name = "test.txt".as_bytes().to_vec();
        let result = decode_file_name(&name, false);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "test.txt");
    }

    // ===== 追加テスト =====

    // Helper: テスト用CDHeader構造体を生成
    fn create_cdh_for_test(
        file_name: &str,
        compressed_size: u32,
        uncompressed_size: u32,
        crc32: u32,
        compression_method: u16,
    ) -> CDHeader {
        CDHeader {
            signature: CD_SIGNATURE,
            version_made_by: 20,
            version_needed_to_extract: 20,
            general_purpose_bit_flag: 1 << 11, // UTF-8
            compression_method,
            last_mod_file_time: 0,
            last_mod_file_date: 0,
            crc32,
            compressed_size,
            uncompressed_size,
            file_name_length: file_name.len() as u16,
            extra_field_length: 0,
            file_comment_length: 0,
            disk_number_start: 0,
            internal_file_attributes: 0,
            external_file_attributes: 0,
            relative_offset_of_local_header: 0,
            file_name: file_name.to_string(),
            extra_field: vec![],
            file_comment: vec![],
            is_utf8: true,
            is_encrypted: false,
        }
    }

    // Helper: DEFLATE圧縮用Local File Headerを生成
    fn create_local_file_header_deflated(
        file_name: &str,
        compressed_data: &[u8],
        uncompressed_size: u32,
        crc32: u32,
    ) -> Vec<u8> {
        let mut data = Vec::new();
        let file_name_bytes = file_name.as_bytes();
        let flag: u16 = 1 << 11; // UTF-8

        // Signature
        data.extend_from_slice(&LFH_SIGNATURE.to_le_bytes());
        // Version needed
        data.extend_from_slice(&20u16.to_le_bytes());
        // General purpose bit flag
        data.extend_from_slice(&flag.to_le_bytes());
        // Compression method (DEFLATE)
        data.extend_from_slice(&COMPRESSION_METHOD_DEFLATED.to_le_bytes());
        // Last mod time
        data.extend_from_slice(&0u16.to_le_bytes());
        // Last mod date
        data.extend_from_slice(&0u16.to_le_bytes());
        // CRC32
        data.extend_from_slice(&crc32.to_le_bytes());
        // Compressed size
        data.extend_from_slice(&(compressed_data.len() as u32).to_le_bytes());
        // Uncompressed size
        data.extend_from_slice(&uncompressed_size.to_le_bytes());
        // File name length
        data.extend_from_slice(&(file_name_bytes.len() as u16).to_le_bytes());
        // Extra field length
        data.extend_from_slice(&0u16.to_le_bytes());
        // File name
        data.extend_from_slice(file_name_bytes);
        // Compressed data
        data.extend_from_slice(compressed_data);
        data
    }

    #[test]
    fn test_load_file_deflated() {
        use libflate::deflate::Encoder;
        use std::io::Write;

        let original_data = b"Hello, World! This is a test for DEFLATE compression.";
        let crc32 = 0x7D6C5C3Au32; // 事前計算したCRC32

        // DEFLATEで圧縮
        let mut encoder = Encoder::new(Vec::new());
        encoder.write_all(original_data).unwrap();
        let compressed_data = encoder.finish().into_result().unwrap();

        let lfh = create_local_file_header_deflated(
            "test.txt",
            &compressed_data,
            original_data.len() as u32,
            crc32,
        );

        let cdh = create_cdh_for_test(
            "test.txt",
            compressed_data.len() as u32,
            original_data.len() as u32,
            crc32,
            COMPRESSION_METHOD_DEFLATED,
        );

        let cursor = io::Cursor::new(lfh);
        let result = load_file(cursor, &cdh);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), original_data);
    }

    #[test]
    fn test_parse_cd_multiple_entries() {
        let mut cd_data = Vec::new();

        // 1つ目のエントリ
        cd_data.extend(create_cd_header(
            "file1.txt", 0, 10, 10, 0x11111111, COMPRESSION_METHOD_STORED, true
        ));
        // 2つ目のエントリ
        cd_data.extend(create_cd_header(
            "file2.txt", 100, 20, 20, 0x22222222, COMPRESSION_METHOD_STORED, true
        ));
        // 3つ目のエントリ
        cd_data.extend(create_cd_header(
            "subdir/file3.txt", 200, 30, 30, 0x33333333, COMPRESSION_METHOD_DEFLATED, true
        ));

        let mut cursor = io::Cursor::new(cd_data);
        let result = parse_cd(&mut cursor, 3);
        assert!(result.is_ok());

        let headers = result.unwrap();
        assert_eq!(headers.len(), 3);

        assert_eq!(headers[0].file_name, "file1.txt");
        assert_eq!(headers[0].crc32, 0x11111111);

        assert_eq!(headers[1].file_name, "file2.txt");
        assert_eq!(headers[1].compressed_size, 20);

        assert_eq!(headers[2].file_name, "subdir/file3.txt");
        assert_eq!(headers[2].compression_method, COMPRESSION_METHOD_DEFLATED);
    }

    #[test]
    fn test_load_file_unsupported_compression() {
        let file_name = "test.txt";
        let file_data = b"test";
        let unsupported_method: u16 = 99; // 未対応の圧縮方式

        // Local File Header with unsupported compression
        let mut lfh = Vec::new();
        lfh.extend_from_slice(&LFH_SIGNATURE.to_le_bytes());
        lfh.extend_from_slice(&20u16.to_le_bytes()); // version
        lfh.extend_from_slice(&(1u16 << 11).to_le_bytes()); // flag (UTF-8)
        lfh.extend_from_slice(&unsupported_method.to_le_bytes()); // compression method
        lfh.extend_from_slice(&0u16.to_le_bytes()); // time
        lfh.extend_from_slice(&0u16.to_le_bytes()); // date
        lfh.extend_from_slice(&0u32.to_le_bytes()); // crc32
        lfh.extend_from_slice(&(file_data.len() as u32).to_le_bytes()); // compressed size
        lfh.extend_from_slice(&(file_data.len() as u32).to_le_bytes()); // uncompressed size
        lfh.extend_from_slice(&(file_name.len() as u16).to_le_bytes()); // file name length
        lfh.extend_from_slice(&0u16.to_le_bytes()); // extra field length
        lfh.extend_from_slice(file_name.as_bytes());
        lfh.extend_from_slice(file_data);

        let cdh = CDHeader {
            signature: CD_SIGNATURE,
            version_made_by: 20,
            version_needed_to_extract: 20,
            general_purpose_bit_flag: 1 << 11,
            compression_method: unsupported_method,
            last_mod_file_time: 0,
            last_mod_file_date: 0,
            crc32: 0,
            compressed_size: file_data.len() as u32,
            uncompressed_size: file_data.len() as u32,
            file_name_length: file_name.len() as u16,
            extra_field_length: 0,
            file_comment_length: 0,
            disk_number_start: 0,
            internal_file_attributes: 0,
            external_file_attributes: 0,
            relative_offset_of_local_header: 0,
            file_name: file_name.to_string(),
            extra_field: vec![],
            file_comment: vec![],
            is_utf8: true,
            is_encrypted: false,
        };

        let cursor = io::Cursor::new(lfh);
        let result = load_file(cursor, &cdh);
        assert!(matches!(
            result,
            Err(LoadFileError::UnsupportedCompressionMethod(99))
        ));
    }

    #[test]
    fn test_load_file_stored_with_helper() {
        // create_cdh_for_testヘルパーを使った簡潔なテスト
        let file_content = b"Hello";
        let crc32 = 0xF7D18982u32;
        let lfh = create_local_file_header("test.txt", file_content, COMPRESSION_METHOD_STORED, crc32, true);
        let cdh = create_cdh_for_test("test.txt", 5, 5, crc32, COMPRESSION_METHOD_STORED);

        let cursor = io::Cursor::new(lfh);
        let result = load_file(cursor, &cdh);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), b"Hello");
    }
}