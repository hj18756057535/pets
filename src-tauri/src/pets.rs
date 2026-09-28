use base64::{ engine::general_purpose::STANDARD, Engine };
use serde_json::{ json, Value };
use std::{ collections::HashSet, fs, io::{ Cursor, Read }, path::Path };

const MAX_ZIP: usize = 25 * 1024 * 1024;
const MAX_IMAGE: usize = 20 * 1024 * 1024;
const SITE: &str = "https://codex-pets.net";

#[derive(Clone)]
pub struct Pet {
    pub name: String,
    pub description: String,
    pub version: u32,
    pub image: Vec<u8>,
    pub source: String,
}
impl Pet {
    pub fn image_url(&self) -> String {
        format!("data:image/webp;base64,{}", STANDARD.encode(&self.image))
    }
    pub fn preview(&self, token: &str) -> Value {
        json!({"token": token, "name": self.name, "description": self.description, "version": self.version, "image": self.image_url()})
    }
}

fn name(meta: &Value) -> String {
    meta.get("displayName")
        .or_else(|| meta.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("我的宠物")
        .chars()
        .take(60)
        .collect()
}
fn description(meta: &Value) -> String {
    meta.get("description").and_then(Value::as_str).unwrap_or("").chars().take(300).collect()
}
fn webp_size(b: &[u8]) -> Result<(u32, u32), String> {
    if b.len() < 30 || &b[..4] != b"RIFF" || &b[8..12] != b"WEBP" {
        return Err("宠物图片必须是有效的 WebP".into());
    }
    let mut at = 12;
    while at + 8 <= b.len() {
        let len = u32::from_le_bytes(b[at + 4..at + 8].try_into().unwrap()) as usize;
        let start = at + 8;
        if start + len > b.len() {
            break;
        }
        let c = &b[start..start + len];
        match &b[at..at + 4] {
            b"VP8X" if c.len() >= 10 => {
                return Ok((
                    u32::from_le_bytes([c[4], c[5], c[6], 0]) + 1,
                    u32::from_le_bytes([c[7], c[8], c[9], 0]) + 1,
                ));
            }
            b"VP8 " if c.len() >= 10 && c[3..6] == [0x9d, 0x01, 0x2a] => {
                return Ok((
                    (u16::from_le_bytes([c[6], c[7]]) & 0x3fff) as u32,
                    (u16::from_le_bytes([c[8], c[9]]) & 0x3fff) as u32,
                ));
            }
            b"VP8L" if c.len() >= 5 && c[0] == 0x2f => {
                let bits = u32::from_le_bytes(c[1..5].try_into().unwrap());
                return Ok(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1));
            }
            _ => {}
        }
        at = start + len + (len & 1);
    }
    Err("无法识别宠物图片尺寸".into())
}
fn from_parts(meta: Value, image: Vec<u8>, source: String) -> Result<Pet, String> {
    if image.len() > MAX_IMAGE {
        return Err("宠物图片不能超过 20 MB".into());
    }
    let version = meta.get("spriteVersionNumber").and_then(Value::as_u64).unwrap_or(1);
    let (width, height) = webp_size(&image)?;
    if
        ![1, 2].contains(&version) ||
        width != 1536 ||
        height != (if version == 2 { 2288 } else { 1872 })
    {
        return Err("目前支持标准 Codex V1 / V2 精灵图，请检查版本与尺寸".into());
    }
    Ok(Pet {
        name: name(&meta),
        description: description(&meta),
        version: version as u32,
        image,
        source,
    })
}
pub fn read_directory(dir: &Path) -> Result<Pet, String> {
    let manifest = dir.join("pet.json");
    if
        fs
            ::metadata(&manifest)
            .map_err(|e| e.to_string())?
            .len() > 64 * 1024
    {
        return Err("宠物配置文件过大".into());
    }
    let bytes = fs::read(&manifest).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&bytes);
    let meta: Value = serde_json
        ::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|_| "pet.json 不是有效的 JSON 文件")?;
    let filename = meta
        .get("spritesheetPath")
        .and_then(Value::as_str)
        .unwrap_or("spritesheet.webp");
    if
        filename !=
            Path::new(filename)
                .file_name()
                .and_then(|f| f.to_str())
                .unwrap_or("") ||
        filename.chars().any(|c| ['/', '\\', ':'].contains(&c)) ||
        filename == "." ||
        filename == ".."
    {
        return Err("宠物图片必须位于宠物目录内".into());
    }
    let image_path = dir.join(filename);
    let base = fs::canonicalize(dir).map_err(|e| e.to_string())?;
    let image_real = fs::canonicalize(&image_path).map_err(|e| e.to_string())?;
    if !image_real.starts_with(base) {
        return Err("宠物图片不能链接到其他目录".into());
    }
    if
        fs
            ::metadata(&image_real)
            .map_err(|e| e.to_string())?
            .len() > (MAX_IMAGE as u64)
    {
        return Err("宠物图片不能超过 20 MB".into());
    }
    from_parts(meta, fs::read(image_real).map_err(|e| e.to_string())?, "local".into())
}
pub fn read_zip(bytes: &[u8]) -> Result<Pet, String> {
    if bytes.len() > MAX_ZIP {
        return Err("ZIP 压缩包不能超过 25 MB".into());
    }
    let mut archive = zip::ZipArchive
        ::new(Cursor::new(bytes))
        .map_err(|_| "无法读取 ZIP，请确认下载完整且不是加密压缩包")?;
    if archive.len() > 128 {
        return Err("压缩包文件过多，请选择单只宠物的资源包".into());
    }
    let mut names = HashSet::new();
    let mut manifest: Option<(String, Value)> = None;
    let mut images = std::collections::HashMap::new();
    let mut total = 0u64;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(|e| e.to_string())?;
        let path = file.name().replace('\\', "/");
        if
            file.name().contains('\\') ||
            file.name().contains(':') ||
            path.starts_with('/') ||
            path.split('/').any(|part| part == ".." || part == ".")
        {
            return Err("压缩包包含不安全的文件路径".into());
        }
        if !names.insert(path.to_lowercase()) {
            return Err("压缩包包含重复文件".into());
        }
        if file.unix_mode().is_some_and(|mode| (mode & 0xf000) == 0xa000) {
            return Err("宠物包不能包含符号链接".into());
        }
        total += file.size();
        if total > (MAX_ZIP as u64) {
            return Err("压缩包解压后超过 25 MB".into());
        }
        if file.is_dir() {
            continue;
        }
        let is_manifest =
            path.rsplit('/').next() == Some("pet.json") && !path.starts_with("__MACOSX/");
        if !is_manifest && !path.to_ascii_lowercase().ends_with(".webp") {
            continue;
        }
        let limit = if is_manifest { 64 * 1024 } else { MAX_IMAGE };
        if file.size() > (limit as u64) {
            return Err("宠物文件过大".into());
        }
        let mut data = Vec::new();
        file
            .by_ref()
            .take((limit as u64) + 1)
            .read_to_end(&mut data)
            .map_err(|e| e.to_string())?;
        if data.len() > limit {
            return Err("解压后的文件超出大小限制".into());
        }
        if is_manifest {
            if manifest.is_some() {
                return Err("压缩包中需要恰好一份 pet.json".into());
            }
            let text = String::from_utf8_lossy(&data);
            let meta = serde_json
                ::from_str::<Value>(text.trim_start_matches('\u{feff}'))
                .map_err(|_| "pet.json 不是有效的 JSON 文件")?;
            manifest = Some((path, meta));
        } else {
            images.insert(path, data);
        }
    }
    let (manifest_path, meta) = manifest.ok_or("压缩包中需要恰好一份 pet.json")?;
    let filename = meta
        .get("spritesheetPath")
        .and_then(Value::as_str)
        .unwrap_or("spritesheet.webp");
    if
        filename.is_empty() ||
        filename.chars().any(|c| ['/', '\\', ':'].contains(&c)) ||
        filename == "." ||
        filename == ".."
    {
        return Err("宠物图片必须与 pet.json 在同一个文件夹".into());
    }
    let prefix = manifest_path
        .rsplit_once('/')
        .map(|(dir, _)| format!("{dir}/"))
        .unwrap_or_default();
    let image = images
        .remove(&format!("{prefix}{filename}"))
        .ok_or("压缩包中缺少 pet.json 指定的精灵图")?;
    from_parts(meta, image, "local".into())
}
pub fn read_local(path: &Path, kind: &str) -> Result<Pet, String> {
    if kind == "folder" {
        return read_directory(path);
    }
    if
        fs
            ::metadata(path)
            .map_err(|e| e.to_string())?
            .len() > (MAX_ZIP as u64)
    {
        return Err("请选择不超过 25 MB 的 ZIP 压缩包".into());
    }
    read_zip(&fs::read(path).map_err(|e| e.to_string())?)
}
fn checked_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw).map_err(|_| "请粘贴完整的 Codex Pets 分享链接")?;
    if
        url.scheme() != "https" ||
        url.host_str() != Some("codex-pets.net") ||
        url.port().is_some() ||
        !url.username().is_empty() ||
        url.password().is_some()
    {
        return Err("目前只支持 https://codex-pets.net 的宠物链接".into());
    }
    Ok(url)
}
fn download(
    client: &reqwest::blocking::Client,
    url: reqwest::Url,
    limit: usize
) -> Result<Vec<u8>, String> {
    let response = client
        .get(url)
        .send()
        .map_err(|_| "暂时无法连接 Codex Pets，请检查网络或使用本地 ZIP 导入")?;
    if
        !response.status().is_success() ||
        response.content_length().is_some_and(|n| n > (limit as u64))
    {
        return Err("网站接口暂时不可用，请改用下载后的 ZIP 导入".into());
    }
    let mut limited = response.take((limit as u64) + 1);
    let mut bytes = Vec::new();
    limited.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() > limit {
        return Err("下载的宠物包过大".into());
    }
    Ok(bytes)
}
pub fn read_shared(raw: &str) -> Result<Pet, String> {
    let url = checked_url(raw)?;
    let route = if url.path() == "/" {
        url.fragment().unwrap_or("").split('?').next().unwrap_or("")
    } else {
        url.path()
    };
    let mut parts = route.trim_matches('/').split('/');
    let kind = parts.next().unwrap_or("");
    let id = parts.next().unwrap_or("");
    if
        !["share", "pets"].contains(&kind) ||
        id.is_empty() ||
        id.len() > 151 ||
        parts.next().is_some() ||
        !id.chars().next().unwrap().is_ascii_alphanumeric() ||
        !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("链接应指向一只宠物，例如 /share/tiebaojin-dog".into());
    }
    let client = reqwest::blocking::Client
        ::builder()
        .timeout(std::time::Duration::from_secs(45))
        .redirect(
            reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 4 || checked_url(attempt.url().as_str()).is_err() {
                    attempt.stop()
                } else {
                    attempt.follow()
                }
            })
        )
        .build()
        .map_err(|e| e.to_string())?;
    let metadata = download(&client, checked_url(&format!("{SITE}/api/pets/{id}"))?, 256 * 1024)?;
    let value: Value = serde_json
        ::from_slice(&metadata)
        .map_err(|_| "网站接口暂时不可用，请改用下载后的 ZIP 导入")?;
    let raw_download = value
        .pointer("/pet/downloadUrl")
        .and_then(Value::as_str)
        .ok_or("网站没有提供宠物下载地址，请改用 ZIP 导入")?;
    let resolved = reqwest::Url
        ::parse(SITE)
        .unwrap()
        .join(raw_download)
        .map_err(|_| "网站返回了无效的下载地址")?;
    let bytes = download(&client, checked_url(resolved.as_str())?, MAX_ZIP)?;
    let mut pet = read_zip(&bytes)?;
    pet.source = format!("{SITE}/share/{id}");
    Ok(pet)
}
pub fn commit(dir: &Path, pet: &Pet) -> Result<Pet, String> {
    let folder = format!(
        "pet-import-{}-{}",
        chrono::Utc::now().timestamp_millis(),
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    );
    let destination = dir.join(&folder);
    fs::create_dir(&destination).map_err(|e| e.to_string())?;
    fs::write(destination.join("spritesheet.webp"), &pet.image).map_err(|e| e.to_string())?;
    fs
        ::write(
            destination.join("pet.json"),
            serde_json
                ::to_vec_pretty(
                    &json!({"displayName": pet.name, "description": pet.description, "spritesheetPath": "spritesheet.webp", "spriteVersionNumber": pet.version})
                )
                .map_err(|e| e.to_string())?
        )
        .map_err(|e| e.to_string())?;
    let loaded = read_directory(&destination)?;
    let selection = dir.join("selected-pet.json");
    let temp = dir.join("selected-pet.json.tmp");
    fs
        ::write(
            &temp,
            serde_json
                ::to_vec(&json!({"directory": folder, "source": pet.source}))
                .map_err(|e| e.to_string())?
        )
        .map_err(|e| e.to_string())?;
    crate::model::replace_file(&temp, &selection)?;
    Ok(loaded)
}
pub fn selected(dir: &Path) -> Option<Pet> {
    let value: Value = serde_json::from_slice(&fs::read(dir.join("selected-pet.json")).ok()?).ok()?;
    let folder = value.get("directory")?.as_str()?;
    if
        !folder.starts_with("pet-import-") ||
        !folder[11..].chars().all(|c| c.is_ascii_digit() || c == '-' || ('a'..='f').contains(&c))
    {
        return None;
    }
    read_directory(&dir.join(folder)).ok()
}
pub fn initial(root: &Path) -> Option<Pet> {
    selected(root).or_else(|| read_directory(&root.join("pet")).ok())
}
