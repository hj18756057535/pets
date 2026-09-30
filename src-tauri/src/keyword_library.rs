//! User-initiated local rule persistence, independent of pet state and logs.
use crate::masking::{validate_keywords, Keyword};
use serde::{Deserialize, Serialize};
use std::{fs, io::{Read, Write}, path::Path};

#[derive(Clone, Deserialize, Serialize)]
pub struct Group { pub name: String, pub rules: Vec<Keyword> }
const LIMIT: usize = 4 * 1024 * 1024;

pub fn load(path: &Path) -> Result<Vec<Group>, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(_) => return Err("无法读取本地关键词库".into()),
    };
    let mut bytes = Vec::new();
    file.take(LIMIT as u64 + 1).read_to_end(&mut bytes).map_err(|_| "读取关键词库失败")?;
    if bytes.len() > LIMIT { return Err("关键词库超过 4 MiB".into()); }
    let groups: Vec<Group> = serde_json::from_slice(&bytes).map_err(|_| "关键词库格式损坏，未覆盖文件")?;
    validate(&groups)?;
    Ok(groups)
}

fn validate(groups: &[Group]) -> Result<(), String> {
    if groups.len() > 50 { return Err("最多保存 50 个规则组".into()); }
    let mut names = std::collections::HashSet::new();
    for group in groups {
        if group.name.trim().is_empty() || group.name.chars().count() > 80 || !names.insert(&group.name) {
            return Err("规则组名称需唯一，且为 1～80 个字符".into());
        }
        validate_keywords(&group.rules)?;
    }
    Ok(())
}

pub fn save(path: &Path, mut group: Group, overwrite: bool) -> Result<Vec<Group>, String> {
    group.name = group.name.trim().to_owned();
    let mut groups = load(path)?;
    if let Some(index) = groups.iter().position(|g| g.name == group.name) {
        if !overwrite { return Err("已存在同名规则组，请改名或点击更新所选组".into()); }
        groups[index] = group;
    } else {
        if overwrite { return Err("所选规则组已不存在，请重新加载".into()); }
        groups.push(group);
    }
    validate(&groups)?;
    let bytes = serde_json::to_vec_pretty(&groups).map_err(|_| "规则编码失败")?;
    if bytes.len() > LIMIT { return Err("关键词库超过 4 MiB，请减少规则".into()); }
    fs::create_dir_all(path.parent().ok_or("关键词库路径无效")?).map_err(|_| "无法创建关键词库目录")?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|_| "无法保存关键词库")?;
        file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|_| "关键词库写入失败")?;
        drop(file);
        fs::rename(&temporary, path).map_err(|_| "关键词库替换失败，原文件保留")?;
        Ok(groups)
    })();
    if result.is_err() { let _ = fs::remove_file(temporary); }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persists_and_requires_explicit_update() {
        let dir = std::env::temp_dir().join(format!("petdesk-rules-{}", uuid::Uuid::new_v4()));
        let path = dir.join("rules.json");
        let group = || Group { name: "客户".into(), rules: vec![Keyword { find: "示例公司".into(), replace: "公司 A".into() }] };
        save(&path, group(), false).unwrap();
        assert_eq!(load(&path).unwrap()[0].rules[0].replace, "公司 A");
        assert!(save(&path, group(), false).is_err());
        let mut updated = group(); updated.rules[0].replace = "公司 B".into();
        save(&path, updated, true).unwrap();
        assert_eq!(load(&path).unwrap()[0].rules[0].replace, "公司 B");
        fs::write(&path, b"broken").unwrap();
        assert!(save(&path, group(), true).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"broken");
        fs::remove_dir_all(dir).unwrap();
    }
}
