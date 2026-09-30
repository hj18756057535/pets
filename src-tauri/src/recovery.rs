//! Per-operation, one-to-one token maps. Persistence is explicit and authenticated/encrypted.
use crate::masking::{self, ColumnRule, Keyword, Prepared, Rule, Sheet, TextResult};
use ring::{aead, pbkdf2, rand::{SecureRandom, SystemRandom}};
use serde::{Deserialize, Serialize};
use std::{collections::{HashMap, HashSet}, num::NonZeroU32, sync::OnceLock};
use zeroize::Zeroizing;

pub const MAX_MAP_FILE: usize = 5 * 1024 * 1024;
const MAGIC: &[u8; 8] = b"PDMAP001";
const MAX_TEXT: usize = 2 * 1024 * 1024;
const PREFIX: &str = "[[PD_";

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry { pub token: String, pub original: String }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Mapping { pub id: String, pub created_at: String, pub kind: String, pub entries: Vec<Entry> }

impl Mapping {
    fn new(kind: &str, originals: impl IntoIterator<Item = String>) -> Result<Self, String> {
        let id = uuid::Uuid::new_v4().simple().to_string();
        let mut seen = HashSet::new(); let mut entries = Vec::new();
        for original in originals {
            if original.is_empty() || original.len() > 4096 || original.contains(PREFIX) { return Err("可恢复关键词不能为空、超过 4096 字节或包含已有 PD 占位符".into()); }
            if seen.insert(original.clone()) {
                entries.push(Entry { token: format!("[[PD_{id}_{:04}]]", entries.len() + 1), original });
            }
            if entries.len() > 1000 { return Err("一份映射最多支持 1000 个不同原值".into()); }
        }
        Ok(Self { id, created_at: chrono::Utc::now().to_rfc3339(), kind: kind.into(), entries })
    }
    pub fn summary(&self) -> serde_json::Value {
        serde_json::json!({ "id": self.id, "createdAt": self.created_at, "kind": self.kind, "count": self.entries.len() })
    }
    fn rules(&self, rules: &[Keyword]) -> Vec<Keyword> {
        rules.iter().map(|rule| Keyword { find: rule.find.clone(), replace: self.entries.iter().find(|entry| entry.original == rule.find).unwrap().token.clone() }).collect()
    }
    fn validate(&self) -> Result<(), String> {
        let fail = || "映射文件结构无效".to_string();
        if self.id.len() != 32 || !self.id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) || !["文本", "表格"].contains(&self.kind.as_str()) || chrono::DateTime::parse_from_rfc3339(&self.created_at).is_err() || self.entries.is_empty() || self.entries.len() > 1000 { return Err(fail()); }
        let mut tokens = HashSet::new(); let mut originals = HashSet::new();
        let expected = format!("[[PD_{}_", self.id);
        for entry in &self.entries {
            let Some(number) = entry.token.strip_prefix(&expected).and_then(|v| v.strip_suffix("]]")) else { return Err(fail()); };
            if number.len() != 4 || !number.bytes().all(|b| b.is_ascii_digit()) || number == "0000" || entry.original.is_empty() || entry.original.len() > 4096 || entry.original.contains(PREFIX) || !tokens.insert(&entry.token) || !originals.insert(&entry.original) { return Err(fail()); }
        }
        Ok(())
    }
}

fn token_regex() -> &'static regex::Regex {
    static REGEX: OnceLock<regex::Regex> = OnceLock::new();
    REGEX.get_or_init(|| regex::Regex::new(r"\[\[PD_[^\]\r\n]{1,120}\]\]").unwrap())
}

pub fn text(input: &str, rules: &[Keyword]) -> Result<(TextResult, Mapping), String> {
    masking::validate_keywords(rules)?;
    if input.contains(PREFIX) { return Err("原文含有 PD 占位符，请使用原始数据生成新的映射，避免二次脱敏混淆".into()); }
    let mut mapping = Mapping::new("文本", rules.iter().map(|r| r.find.clone()))?;
    let result = masking::replace_keywords(input, &mapping.rules(rules))?;
    let used: HashSet<_> = token_regex().find_iter(&result.text).map(|v| v.as_str()).collect();
    mapping.entries.retain(|entry| used.contains(entry.token.as_str()));
    Ok((result, mapping))
}

