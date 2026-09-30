//! Bounded, review-first format detection. These are candidates, not identity verification.
use crate::masking::Sheet;
use regex::Regex;
use serde::Serialize;
use std::{collections::HashMap, sync::OnceLock};

const LIMIT: usize = 100;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub value: String, pub kind: &'static str, pub note: &'static str,
    pub count: usize, pub columns: Vec<usize>,
}
#[derive(Default, Serialize)]
pub struct Detection { pub candidates: Vec<Candidate>, pub truncated: bool }

fn patterns() -> &'static [Regex; 3] {
    static PATTERNS: OnceLock<[Regex; 3]> = OnceLock::new();
    PATTERNS.get_or_init(|| [
        Regex::new(r"[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}").unwrap(),
        Regex::new(r"[1-9][0-9]{16}[0-9Xx]").unwrap(),
        Regex::new(r"(?:\+86[ -]?)?1[3-9][0-9][ -]?[0-9]{4}[ -]?[0-9]{4}").unwrap(),
    ])
}

fn valid_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 18 || !bytes[..17].iter().all(u8::is_ascii_digit) { return false; }
    let date = chrono::NaiveDate::parse_from_str(&value[6..14], "%Y%m%d");
    let Ok(date) = date else { return false; };
    if date < chrono::NaiveDate::from_ymd_opt(1800, 1, 1).unwrap() || date > chrono::Local::now().date_naive() || &value[14..17] == "000" { return false; }
    let weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
    let sum: usize = bytes[..17].iter().zip(weights).map(|(b, w)| (b - b'0') as usize * w).sum();
    b"10X98765432"[sum % 11] == bytes[17].to_ascii_uppercase()
}

fn boundary(text: &str, start: usize, end: usize, email: bool) -> bool {
    let left = text[..start].chars().next_back();
    let right = text[end..].chars().next();
    let blocked = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '@' || (email && ".!#$%&'*+/=?^`{|}~-".contains(c));
    // A final ASCII period is normal sentence punctuation after an email domain.
    !left.is_some_and(blocked) && !right.is_some_and(|c| if email && c == '.' { false } else { blocked(c) })
}

fn scan(text: &str, column: Option<usize>, result: &mut Detection, indices: &mut HashMap<String, usize>) {
    let mut matches = Vec::new();
    for (kind, pattern) in patterns().iter().enumerate() {
        for found in pattern.find_iter(text) {
            if boundary(text, found.start(), found.end(), kind == 0) { matches.push((found.start(), found.end(), kind)); }
        }
    }
    matches.sort_unstable_by_key(|&(start, end, kind)| (start, std::cmp::Reverse(end), kind));
    let mut last_end = 0;
    for (start, end, kind) in matches {
        if start < last_end { continue; }
        last_end = end;
        let value = &text[start..end];
        if let Some(&index) = indices.get(value) {
            let item = &mut result.candidates[index]; item.count += 1;
            if let Some(c) = column { if !item.columns.contains(&c) { item.columns.push(c); } }
            continue;
        }
        if result.candidates.len() == LIMIT { result.truncated = true; continue; }
        let (kind, note) = match kind {
            0 => ("邮箱", "常见 ASCII 邮箱格式；不验证邮箱是否存在"),
            1 if valid_id(value) => ("身份证", "18 位格式、出生日期与校验位通过；未核实行政区划或真实身份"),
            1 => ("疑似身份证", "18 位格式；出生日期、顺序码或校验位未通过，请人工判断"),
            _ => ("手机号", "中国大陆手机号格式；不验证号码是否分配或在用"),
        };
        indices.insert(value.to_string(), result.candidates.len());
        result.candidates.push(Candidate { value: value.into(), kind, note, count: 1, columns: column.into_iter().collect() });
    }
}

pub fn text(input: &str) -> Result<Detection, String> {
    if input.len() > 2 * 1024 * 1024 { return Err("识别文本不能超过 2 MiB".into()); }
    let mut result = Detection::default();
    scan(input, None, &mut result, &mut HashMap::new());
    Ok(result)
}

pub fn sheet(input: &Sheet, header: bool) -> Detection {
    let mut result = Detection::default(); let mut indices = HashMap::new();
    for row in input.rows.iter().skip(usize::from(header)) {
        for (column, value) in row.iter().enumerate() { scan(value, Some(column), &mut result, &mut indices); }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recognizes_chinese_context_counts_and_phone_formats() {
        let result = text("手机13812345678，电话+86 139-1234-5678，邮箱a.b+tag@example.com；重复13812345678").unwrap();
        assert_eq!(result.candidates.len(), 3);
        assert_eq!(result.candidates[0].count, 2);
        assert_eq!(result.candidates[1].kind, "手机号");
        assert_eq!(result.candidates[2].value, "a.b+tag@example.com");
    }
    #[test]
    fn validates_id_checksum_and_dates_without_hiding_suspicious_ids() {
        assert!(valid_id("11010519491231002X"));
        assert!(valid_id("11010519491231002x"));
        assert!(!valid_id("110105194912310021"));
        assert!(!valid_id("11010519490231002X"));
        let result = text("证件11010519491231002X，11010519490231002X").unwrap();
        assert_eq!(result.candidates[0].kind, "身份证");
        assert_eq!(result.candidates[1].kind, "疑似身份证");
    }
    #[test]
    fn boundaries_and_email_overlap_do_not_produce_inner_phone_matches() {
        let result = text("a13812345678 0138123456789 13812345678@example.com").unwrap();
        assert_eq!(result.candidates.len(), 1);
        assert_eq!(result.candidates[0].kind, "邮箱");
    }
    #[test]
    fn sheet_detection_respects_headers_and_tracks_all_columns() {
        let sheet = Sheet { rows: vec![vec!["13800000000".into()], vec!["13812345678".into(), "13812345678".into()]], width: 2, first_row: 0 };
        let result = super::sheet(&sheet, true);
        assert_eq!(result.candidates.len(), 1);
        assert_eq!(result.candidates[0].columns, [0, 1]);
        assert_eq!(result.candidates[0].count, 2);
        let many = (0..101).map(|i| format!("user{i}@example.com")).collect::<Vec<_>>().join(" ");
        let result = text(&many).unwrap();
        assert!(result.truncated); assert_eq!(result.candidates.len(), 100);
    }
}
