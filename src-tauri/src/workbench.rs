use chrono::{Datelike, Local, NaiveDate, NaiveTime, Utc};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashSet, fs, io::Write, path::{Path, PathBuf}};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    pub date: String,
    pub time: String,
    pub category: String,
    pub important: bool,
    pub done: bool,
    pub note: String,
    #[serde(default)]
    pub shortcut_ids: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
    #[serde(default)]
    pub deleted: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Shortcut {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub target: String,
    pub description: String,
    pub pinned: bool,
    #[serde(default)]
    pub deleted: bool,
}

#[derive(Clone, Serialize, Deserialize)]
struct Config {
    version: u32,
    categories: Vec<String>,
    shortcuts: Vec<Shortcut>,
}
impl Default for Config {
    fn default() -> Self {
        Self { version: 1, categories: vec!["工作".into(), "学习".into(), "日常".into()], shortcuts: vec![] }
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Month {
    version: u32,
    tasks: Vec<Task>,
}
impl Default for Month {
    fn default() -> Self { Self { version: 1, tasks: vec![] } }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingMove {
    version: u32,
    from_month: String,
    task: Task,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskInput {
    id: Option<String>,
    original_date: Option<String>,
    title: String,
    date: String,
    #[serde(default)]
    time: String,
    category: String,
    #[serde(default)]
    important: bool,
    #[serde(default)]
    note: String,
    shortcut_ids: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ShortcutInput {
    id: Option<String>,
    title: String,
    kind: String,
    target: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    pinned: bool,
}

pub enum OpenTarget { Url(String), File(String) }

pub fn require_panel(label: &str) -> Result<(), String> {
    if label == "panel" { Ok(()) } else { Err("工作台只允许主面板操作".into()) }
}

fn parse<T: DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|_| "工作台请求参数无效".into())
}
fn text(value: &str, max: usize, label: &str, required: bool) -> Result<String, String> {
    let value = value.trim();
    if (required && value.is_empty()) || value.chars().count() > max || value.contains('\0') {
        return Err(format!("{label}需要{}至 {max} 个字", if required { 1 } else { 0 }));
    }
    Ok(value.into())
}
fn date(value: &str) -> Result<NaiveDate, String> {
    let parsed = NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| "日期无效")?;
    if parsed.year() < 1 || parsed.year() > 9999 || parsed.format("%Y-%m-%d").to_string() != value {
        return Err("日期无效".into());
    }
    Ok(parsed)
}
fn month_key(value: &str) -> Result<String, String> { Ok(date(value)?.format("%Y-%m").to_string()) }
fn valid_month(value: &str) -> Result<(), String> {
    if value.len() != 7 { return Err("月份无效".into()); }
    date(&format!("{value}-01"))?;
    Ok(())
}
fn id(value: &str) -> Result<(), String> {
    Uuid::parse_str(value).map(|_| ()).map_err(|_| "记录标识无效".into())
}
fn validate_task(task: &Task) -> Result<(), String> {
    id(&task.id)?;
    date(&task.date)?;
    text(&task.title, 120, "待办名称", true)?;
    text(&task.category, 30, "分类", true)?;
    text(&task.note, 3000, "备注", false)?;
    if task.shortcut_ids.len() > 20 { return Err("每条待办最多关联 20 个知识入口".into()); }
    let mut shortcuts = HashSet::new();
    for key in &task.shortcut_ids {
        id(key)?;
        if !shortcuts.insert(key) { return Err("关联知识入口重复".into()); }
    }
    if !task.time.is_empty() {
        let parsed = NaiveTime::parse_from_str(&task.time, "%H:%M").map_err(|_| "时间应为 00:00 至 23:59")?;
        if parsed.format("%H:%M").to_string() != task.time { return Err("时间应为 HH:mm".into()); }
    }
    for value in [&task.created_at, &task.updated_at] {
        chrono::DateTime::parse_from_rfc3339(value).map_err(|_| "待办记录时间无效")?;
    }
    if let Some(value) = &task.completed_at { chrono::DateTime::parse_from_rfc3339(value).map_err(|_| "完成时间无效")?; }
    if task.done != task.completed_at.is_some() { return Err("完成状态和记录时间不一致".into()); }
    Ok(())
}
fn validate_month(value: &Month, key: &str) -> Result<(), String> {
    valid_month(key)?;
    if value.version != 1 { return Err("不支持的待办文件版本".into()); }
    let mut ids = HashSet::new();
    for task in &value.tasks {
        validate_task(task)?;
        if month_key(&task.date)? != key || !ids.insert(&task.id) { return Err("待办月份或标识重复".into()); }
    }
    Ok(())
}
fn validate_config(value: &Config) -> Result<(), String> {
    if value.version != 1 { return Err("不支持的工作台配置版本".into()); }
    let mut categories = HashSet::new();
    for category in &value.categories {
        let normalized = text(category, 30, "分类", true)?;
        if normalized != *category || !categories.insert(normalized.to_ascii_lowercase()) { return Err("分类重复或格式无效".into()); }
    }
    let mut ids = HashSet::new();
    for item in &value.shortcuts {
        id(&item.id)?;
        text(&item.title, 60, "入口名称", true)?;
        text(&item.description, 100, "说明", false)?;
        validate_target(&item.kind, &item.target)?;
        if !ids.insert(&item.id) { return Err("知识入口标识重复".into()); }
    }
    Ok(())
}
fn validate_move(value: &PendingMove) -> Result<(), String> {
    valid_month(&value.from_month)?;
    validate_task(&value.task)?;
    if value.version != 1 || month_key(&value.task.date)? == value.from_month { return Err("跨月恢复记录无效".into()); }
    Ok(())
}

fn replace_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("保存位置无效")?).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    let mut file = fs::File::create(&temp).map_err(|e| e.to_string())?;
    file.write_all(bytes).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
    drop(file);
    crate::model::replace_file(&temp, path)
}
fn write_doc<T: Serialize + DeserializeOwned>(path: &Path, value: &T, validate: impl Fn(&T) -> Result<(), String>) -> Result<(), String> {
    validate(value)?;
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    if path.try_exists().map_err(|e| format!("无法检查保存位置：{e}"))? {
        let old = fs::read(path).map_err(|e| e.to_string())?;
        let parsed = serde_json::from_slice::<T>(&old).map_err(|_| "原文件损坏，请先恢复后再保存")?;
        validate(&parsed)?;
        fs::copy(path, path.with_extension("json.bak")).map_err(|e| e.to_string())?;
    }
    replace_bytes(path, &bytes)
}
fn read_doc<T: DeserializeOwned>(path: &Path, validate: impl Fn(&T) -> Result<(), String>) -> Result<(Option<T>, Option<String>), String> {
    if !path.try_exists().map_err(|e| format!("无法检查工作台文件：{e}"))? { return Ok((None, None)); }
    let decode = |bytes: &[u8]| -> Result<T, String> {
        let value = serde_json::from_slice::<T>(bytes).map_err(|_| "JSON 格式无效")?;
        validate(&value)?;
        Ok(value)
    };
    let bytes = fs::read(path).map_err(|e| format!("无法读取工作台文件：{e}"))?;
    if let Ok(value) = decode(&bytes) { return Ok((Some(value), None)); }
    let backup = fs::read(path.with_extension("json.bak")).map_err(|_| "工作台数据损坏且没有可用备份，请保留原文件后手动恢复")?;
    let value = decode(&backup).map_err(|_| "工作台数据及备份均损坏，请保留文件后手动恢复")?;
    let preserved = path.with_extension(format!("corrupt-{}.json", Uuid::new_v4()));
    fs::copy(path, preserved).map_err(|e| format!("无法保留损坏文件：{e}"))?;
    replace_bytes(path, &backup)?;
    Ok((Some(value), Some(format!("{} 已从备份恢复，损坏原件已保留", path.file_name().unwrap_or_default().to_string_lossy()))))
}