pub fn sheet(input: &Sheet, columns: &[ColumnRule], header: bool) -> Result<(Prepared, Option<Mapping>), String> {
    let mut originals = Vec::new();
    for column in columns {
        if let Rule::Keywords { rules } = &column.rule { masking::validate_keywords(rules)?; originals.extend(rules.iter().map(|r| r.find.clone())); }
    }
    if originals.is_empty() { return Ok((masking::prepare(input, columns, header)?, None)); }
    if input.rows.iter().flatten().any(|cell| cell.contains(PREFIX)) { return Err("表格含有 PD 占位符，请使用原始文件生成新的映射".into()); }
    let mut mapping = Mapping::new("表格", originals)?;
    let effective: Vec<_> = columns.iter().map(|column| ColumnRule { column: column.column, rule: match &column.rule {
        Rule::Keywords { rules } => Rule::Keywords { rules: mapping.rules(rules) },
        other => other.clone(),
    } }).collect();
    let prepared = masking::prepare(input, &effective, header)?;
    let used: HashSet<_> = prepared.rows.iter().flatten().flat_map(|cell| token_regex().find_iter(cell).map(|v| v.as_str())).collect();
    mapping.entries.retain(|entry| used.contains(entry.token.as_str()));
    Ok((prepared, Some(mapping)))
}

#[derive(Serialize)]
pub struct Restored { pub text: String, pub restored: usize, pub unresolved: usize }
pub fn restore(input: &str, mapping: &Mapping) -> Result<Restored, String> {
    mapping.validate()?;
    if input.len() > MAX_TEXT { return Err("AI 返回文本不能超过 2 MiB".into()); }
    let entries: HashMap<_, _> = mapping.entries.iter().map(|e| (e.token.as_str(), e.original.as_str())).collect();
    let mut output = String::new(); let mut last = 0; let mut restored = 0;
    for found in token_regex().find_iter(input) {
        output.push_str(&input[last..found.start()]);
        if let Some(original) = entries.get(found.as_str()) { output.push_str(original); restored += 1; }
        else { output.push_str(found.as_str()); }
        last = found.end();
        if output.len() > MAX_TEXT { return Err("还原结果超过 2 MiB，请分段处理".into()); }
    }
    output.push_str(&input[last..]);
    if output.len() > MAX_TEXT { return Err("还原结果超过 2 MiB，请分段处理".into()); }
    Ok(Restored { text: output, restored, unresolved: input.matches(PREFIX).count().saturating_sub(restored) })
}

fn password_key(password: &str, salt: &[u8]) -> Result<aead::LessSafeKey, String> {
    if password.chars().count() < 10 || password.len() > 1024 { return Err("映射密码至少 10 个字符，最多 1024 字节".into()); }
    let mut key = Zeroizing::new([0u8; 32]);
    pbkdf2::derive(pbkdf2::PBKDF2_HMAC_SHA256, NonZeroU32::new(600_000).unwrap(), salt, password.as_bytes(), key.as_mut());
    Ok(aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, key.as_ref()).map_err(|_| "加密初始化失败")?))
}

pub fn encrypt(mapping: &Mapping, password: &str) -> Result<Vec<u8>, String> {
    mapping.validate()?;
    let mut salt = [0u8; 16]; let mut nonce = [0u8; 12]; let random = SystemRandom::new();
    random.fill(&mut salt).and_then(|_| random.fill(&mut nonce)).map_err(|_| "无法生成加密随机数")?;
    let key = password_key(password, &salt)?;
    let mut header = MAGIC.to_vec(); header.extend_from_slice(&salt); header.extend_from_slice(&nonce);
    let mut payload = Zeroizing::new(serde_json::to_vec(mapping).map_err(|_| "映射编码失败")?);
    if payload.len() + 52 > MAX_MAP_FILE { return Err("映射文件超过 5 MiB".into()); }
    key.seal_in_place_append_tag(aead::Nonce::assume_unique_for_key(nonce), aead::Aad::from(header.as_slice()), &mut *payload).map_err(|_| "映射加密失败")?;
    header.extend_from_slice(&payload); Ok(header)
}

