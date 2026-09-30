use crate::masking::{self, ColumnRule, Keyword, Prepared, Sheet, Source};
use crate::{pii, recovery::{self, Mapping}};
use crate::{mask_documents, keyword_library::{self, Group}};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{fs, io::Read, sync::Mutex};
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[derive(Default)]
struct Session {
    source: Option<Source>, sheet: Option<Sheet>, prepared: Option<Prepared>, mappings: Vec<Mapping>,
    source_name: String, sheet_name: String, document_name: String,
    text_preview: Option<(String, String)>,
}

impl Session {
    fn remember(&mut self, mapping: Option<Mapping>) -> Result<Value, String> {
        let Some(mapping) = mapping.filter(|m| !m.entries.is_empty()) else { return Ok(Value::Null); };
        if self.mappings.len() >= 20 { return Err("当前已有 20 份映射，请先加密保存需要保留的映射，再清空会话".into()); }
        let summary = mapping.summary(); self.mappings.push(mapping); Ok(summary)
    }
    fn mapping(&self, id: &str) -> Result<&Mapping, String> {
        self.mappings.iter().find(|m| m.id == id).ok_or_else(|| "找不到这份映射，请重新选择或导入映射文件".into())
    }
}

pub fn launch() -> Result<(), String> {
    let executable = std::env::current_exe().map_err(|_| "无法定位脱敏工具")?;
    std::process::Command::new(executable).arg("--maskdesk").spawn()
        .map_err(|_| "无法启动本地脱敏工具")?;
    Ok(())
}

fn parse<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|_| "请求参数无效，请检查规则与保留数量".into())
}

fn describe(sheet: &Sheet) -> Value {
    json!({ "rows": sheet.rows.iter().take(20).collect::<Vec<_>>(), "rowCount": sheet.rows.len(), "width": sheet.width, "firstRow": sheet.first_row })
}

fn smoke_dir() -> Option<std::path::PathBuf> {
    #[cfg(debug_assertions)]
    if std::env::var("PETDESK_MASK_SMOKE").as_deref() == Ok("1") {
        return std::env::var_os("PETDESK_DATA_DIR").map(Into::into);
    }
    None
}

fn library_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = if let Some(dir) = smoke_dir() { dir }
        else { app.path().app_data_dir().map_err(|_| "无法定位本地规则目录")? };
    Ok(dir.join("keyword-groups.json"))
}

#[tauri::command]
async fn maskdesk_call(app: tauri::AppHandle, window: WebviewWindow, channel: String, input: Value) -> Result<Value, String> {
    if window.label() != "maskdesk" { return Err("不允许的请求来源".into()); }
    tauri::async_runtime::spawn_blocking(move || call(&app, &channel, input)).await
        .map_err(|_| "处理未完成，请缩小数据量后重试".to_string())?
}