pub struct Store {
    dir: PathBuf,
    warnings: Vec<String>,
}
impl Store {
    pub fn new(dir: PathBuf) -> Self { Self { dir, warnings: vec![] } }
    fn config(&mut self) -> Result<Config, String> {
        let (value, warning) = read_doc(&self.dir.join("settings.json"), validate_config)?;
        self.warnings.extend(warning);
        Ok(value.unwrap_or_default())
    }
    fn save_config(&self, value: &Config) -> Result<(), String> { write_doc(&self.dir.join("settings.json"), value, validate_config) }
    fn month_path(&self, key: &str) -> PathBuf { self.dir.join("tasks").join(format!("{key}.json")) }
    fn month(&mut self, key: &str) -> Result<Month, String> {
        valid_month(key)?;
        let (value, warning) = read_doc(&self.month_path(key), |value| validate_month(value, key))?;
        self.warnings.extend(warning);
        Ok(value.unwrap_or_default())
    }
    fn save_month(&self, key: &str, value: &Month) -> Result<(), String> { write_doc(&self.month_path(key), value, |value| validate_month(value, key)) }
    fn recover_move(&mut self) -> Result<(), String> {
        let path = self.dir.join("pending-move.json");
        let (pending, warning) = read_doc::<PendingMove>(&path, validate_move)?;
        self.warnings.extend(warning);
        let Some(pending) = pending else { return Ok(()); };
        let target_key = month_key(&pending.task.date)?;
        let mut target = self.month(&target_key)?;
        target.tasks.retain(|task| task.id != pending.task.id);
        target.tasks.push(pending.task.clone());
        self.save_month(&target_key, &target)?;
        let mut source = self.month(&pending.from_month)?;
        source.tasks.retain(|task| task.id != pending.task.id);
        self.save_month(&pending.from_month, &source)?;
        // A later backup recovery must not resurrect the task in its old month.
        // The durable intent stays present until both post-move backups are ready.
        for key in [&target_key, &pending.from_month] {
            let file = self.month_path(key);
            fs::copy(&file, file.with_extension("json.bak")).map_err(|e| e.to_string())?;
        }
        fs::remove_file(path).map_err(|e| format!("跨月数据已写入，但恢复记录清理失败：{e}"))?;
        Ok(())
    }
    fn snapshot(&mut self, day: &str) -> Result<Value, String> {
        let key = month_key(day)?;
        let config = self.config()?;
        let month = self.month(&key)?;
        let today = Local::now().format("%Y-%m-%d").to_string();
        let today_key = month_key(&today)?;
        let current = if key == today_key { month.clone() } else { self.month(&today_key)? };
        let current: Vec<_> = current.tasks.iter().filter(|task| task.date == today && !task.deleted).collect();
        Ok(json!({
            "month":key, "tasks":month.tasks.into_iter().filter(|task| !task.deleted).collect::<Vec<_>>(),
            "categories":config.categories, "shortcuts":config.shortcuts.into_iter().filter(|item| !item.deleted).collect::<Vec<_>>(),
            "today":{"date":today,"total":current.len(),"done":current.iter().filter(|task| task.done).count()},
            "warnings":std::mem::take(&mut self.warnings)
        }))
    }
    fn knowledge(&mut self) -> Result<Value, String> {
        let config = self.config()?;
        Ok(json!({"categories":config.categories,
            "shortcuts":config.shortcuts.into_iter().filter(|item| !item.deleted).collect::<Vec<_>>(),
            "warnings":std::mem::take(&mut self.warnings)}))
    }
    fn save_task(&mut self, input: TaskInput) -> Result<Task, String> {
        let key = month_key(&input.date)?;
        let now = Utc::now().to_rfc3339();
        let old_key = input.original_date.as_deref().map(month_key).transpose()?;
        let old = if let Some(task_id) = &input.id {
            id(task_id)?;
            let source = self.month(old_key.as_deref().ok_or("编辑待办需要原安排日期")?)?;
            Some(source.tasks.into_iter().find(|task| task.id == *task_id && Some(task.date.as_str()) == input.original_date.as_deref() && !task.deleted).ok_or("待办已变化，请重新加载")?)
        } else { None };
        let mut task = Task {
            id: old.as_ref().map(|task| task.id.clone()).unwrap_or_else(|| Uuid::new_v4().to_string()),
            title: text(&input.title, 120, "待办名称", true)?, date: input.date, time: input.time.trim().into(),
            category: text(&input.category, 30, "分类", true)?, important: input.important,
            note: text(&input.note, 3000, "备注", false)?, done: old.as_ref().is_some_and(|task| task.done),
            shortcut_ids: input.shortcut_ids.unwrap_or_else(|| old.as_ref().map(|task| task.shortcut_ids.clone()).unwrap_or_default()),
            created_at: old.as_ref().map(|task| task.created_at.clone()).unwrap_or_else(|| now.clone()), updated_at: now,
            completed_at: old.as_ref().and_then(|task| task.completed_at.clone()), deleted: false,
        };
        validate_task(&task)?;
        let mut config = self.config()?;
        for key in &task.shortcut_ids {
            let retained = old.as_ref().is_some_and(|task| task.shortcut_ids.contains(key));
            if !retained && !config.shortcuts.iter().any(|item| item.id == *key && !item.deleted) {
                return Err("所选知识入口不存在或已移除，请重新选择".into());
            }
        }
        if let Some(category) = config.categories.iter().find(|value| value.eq_ignore_ascii_case(&task.category)) { task.category = category.clone(); }
        else { config.categories.push(task.category.clone()); self.save_config(&config)?; }
        if let Some(old_key) = old_key.filter(|old_key| old.is_some() && *old_key != key) {
            let pending = PendingMove {version: 1, from_month: old_key, task: task.clone()};
            write_doc(&self.dir.join("pending-move.json"), &pending, validate_move)?;
            self.recover_move()?;
        } else {
            let mut month = self.month(&key)?;
            month.tasks.retain(|value| value.id != task.id);
            month.tasks.push(task.clone());
            self.save_month(&key, &month)?;
        }
        Ok(task)
    }
    fn task_action(&mut self, input: &Value) -> Result<Task, String> {
        let task_id = input["id"].as_str().ok_or("缺少待办标识")?;
        let day = input["date"].as_str().ok_or("缺少安排日期")?;
        let key = month_key(day)?;
        let mut month = self.month(&key)?;
        let task = month.tasks.iter_mut().find(|task| task.id == task_id && task.date == day).ok_or("待办不存在，请重新加载")?;
        let action = input["action"].as_str().unwrap_or("");
        if task.deleted && !["restore", "remove"].contains(&action) { return Err("待办已移除，请重新加载".into()); }
        match action {
            "complete" => { if !task.done { task.completed_at = Some(Utc::now().to_rfc3339()); } task.done = true; }
            "reopen" => { task.done = false; task.completed_at = None; }
            "remove" => task.deleted = true,
            "restore" => task.deleted = false,
            _ => return Err("待办操作无效".into()),
        }
        task.updated_at = Utc::now().to_rfc3339();
        let result = task.clone();
        self.save_month(&key, &month)?;
        Ok(result)
    }
    fn save_shortcut(&mut self, input: ShortcutInput) -> Result<Shortcut, String> {
        let mut config = self.config()?;
        let old = input.id.as_ref().map(|key| config.shortcuts.iter().position(|item| item.id == *key && !item.deleted).ok_or("知识入口已变化，请重新加载")).transpose()?;
        let item = Shortcut {
            id: input.id.unwrap_or_else(|| Uuid::new_v4().to_string()), title: text(&input.title, 60, "入口名称", true)?,
            kind: input.kind, target: text(&input.target, 2000, "入口位置", true)?,
            description: text(&input.description, 100, "说明", false)?, pinned: input.pinned, deleted: false,
        };
        validate_target(&item.kind, &item.target)?;
        if let Some(index) = old { config.shortcuts[index] = item.clone(); } else { config.shortcuts.push(item.clone()); }
        self.save_config(&config)?;
        Ok(item)
    }
    fn shortcut_action(&mut self, input: &Value) -> Result<Value, String> {
        let mut config = self.config()?;
        let key = input["id"].as_str().ok_or("缺少入口标识")?;
        let item = config.shortcuts.iter_mut().find(|item| item.id == key).ok_or("知识入口不存在")?;
        match input["action"].as_str().unwrap_or("") {
            "pin" if !item.deleted => item.pinned = !item.pinned,
            "remove" => item.deleted = true,
            "restore" => item.deleted = false,
            _ => return Err("知识入口操作无效".into()),
        }
        self.save_config(&config)?;
        Ok(Value::Null)
    }
    pub fn open_target(&mut self, key: &str) -> Result<OpenTarget, String> {
        let config = self.config()?;
        let item = config.shortcuts.into_iter().find(|item| item.id == key && !item.deleted).ok_or("知识入口不存在")?;
        let target = validate_target(&item.kind, &item.target)?;
        if item.kind == "file" {
            let metadata = fs::metadata(&target).map_err(|_| "资料位置不存在或无权访问，请编辑入口检查路径")?;
            if !metadata.is_dir() {
                let extension = Path::new(&target).extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
                if !["md", "txt", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv", "json", "yaml", "yml", "png", "jpg", "jpeg", "webp", "svg", "html", "htm"].contains(&extension.as_str()) {
                    return Err("只支持打开资料文档、图片和文件夹".into());
                }
            }
            Ok(OpenTarget::File(target))
        } else { Ok(OpenTarget::Url(target)) }
    }
    pub fn call(&mut self, channel: &str, input: Value) -> Result<Value, String> {
        if ["workbench-load", "workbench-save-task", "workbench-task-action"].contains(&channel) { self.recover_move()?; }
        match channel {
            "workbench-load" => self.snapshot(input["date"].as_str().ok_or("缺少查看日期")?),
            "workbench-load-knowledge" => self.knowledge(),
            "workbench-save-task" => Ok(json!(self.save_task(parse(input)?)?)),
            "workbench-task-action" => Ok(json!(self.task_action(&input)?)),
            "workbench-save-shortcut" => Ok(json!(self.save_shortcut(parse(input)?)?)),
            "workbench-shortcut-action" => self.shortcut_action(&input),
            _ => Err("未知工作台请求".into()),
        }
    }
}