pub fn decrypt(bytes: &[u8], password: &str) -> Result<Mapping, String> {
    if bytes.len() < 52 || bytes.len() > MAX_MAP_FILE || &bytes[..8] != MAGIC { return Err("不支持或已损坏的映射文件".into()); }
    let key = password_key(password, &bytes[8..24])?;
    let nonce: [u8; 12] = bytes[24..36].try_into().unwrap();
    let mut payload = Zeroizing::new(bytes[36..].to_vec());
    let plain = key.open_in_place(aead::Nonce::assume_unique_for_key(nonce), aead::Aad::from(&bytes[..36]), &mut payload).map_err(|_| "密码错误或映射文件已损坏")?;
    let mapping: Mapping = serde_json::from_slice(plain).map_err(|_| "映射文件结构无效")?;
    mapping.validate()?; Ok(mapping)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rules() -> Vec<Keyword> { vec![Keyword { find: "张三".into(), replace: "相同别名".into() }, Keyword { find: "张三丰".into(), replace: "相同别名".into() }] }
    #[test]
    fn reversible_keywords_are_unique_consistent_and_do_not_leak_originals() {
        let (masked, map) = text("张三丰见张三，张三回复", &rules()).unwrap();
        assert!(!masked.text.contains("张三"));
        assert_eq!(map.entries.len(), 2);
        assert_ne!(map.entries[0].token, map.entries[1].token);
        let response = format!("结论：{}", masked.text);
        let result = restore(&response, &map).unwrap();
        assert_eq!(result.text, "结论：张三丰见张三，张三回复"); assert_eq!(result.restored, 3);
        let (_, another) = text("张三", &rules()).unwrap();
        assert_eq!(restore(&response, &another).unwrap().restored, 0);
        assert!(text("已有[[PD_test_0001]]", &rules()).is_err());
    }
    #[test]
    fn unknown_and_modified_tokens_are_preserved_and_reported() {
        let (_, map) = text("张三", &rules()).unwrap();
        let input = format!("{} [[PD_other_0001]] [[PD_broken", map.entries[0].token);
        let result = restore(&input, &map).unwrap();
        assert_eq!(result.restored, 1); assert_eq!(result.unresolved, 2);
        assert!(result.text.ends_with("[[PD_other_0001]] [[PD_broken"));
    }
    #[test]
    fn tables_reuse_tokens_across_columns_and_keep_irreversible_masks_separate() {
        let sheet = Sheet { rows: vec![vec!["姓名".into(), "联系人".into(), "手机".into()], vec!["张三".into(), "张三".into(), "13812345678".into()]], width: 3, first_row: 0 };
        let columns = vec![ColumnRule { column: 0, rule: Rule::Keywords { rules: rules() } }, ColumnRule { column: 1, rule: Rule::Keywords { rules: rules() } }, ColumnRule { column: 2, rule: Rule::Mask { head: 3, tail: 4 } }];
        let (prepared, map) = super::sheet(&sheet, &columns, true).unwrap();
        assert_eq!(prepared.rows[1][0], prepared.rows[1][1]);
        assert_eq!(prepared.rows[1][2], "138****5678");
        let map = map.unwrap(); assert_eq!(map.entries.len(), 1);
        assert_eq!(restore(&prepared.rows[1].join(" | "), &map).unwrap().text, "张三 | 张三 | 138****5678");
    }
    #[test]
    fn encrypted_mapping_roundtrip_rejects_wrong_password_tampering_and_invalid_maps() {
        let (_, map) = text("张三", &rules()).unwrap();
        let encrypted = encrypt(&map, "only-test-password").unwrap();
        assert!(!encrypted.windows("张三".len()).any(|w| w == "张三".as_bytes()));
        let imported = decrypt(&encrypted, "only-test-password").unwrap();
        assert_eq!(imported.id, map.id);
        assert_eq!(restore(&map.entries[0].token, &imported).unwrap().text, "张三");
        assert!(decrypt(&encrypted, "incorrect-password").is_err());
        let mut tampered = encrypted.clone(); *tampered.last_mut().unwrap() ^= 1;
        assert!(decrypt(&tampered, "only-test-password").is_err());
        assert!(encrypt(&map, "short").is_err());
        let mut invalid = map.clone(); invalid.entries[0].original = "[[PD_nested]]".into();
        assert!(encrypt(&invalid, "only-test-password").is_err());
        invalid = map.clone(); invalid.entries.push(invalid.entries[0].clone()); assert!(invalid.validate().is_err());
        assert!(decrypt(b"bad", "only-test-password").is_err());
    }
}