fn call(app: &tauri::AppHandle, channel: &str, input: Value) -> Result<Value, String> {
    let state = app.state::<Mutex<Session>>();
    let mut session = state.lock().map_err(|_| "会话不可用，请重新打开工具")?;
    match channel {
        "rule-groups" => Ok(json!(keyword_library::load(&library_path(app)?)?)),
        "save-rule-group" => {
            #[derive(Deserialize)]
            struct Input { group: Group, overwrite: bool }
            let value: Input = parse(input)?;
            Ok(json!(keyword_library::save(&library_path(app)?, value.group, value.overwrite)?))
        }
        "open-document" => {
            let (name, text) = if smoke_dir().is_some() {
                let extension = input.as_str().filter(|v| *v == "txt").unwrap_or("docx");
                let raw = "星河科技有限公司的张小明负责新项目。";
                let bytes = if extension == "docx" { mask_documents::docx(raw)? } else { raw.as_bytes().to_vec() };
                (format!("测试合同.{extension}"), mask_documents::read(&bytes, extension)?)
            } else {
                let Some(path) = rfd::FileDialog::new().set_title("导入 Word / TXT 文字").add_filter("Word / 文本", &["docx", "txt"]).pick_file() else { return Ok(Value::Null); };
                let mut bytes = Vec::new();
                fs::File::open(&path).map_err(|_| "无法读取文档")?.take(masking::MAX_FILE as u64 + 1).read_to_end(&mut bytes).map_err(|_| "读取文档失败")?;
                let text = mask_documents::read(&bytes, path.extension().and_then(|s| s.to_str()).unwrap_or(""))?;
                (path.file_name().unwrap_or_default().to_string_lossy().into_owned(), text)
            };
            session.document_name = name.clone(); session.text_preview = None;
            Ok(json!({ "name": name, "text": text }))
        }
        "export-text" => {
            #[derive(Deserialize)]
            struct Input { id: String, extension: String }
            let value: Input = parse(input)?;
            if !["txt", "docx"].contains(&value.extension.as_str()) { return Err("请选择 TXT 或 DOCX".into()); }
            let (id, text) = session.text_preview.as_ref().ok_or("请先生成文本预览")?;
            if *id != value.id { return Err("预览已失效，请重新生成".into()); }
            let name = mask_documents::output_name(if session.document_name.is_empty() { "文本" } else { &session.document_name }, "", &value.extension);
            let path = if let Some(dir) = smoke_dir() { dir.join(&name) } else {
                let Some(path) = rfd::FileDialog::new().set_title("导出脱敏文字副本").set_file_name(&name).add_filter("脱敏文件", &[&value.extension]).save_file() else { return Ok(Value::Null); };
                path
            };
            if !path.extension().and_then(|v| v.to_str()).is_some_and(|v| v.eq_ignore_ascii_case(&value.extension)) { return Err("文件扩展名与所选格式不一致".into()); }
            let bytes = if value.extension == "docx" { mask_documents::docx(text)? } else { text.as_bytes().to_vec() };
            masking::write_new(&path, &bytes)?;
            Ok(json!({ "name": path.file_name().unwrap_or_default().to_string_lossy() }))
        }
        "text" => {
            #[derive(Deserialize)]
            struct Input { text: String, rules: Vec<Keyword>, #[serde(default)] reversible: bool }
            let value: Input = parse(input)?;
            session.text_preview = None;
            let mut response = if value.reversible {
                let (result, mapping) = recovery::text(&value.text, &value.rules)?;
                let summary = session.remember(Some(mapping))?;
                json!({ "text": result.text, "matches": result.matches, "mapping": summary })
            } else { json!(masking::replace_keywords(&value.text, &value.rules)?) };
            let id = uuid::Uuid::new_v4().to_string();
            session.text_preview = Some((id.clone(), response["text"].as_str().unwrap_or_default().to_owned()));
            response["previewId"] = json!(id);
            Ok(response)
        }
        "detect-text" => {
            let text: String = parse(input)?;
            Ok(json!(pii::text(&text)?))
        }
        "detect-sheet" => {
            let header: bool = parse(input)?;
            Ok(json!(pii::sheet(session.sheet.as_ref().ok_or("请先选择工作表")?, header)))
        }
        "mappings" => Ok(json!(session.mappings.iter().map(Mapping::summary).collect::<Vec<_>>())),
        "restore" => {
            #[derive(Deserialize)]
            struct Input { id: String, text: String }
            let value: Input = parse(input)?;
            Ok(json!(recovery::restore(&value.text, session.mapping(&value.id)?)?))
        }
        "save-mapping" => {
            #[derive(Deserialize)]
            struct Input { id: String, password: String }
            let value: Input = parse(input)?;
            let password = zeroize::Zeroizing::new(value.password);
            let mapping = session.mapping(&value.id)?;
            let bytes = recovery::encrypt(mapping, &password)?;
            let path = if let Some(dir) = smoke_dir() { dir.join("mapping.pdmap") } else {
                let Some(path) = rfd::FileDialog::new().set_title("保存加密映射 · 请勿与脱敏数据一起发送")
                    .set_file_name(format!("映射-{}.pdmap", &mapping.id[..8])).add_filter("加密映射", &["pdmap"]).save_file() else { return Ok(Value::Null); };
                path
            };
            if !path.extension().and_then(|v| v.to_str()).is_some_and(|v| v.eq_ignore_ascii_case("pdmap")) { return Err("映射文件名必须以 .pdmap 结尾".into()); }
            masking::write_new(&path, &bytes)?;
            Ok(json!({ "name": path.file_name().unwrap_or_default().to_string_lossy() }))
        }
        "load-mapping" => {
            let password: String = parse(input)?;
            let password = zeroize::Zeroizing::new(password);
            let path = if let Some(dir) = smoke_dir() { dir.join("mapping.pdmap") } else {
                let Some(path) = rfd::FileDialog::new().set_title("打开之前保存的加密映射").add_filter("加密映射", &["pdmap"]).pick_file() else { return Ok(Value::Null); };
                path
            };
            let mut bytes = Vec::new();
            fs::File::open(path).map_err(|_| "无法读取映射文件")?.take(recovery::MAX_MAP_FILE as u64 + 1).read_to_end(&mut bytes).map_err(|_| "读取映射文件失败")?;
            let mapping = recovery::decrypt(&bytes, &password)?;
            if let Some(existing) = session.mappings.iter().find(|m| m.id == mapping.id) {
                if serde_json::to_vec(existing).ok() != serde_json::to_vec(&mapping).ok() { return Err("映射编号冲突，未覆盖当前映射".into()); }
                return Ok(existing.summary());
            }
            session.remember(Some(mapping))
        }
        "open" => {
            let (source, name) = if smoke_dir().is_some() {
                let mut book = rust_xlsxwriter::Workbook::new();
                book.add_worksheet().set_name("客户").unwrap().write_string(0, 0, "姓名").unwrap().write_string(0, 1, "手机号").unwrap()
                    .write_string(1, 0, "张小明").unwrap().write_string(1, 1, "13812345678").unwrap();
                book.add_worksheet().set_name("内部资料").unwrap().write_string(0, 0, "不应导出").unwrap();
                (Source::from_bytes(book.save_to_buffer().map_err(|_| "测试数据生成失败")?, "xlsx")?, "测试客户.xlsx".to_string())
            } else {
                let Some(path) = rfd::FileDialog::new().set_title("选择需要脱敏的表格").add_filter("Excel / UTF-8 CSV", &["xlsx", "csv"]).pick_file() else { return Ok(Value::Null); };
                let file = fs::File::open(&path).map_err(|_| "无法打开文件，请检查权限")?;
                let mut bytes = Vec::new();
                file.take(masking::MAX_FILE as u64 + 1).read_to_end(&mut bytes).map_err(|_| "读取文件失败")?;
                let extension = path.extension().and_then(|v| v.to_str()).unwrap_or("");
                (Source::from_bytes(bytes, extension)?, path.file_name().unwrap_or_default().to_string_lossy().into_owned())
            };
            let sheet = source.read(0)?;
            let response = json!({ "name": name, "sheets": source.names, "sheet": describe(&sheet) });
            session.source_name = name; session.sheet_name = source.names[0].clone();
            session.source = Some(source); session.sheet = Some(sheet); session.prepared = None;
            Ok(response)
        }
        "sheet" => {
            let index: usize = parse(input)?;
            session.prepared = None;
            session.sheet = None;
            let sheet = session.source.as_ref().ok_or("请先选择文件")?.read(index)?;
            let response = describe(&sheet);
            session.sheet_name = session.source.as_ref().unwrap().names[index].clone();
            session.sheet = Some(sheet);
            Ok(response)
        }
        "preview" => {
            #[derive(Deserialize)]
            struct Input { columns: Vec<ColumnRule>, header: bool, #[serde(default)] reversible: bool }
            session.prepared = None;
            let value: Input = parse(input)?;
            let sheet = session.sheet.as_ref().ok_or("请先选择工作表")?;
            let (prepared, mapping) = if value.reversible { recovery::sheet(sheet, &value.columns, value.header)? }
                else { (masking::prepare(sheet, &value.columns, value.header)?, None) };
            let mut response = json!(prepared.preview);
            response["mapping"] = session.remember(mapping)?;
            session.prepared = Some(prepared);
            Ok(response)
        }
        "export" => {
            let id: String = parse(input)?;
            let prepared = session.prepared.as_ref().ok_or("请先生成脱敏预览")?;
            if prepared.preview.preview_id != id { return Err("预览已失效，请重新预览".into()); }
            let name = mask_documents::output_name(&session.source_name, &session.sheet_name, "xlsx");
            let path = if let Some(dir) = smoke_dir() { dir.join(&name) } else {
                let Some(path) = rfd::FileDialog::new().set_title("导出所选工作表 · 请使用新的文件名")
                    .set_file_name(&name).add_filter("Excel", &["xlsx"]).save_file() else { return Ok(Value::Null); };
                path
            };
            if !path.extension().and_then(|v| v.to_str()).is_some_and(|v| v.eq_ignore_ascii_case("xlsx")) {
                return Err("输出文件名必须以 .xlsx 结尾".into());
            }
            let bytes = masking::xlsx_bytes(&prepared.rows)?;
            masking::write_new(&path, &bytes)?;
            Ok(json!({ "name": path.file_name().unwrap_or_default().to_string_lossy() }))
        }
        "clear" => { *session = Session::default(); Ok(Value::Null) }
        "smoke-report" if smoke_dir().is_some() => {
            fs::write(smoke_dir().unwrap().join("smoke-maskdesk.json"), serde_json::to_vec(&input).map_err(|_| "测试报告编码失败")?)
                .map_err(|_| "测试报告写入失败")?;
            Ok(Value::Null)
        }
        _ => Err("未知请求".into()),
    }
}

pub fn run() {
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = "local.petdesk.maskdesk".into();
    context.config_mut().product_name = Some("PetDesk 本地脱敏".into());
    let builder = tauri::Builder::default().manage(Mutex::new(Session::default()));
    let builder = if smoke_dir().is_none() {
        builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("maskdesk") { let _ = window.unminimize(); let _ = window.show(); let _ = window.set_focus(); }
        }))
    } else { builder };
    builder.invoke_handler(tauri::generate_handler![maskdesk_call])
        .setup(|app| {
            let window = WebviewWindowBuilder::new(app, "maskdesk", WebviewUrl::App("maskdesk.html".into()))
                .title("本地脱敏 · PetDesk").inner_size(1120.0, 820.0).min_inner_size(800.0, 620.0)
                .incognito(true).center();
            #[cfg(debug_assertions)]
            let window = if smoke_dir().is_some() { window.initialization_script(include_str!("../../tools/maskdesk-smoke-page.js")) } else { window };
            window.build()?;
            Ok(())
        })
        .run(context).expect("本地脱敏工具无法启动");
}