fn encode_component(value: &str) -> String {
    let mut result = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) { result.push(byte as char); }
        else { result.push_str(&format!("%{byte:02X}")); }
    }
    result
}
fn absolute_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    (bytes.len() > 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && [b'/', b'\\'].contains(&bytes[2])) ||
        value.starts_with("\\\\") || Path::new(value).is_absolute()
}
pub fn validate_target(kind: &str, value: &str) -> Result<String, String> {
    let value = text(value, 2000, "入口位置", true)?;
    if kind == "file" {
        if !absolute_path(&value) || value.starts_with("\\\\.\\") || value.starts_with("\\\\?\\") { return Err("请填写文件或文件夹的完整路径".into()); }
        return Ok(value);
    }
    if kind == "obsidian" && absolute_path(&value) && value.to_ascii_lowercase().ends_with(".md") {
        return Ok(format!("obsidian://open?path={}", encode_component(&value)));
    }
    let url = reqwest::Url::parse(&value).map_err(|_| "入口地址格式无效")?;
    if !url.username().is_empty() || url.password().is_some() { return Err("入口地址不能包含账号密码".into()); }
    if kind == "web" && ["http", "https"].contains(&url.scheme()) && url.host_str().is_some() { return Ok(url.into()); }
    if kind != "obsidian" || url.scheme() != "obsidian" || url.port().is_some() || url.fragment().is_some() || !["", "/"].contains(&url.path()) { return Err("只支持 Obsidian 打开/搜索或 HTTP(S) 网页".into()); }
    let allowed: &[&str] = match url.host_str().unwrap_or("") {
        "open" => &["vault", "file", "path", "paneType"],
        "search" => &["vault", "query"],
        _ => return Err("只支持打开和搜索，不支持创建或修改笔记".into()),
    };
    let pairs: Vec<_> = url.query_pairs().collect();
    let mut keys = HashSet::new();
    if pairs.iter().any(|(key, _)| !allowed.contains(&key.as_ref()) || !keys.insert(key.as_ref())) ||
        !pairs.iter().any(|(key, value)| ["vault", "path"].contains(&key.as_ref()) && !value.trim().is_empty()) {
        return Err("Obsidian 链接需要知识库或笔记位置，且不能包含写入操作".into());
    }
    Ok(url.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct TestDir(PathBuf);
    impl TestDir {
        fn root() -> PathBuf { PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("artifacts") }
        fn new() -> Self { Self(Self::root().join(format!("workbench-test-{}", Uuid::new_v4()))) }
        fn store(&self) -> Store { Store::new(self.0.clone()) }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            if self.0.parent() == Some(Self::root().as_path()) && self.0.file_name().unwrap_or_default().to_string_lossy().starts_with("workbench-test-") {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
    }
    fn input(day: &str, category: &str) -> Value {
        json!({"title":"测试事项", "date":day, "time":"09:30", "category":category, "important":true, "note":"测试备注"})
    }
    fn save(store: &mut Store, day: &str) -> Task { serde_json::from_value(store.call("workbench-save-task", input(day, "工作")).unwrap()).unwrap() }
    fn shortcut(store: &mut Store) -> String {
        store.call("workbench-save-shortcut", json!({"title":"测试笔记", "kind":"obsidian", "target":"obsidian://open?vault=Test"})).unwrap()["id"].as_str().unwrap().to_owned()
    }

    #[test]
    fn fresh_load_is_empty_and_does_not_create_data() {
        let dir = TestDir::new();
        let result = dir.store().call("workbench-load", json!({"date":"2026-10-28"})).unwrap();
        assert_eq!(result["tasks"], json!([]));
        assert_eq!(result["shortcuts"], json!([]));
        assert!(!dir.0.exists());
    }
    #[test]
    fn tasks_are_partitioned_by_month_and_survive_reload() {
        let dir = TestDir::new(); let mut store = dir.store();
        save(&mut store, "2026-10-31"); save(&mut store, "2026-11-01");
        for key in ["2026-10", "2026-11"] {
            assert!(store.month_path(key).exists());
            assert_eq!(dir.store().month(key).unwrap().tasks.len(), 1);
        }
        assert!(!dir.0.join("state.json").exists());
    }
    #[test]
    fn categories_can_be_added_and_normalized() {
        let dir = TestDir::new(); let mut store = dir.store();
        store.call("workbench-save-task", input("2026-10-28", "  Ops  ")).unwrap();
        let task = store.call("workbench-save-task", input("2026-10-29", "ops")).unwrap();
        assert_eq!(task["category"], "Ops");
        assert_eq!(dir.store().config().unwrap().categories.iter().filter(|value| value.eq_ignore_ascii_case("ops")).count(), 1);
    }
    #[test]
    fn moving_to_another_month_preserves_identity_and_completion() {
        let dir = TestDir::new(); let mut store = dir.store(); let task = save(&mut store, "2026-10-31");
        store.call("workbench-task-action", json!({"id":task.id,"date":task.date,"action":"complete"})).unwrap();
        let mut change = input("2026-11-02", "工作"); change["id"] = json!(task.id); change["originalDate"] = json!(task.date);
        let changed = store.call("workbench-save-task", change).unwrap();
        assert_eq!(changed["id"], task.id); assert_eq!(changed["done"], true); assert_eq!(changed["note"], task.note);
        assert!(store.month("2026-10").unwrap().tasks.is_empty()); assert_eq!(store.month("2026-11").unwrap().tasks.len(), 1);
        assert!(!dir.0.join("pending-move.json").exists());
    }
    #[test]
    fn interrupted_move_recovers_without_duplicate_or_loss() {
        let dir = TestDir::new(); let mut store = dir.store(); let key = shortcut(&mut store);
        let mut create = input("2026-10-31", "工作"); create["shortcutIds"] = json!([key]);
        let mut task: Task = serde_json::from_value(store.call("workbench-save-task", create).unwrap()).unwrap();
        task.date = "2026-11-01".into();
        let pending = PendingMove {version:1, from_month:"2026-10".into(), task:task.clone()};
        write_doc(&dir.0.join("pending-move.json"), &pending, validate_move).unwrap();
        store.save_month("2026-11", &Month {version:1, tasks:vec![task.clone()]}).unwrap();
        let snapshot = dir.store().call("workbench-load", json!({"date":"2026-11-01"})).unwrap();
        assert_eq!(snapshot["tasks"].as_array().unwrap().len(), 1); assert_eq!(snapshot["tasks"][0]["id"], task.id);
        assert_eq!(snapshot["tasks"][0]["shortcutIds"], json!([key]));
        assert!(dir.store().month("2026-10").unwrap().tasks.is_empty());
    }
    #[test]
    fn backup_recovery_after_move_does_not_resurrect_the_old_month() {
        let dir = TestDir::new(); let mut store = dir.store(); let task = save(&mut store, "2026-10-31");
        let mut change = input("2026-11-01", "工作"); change["id"] = json!(task.id); change["originalDate"] = json!(task.date);
        store.call("workbench-save-task", change).unwrap();
        for key in ["2026-10", "2026-11"] { fs::write(store.month_path(key), b"broken").unwrap(); }
        assert!(dir.store().month("2026-10").unwrap().tasks.is_empty());
        assert_eq!(dir.store().month("2026-11").unwrap().tasks.len(), 1);
    }
    #[test]
    fn remove_restore_and_reopen_are_persistent() {
        let dir = TestDir::new(); let mut store = dir.store(); let task = save(&mut store, "2026-10-28");
        for action in ["complete", "remove", "restore", "reopen"] {
            store.call("workbench-task-action", json!({"id":task.id,"date":task.date,"action":action})).unwrap();
            let saved = dir.store().month("2026-10").unwrap().tasks.remove(0);
            assert_eq!(saved.deleted, action == "remove");
            if action == "reopen" { assert!(!saved.done); assert!(saved.completed_at.is_none()); }
        }
    }
    #[test]
    fn corrupt_month_uses_backup_and_preserves_original() {
        let dir = TestDir::new(); let mut store = dir.store(); let task = save(&mut store, "2026-10-28");
        store.call("workbench-task-action", json!({"id":task.id,"date":task.date,"action":"complete"})).unwrap();
        fs::write(store.month_path("2026-10"), b"broken").unwrap();
        let result = dir.store().call("workbench-load", json!({"date":"2026-10-28"})).unwrap();
        assert_eq!(result["tasks"][0]["done"], false);
        assert!(!result["warnings"].as_array().unwrap().is_empty());
        assert!(fs::read_dir(dir.0.join("tasks")).unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().contains("corrupt-")));
    }
    #[test]
    fn unrecoverable_corruption_is_not_replaced_with_empty_data() {
        let dir = TestDir::new(); let mut store = dir.store(); save(&mut store, "2026-10-28");
        let path = store.month_path("2026-10"); fs::write(&path, b"broken").unwrap();
        assert!(store.call("workbench-load", json!({"date":"2026-10-28"})).is_err());
        assert_eq!(fs::read(path).unwrap(), b"broken");
    }
    #[test]
    fn knowledge_does_not_read_damaged_task_months_or_pending_moves() {
        let dir = TestDir::new(); let mut store = dir.store(); save(&mut store, "2026-10-28");
        fs::write(store.month_path("2026-10"), b"broken").unwrap();
        fs::write(dir.0.join("pending-move.json"), b"broken").unwrap();
        let result = store.call("workbench-load-knowledge", Value::Null).unwrap();
        assert!(result["shortcuts"].is_array());
        assert!(store.call("workbench-load", json!({"date":"2026-10-28"})).is_err());
    }
    #[test]
    fn invalid_dates_times_and_stale_edits_are_rejected() {
        let dir = TestDir::new(); let mut store = dir.store();
        assert!(store.call("workbench-save-task", input("2026-02-30", "工作")).is_err());
        let mut bad = input("2026-10-28", "工作"); bad["time"] = json!("24:00");
        assert!(store.call("workbench-save-task", bad).is_err());
        assert!(store.call("workbench-load", json!({"date":"../../state"})).is_err());
        let mut stale = input("2026-10-28", "工作"); stale["id"] = json!(Uuid::new_v4().to_string()); stale["originalDate"] = json!("2026-10-27");
        assert!(store.call("workbench-save-task", stale).is_err());
    }
    #[test]
    fn shortcuts_persist_pin_remove_and_restore() {
        let dir = TestDir::new(); let mut store = dir.store();
        let item = store.call("workbench-save-shortcut", json!({"title":"工作笔记", "kind":"obsidian", "target":"obsidian://open?vault=Work", "pinned":true})).unwrap();
        for action in ["pin", "remove", "restore"] { store.call("workbench-shortcut-action", json!({"id":item["id"],"action":action})).unwrap(); }
        let item = dir.store().config().unwrap().shortcuts.remove(0); assert!(!item.deleted); assert!(!item.pinned);
        assert!(matches!(dir.store().open_target(&item.id).unwrap(), OpenTarget::Url(_)));
    }
    #[test]
    fn legacy_tasks_default_to_no_links_without_rewriting_the_month() {
        let dir = TestDir::new(); let mut store = dir.store(); let task = save(&mut store, "2026-10-31");
        let path = store.month_path("2026-10");
        let mut legacy: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        legacy["tasks"][0].as_object_mut().unwrap().remove("shortcutIds");
        let bytes = serde_json::to_vec(&legacy).unwrap(); fs::write(&path, &bytes).unwrap();
        assert!(dir.store().month("2026-10").unwrap().tasks[0].shortcut_ids.is_empty());
        assert_eq!(fs::read(&path).unwrap(), bytes);
        let mut change = input("2026-11-01", "工作"); change["id"] = json!(task.id); change["originalDate"] = json!(task.date);
        assert_eq!(store.call("workbench-save-task", change).unwrap()["shortcutIds"], json!([]));
    }
    #[test]
    fn task_links_survive_old_client_edits_actions_cross_month_and_backup_recovery() {
        let dir = TestDir::new(); let mut store = dir.store(); let key = shortcut(&mut store);
        let mut create = input("2026-10-31", "工作"); create["shortcutIds"] = json!([key]);
        let task = store.call("workbench-save-task", create).unwrap();
        let mut edit = input("2026-11-01", "工作"); edit["id"] = task["id"].clone(); edit["originalDate"] = task["date"].clone();
        let moved = store.call("workbench-save-task", edit).unwrap();
        assert_eq!(moved["shortcutIds"], json!([key]));
        for action in ["complete", "reopen", "remove", "restore"] {
            assert_eq!(store.call("workbench-task-action", json!({"id":moved["id"],"date":moved["date"],"action":action})).unwrap()["shortcutIds"], json!([key]));
        }
        fs::write(store.month_path("2026-11"), b"broken").unwrap();
        assert_eq!(dir.store().month("2026-11").unwrap().tasks[0].shortcut_ids, vec![key]);
        assert!(dir.store().month("2026-10").unwrap().tasks.is_empty());
    }
    #[test]
    fn unknown_duplicate_removed_and_oversized_new_links_are_rejected_without_task_writes() {
        let dir = TestDir::new(); let mut store = dir.store(); let key = shortcut(&mut store);
        let before = fs::read(dir.0.join("settings.json")).unwrap();
        for links in [json!([Uuid::new_v4().to_string()]), json!([key, key]), json!(["../invalid"]), json!(vec![key.clone();21])] {
            let mut bad = input("2026-10-31", "不应新增的分类"); bad["shortcutIds"] = links;
            assert!(store.call("workbench-save-task", bad).is_err());
        }
        assert!(!store.month_path("2026-10").exists());
        assert_eq!(fs::read(dir.0.join("settings.json")).unwrap(), before);
        store.call("workbench-shortcut-action", json!({"id":key,"action":"remove"})).unwrap();
        let mut bad = input("2026-10-31", "工作"); bad["shortcutIds"] = json!([key]);
        assert!(store.call("workbench-save-task", bad).is_err());
        assert!(store.open_target(&key).is_err());
    }
    #[test]
    fn removed_entry_does_not_block_edits_and_links_can_be_explicitly_cleared() {
        let dir = TestDir::new(); let mut store = dir.store(); let key = shortcut(&mut store);
        let mut create = input("2026-10-31", "工作"); create["shortcutIds"] = json!([key]);
        let task = store.call("workbench-save-task", create).unwrap();
        store.call("workbench-shortcut-action", json!({"id":key,"action":"remove"})).unwrap();
        let mut edit = input("2026-10-31", "工作"); edit["id"] = task["id"].clone(); edit["originalDate"] = task["date"].clone(); edit["shortcutIds"] = json!([key]);
        assert_eq!(store.call("workbench-save-task", edit.clone()).unwrap()["shortcutIds"], json!([key]));
        edit["shortcutIds"] = json!([]);
        assert_eq!(store.call("workbench-save-task", edit.clone()).unwrap()["shortcutIds"], json!([]));
        edit["shortcutIds"] = json!([key]);
        assert!(store.call("workbench-save-task", edit.clone()).is_err());
        store.call("workbench-shortcut-action", json!({"id":key,"action":"restore"})).unwrap();
        assert_eq!(store.call("workbench-save-task", edit).unwrap()["shortcutIds"], json!([key]));
    }
    #[test]
    fn only_panel_is_authorized() {
        assert!(require_panel("panel").is_ok());
        for label in ["pet", "pet-2", "pet-3", "toy", "maskdesk"] { assert!(require_panel(label).is_err()); }
    }
    #[test]
    fn knowledge_urls_encode_paths_and_reject_write_or_executable_schemes() {
        let path = "D:\\knowledge\\Personal\\中文 & 笔记.md";
        let url = reqwest::Url::parse(&validate_target("obsidian", path).unwrap()).unwrap();
        assert_eq!(url.query_pairs().find(|(key, _)| key == "path").unwrap().1, path);
        for value in ["obsidian://new?vault=Work&name=test", "obsidian://open?vault=Work&append=x", "obsidian://open?file=test", "javascript:alert(1)"] { assert!(validate_target("obsidian", value).is_err()); }
        assert!(validate_target("web", "file:///C:/x.exe").is_err());
        assert!(validate_target("web", "https://user:secret@example.com").is_err());
        assert!(validate_target("file", "relative/path").is_err());
    }
}
