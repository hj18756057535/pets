#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

mod model;
mod memory;
mod interaction;
mod pets;
mod masking;
mod pii;
mod recovery;
mod maskdesk;
mod mask_documents;
mod keyword_library;

use chrono::{ DateTime, Duration, Utc };
use model::{ EyeBreak, Point, Store };
use pets::Pet;
use serde_json::{ json, Value };
use std::{ fs, path::PathBuf, sync::Mutex, time::{ Duration as StdDuration, Instant } };
use tauri::{ Emitter, Manager, WebviewWindow, WebviewWindowBuilder, WebviewUrl };
use tauri::menu::MenuBuilder;
use tauri::tray::TrayIconBuilder;
use tauri_plugin_global_shortcut::{ GlobalShortcutExt, ShortcutState };
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

static LOG_PATH: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

fn startup_stage(stage: &str) {
    use std::io::Write;
    if let Some(path) = LOG_PATH.get() {
        if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "{} {stage}", Utc::now().to_rfc3339());
        }
    }
    if cfg!(debug_assertions) { eprintln!("PetDesk startup: {stage}"); }
}

fn smoke_script() -> &'static str {
    #[cfg(debug_assertions)]
    if std::env::var("PETDESK_SMOKE").as_deref() == Ok("1")
        && std::env::var_os("PETDESK_DATA_DIR").is_some() {
        return include_str!("../../tools/tauri-smoke-page.js");
    }
    ""
}

#[derive(Clone)]
struct Area {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}
struct Drag {
    cursor: Point,
    anchor: Point,
    time: Instant,
}
struct PetMenu(tauri::menu::Menu<tauri::Wry>);
struct Backend {
    store: Store,
    pet: Option<Pet>,
    pending: Option<(String, Pet)>,
    import_generation: u64,
    monitor_signature: String,
    eye: EyeBreak,
    warning: String,
    tab: String,
    panel_ready: bool,
    pending_import: bool,
    hidden: bool,
    layout: Value,
    ignore_mouse: bool,
    menu_open: bool,
    drag: Option<Drag>,
    interaction: Option<interaction::Interaction>,
}
impl Backend {
    fn payload(&self, pet_visible: bool) -> Value {
        let mut value = serde_json::to_value(&self.store.state).unwrap_or(json!({}));
        let object = value.as_object_mut().unwrap();
        object.insert("interaction".into(), json!(self.interaction.as_ref().map(|s| &s.mode)));
        object.insert("petLayout".into(), self.layout.clone());
        object.insert("eyeReminder".into(), json!(self.eye.pending));
        object.insert(
            "warning".into(),
            json!(if self.warning.is_empty() { &self.store.warning } else { &self.warning })
        );
        object.insert(
            "pet".into(),
            self.pet
                .as_ref()
                .map(|p| json!({"name":p.name,"description":p.description,"version":p.version}))
                .unwrap_or(Value::Null)
        );
        object.insert("petVisible".into(), json!(pet_visible));
        object.insert("version".into(), json!(env!("CARGO_PKG_VERSION")));
        value
    }
}

fn area(app: &tauri::AppHandle, point: Option<Point>) -> Area {
    let monitors = app.available_monitors().unwrap_or_default();
    let primary = app.primary_monitor().ok().flatten();
    let monitor = point
        .and_then(|p|
            monitors
                .iter()
                .find(|m| {
                    let s = m.scale_factor();
                    let pos = m.position();
                    let size = m.size();
                    let x = (pos.x as f64) / s;
                    let y = (pos.y as f64) / s;
                    p.x >= x &&
                        p.x < x + (size.width as f64) / s &&
                        p.y >= y &&
                        p.y < y + (size.height as f64) / s
                })
                .cloned()
        )
        .or(primary)
        .or_else(|| monitors.first().cloned());
    monitor
        .map(|m| {
            let (x, y, width, height) = work_area(&m);
            Area {
                x,
                y,
                width,
                height,
            }
        })
        .unwrap_or(Area { x: 0.0, y: 0.0, width: 1280.0, height: 720.0 })
}
fn work_area(m: &tauri::Monitor) -> (f64, f64, f64, f64) {
    let s = m.scale_factor();
    let rect = m.work_area();
    (
        (rect.position.x as f64) / s,
        (rect.position.y as f64) / s,
        (rect.size.width as f64) / s,
        (rect.size.height as f64) / s,
    )
}
fn monitor_signature(app: &tauri::AppHandle) -> String {
    serde_json::to_string(&app.available_monitors().unwrap_or_default()).unwrap_or_default()
}
fn cursor(app: &tauri::AppHandle, window: &WebviewWindow) -> Point {
    let p = app.cursor_position().unwrap_or(tauri::PhysicalPosition::new(0.0, 0.0));
    let s = window.scale_factor().unwrap_or(1.0);
    Point { x: p.x / s, y: p.y / s }
}
fn window_point(window: &WebviewWindow) -> Point {
    let s = window.scale_factor().unwrap_or(1.0);
    window
        .outer_position()
        .map(|p| Point { x: (p.x as f64) / s, y: (p.y as f64) / s })
        .unwrap_or_default()
}
fn set_window(
    window: &WebviewWindow,
    x: f64,
    y: f64,
    width: f64,
    height: f64
) -> Result<(), String> {
    let current = window.inner_size().map_err(|e| e.to_string())?.to_logical::<f64>(window.scale_factor().unwrap_or(1.0));
    if (current.width - width).abs() > 0.5 || (current.height - height).abs() > 0.5 {
        window.set_size(tauri::LogicalSize::new(width, height)).map_err(|e| e.to_string())?;
    }
    window.set_position(tauri::LogicalPosition::new(x, y)).map_err(|e| e.to_string())
}
fn clamp(x: f64, low: f64, high: f64) -> f64 {
    x.max(low).min(high.max(low))
}
fn layout(anchor: Point, scale: f64, a: &Area) -> Value {
    let width = 144.0 * scale;
    let height = 156.0 * scale;
    let px = clamp(anchor.x, a.x, a.x + a.width - width);
    let py = clamp(anchor.y, a.y, a.y + a.height - height);
    let win_h = (390.0 + height).ceil();
    let below = py - a.y < 180.0;
    let x = (px + width / 2.0 - 320.0).round();
    let y = (py - 190.0).round();
    let bubble_left = clamp(px + width / 2.0 - 150.0, a.x, a.x + a.width - 300.0) - x;
    json!({"bounds":{"x":x,"y":y,"width":640.0,"height":win_h},"anchor":{"x":px,"y":py},"offset":{"x":320.0-width/2.0,"y":190.0},"below":below,"bubbleLeft":bubble_left})
}
fn restore(app: &tauri::AppHandle) -> Result<(), String> {
    let pet = app.get_webview_window("pet").ok_or("桌宠窗口不存在")?;
    let state = app.state::<Mutex<Backend>>();
    let saved = state.lock().unwrap().store.state.clone();
    let (x, y, width, height, next) = {
        let scale = saved.settings.scale;
        let initial = saved.position.unwrap_or_else(|| {
            let a = area(app, None);
            Point {
                x: a.x + a.width - 320.0 - 24.0,
                y: a.y + a.height - (198.0 + 156.0 * scale).ceil() - 12.0,
            }
        });
        let anchor = saved.pet_position.unwrap_or(Point {
            x: initial.x + 160.0 - 72.0 * scale,
            y: initial.y + 190.0,
        });
        let a = area(app, Some(anchor));
        let next = layout(anchor, scale, &a);
        let b = &next["bounds"];
        (
            b["x"].as_f64().unwrap(),
            b["y"].as_f64().unwrap(),
            b["width"].as_f64().unwrap(),
            b["height"].as_f64().unwrap(),
            next,
        )
    };
    set_window(&pet, x, y, width, height)?;
    state.lock().unwrap().layout = next.clone();
    if !next.is_null() {
        let _ = app.emit_to("pet", "pet-layout", next);
    }
    Ok(())
}
// Window queries can wait for the UI thread. Never hold Backend's mutex here:
// startup and tray callbacks also need that mutex on the UI thread.
fn current_payload(app: &tauri::AppHandle) -> Value {
    let visible = app
        .get_webview_window("pet")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    app.state::<Mutex<Backend>>().lock().unwrap().payload(visible)
}
fn broadcast(app: &tauri::AppHandle) {
    let payload = current_payload(app);
    let _ = app.emit_to("panel", "state", &payload);
    let _ = app.emit_to("pet", "state", &payload);
}
fn panel(app: &tauri::AppHandle, tab: &str) {
    let tab = if ["home", "reminders", "settings"].contains(&tab) { tab } else { "home" };
    app.state::<Mutex<Backend>>().lock().unwrap().tab = tab.into();
    match ensure_panel(app) {
      Ok(window) => {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = app.emit_to("panel", "tab", tab);
      }
      Err(error) => {
        app.state::<Mutex<Backend>>().lock().unwrap().warning = error.to_string();
        startup_stage(&format!("panel creation failed: {error}"));
      }
    }
}
fn ensure_panel(app: &tauri::AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(window) = app.get_webview_window("panel") { return Ok(window); }
    let data_dir = app.state::<Mutex<Backend>>().lock().unwrap().store.dir.clone();
    let a = area(app, None);
    WebviewWindowBuilder::new(app, "panel", WebviewUrl::App("index.html".into()))
        .title("PetDesk · 你的桌面小伙伴")
        .inner_size(a.width.min(1060.0), a.height.min(760.0))
        .min_inner_size(a.width.min(760.0), a.height.min(600.0))
        .data_directory(data_dir.join("webview"))
        .initialization_script(smoke_script()).visible(true).build()
}
fn ensure_toy(app: &tauri::AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window("toy") { return Ok(window); }
    let data_dir = app.state::<Mutex<Backend>>().lock().unwrap().store.dir.clone();
    WebviewWindowBuilder::new(app, "toy", WebviewUrl::App("toy.html".into()))
        .title("PetDesk · 玩具").inner_size(64.0, 64.0).min_inner_size(1.0, 1.0)
        .transparent(true).decorations(false).shadow(false).resizable(false)
        .skip_taskbar(true).always_on_top(true).visible(false)
        .data_directory(data_dir.join("webview")).build().map_err(|e| e.to_string())
}
fn show_pet(app: &tauri::AppHandle) {
    let state = app.state::<Mutex<Backend>>();
    let mut backend = state.lock().unwrap();
    backend.hidden = false;
    let has_pet = backend.pet.is_some();
    drop(backend);
    if !has_pet {
        panel(app, "home");
        return;
    }
    let _ = restore(app);
    if let Some(window) = app.get_webview_window("pet") {
        let _ = window.show();
    }
    broadcast(app);
}
fn end_drag(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("pet").ok_or("桌宠窗口不存在")?;
    let pos = window_point(&window);
    let state = app.state::<Mutex<Backend>>();
    let mut backend = state.lock().unwrap();
    if backend.drag.take().is_none() {
        return Ok(());
    };
    let offset = &backend.layout["offset"];
    let anchor = Point {
        x: backend.layout["anchor"]["x"].as_f64().unwrap_or(pos.x + offset["x"].as_f64().unwrap_or(0.0)),
        y: backend.layout["anchor"]["y"].as_f64().unwrap_or(pos.y + offset["y"].as_f64().unwrap_or(190.0)),
    };
    backend.store.update(|s| {
        s.position = Some(pos);
        s.pet_position = Some(anchor);
        Ok(())
    })?;
    drop(backend);
    restore(app)?;
    let _ = app.emit_to("pet", "drag-ended", Value::Null);
    let _ = app.emit_to("pet", "motion", json!({"moving":false,"action":"idle"}));
    broadcast(app);
    Ok(())
}

#[cfg(windows)]
fn idle_seconds() -> u64 {
    use windows_sys::Win32::{
        System::SystemInformation::GetTickCount,
        UI::Input::KeyboardAndMouse::{ GetLastInputInfo, LASTINPUTINFO },
    };
    let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    unsafe {
        if GetLastInputInfo(&mut info) != 0 {
            (GetTickCount().wrapping_sub(info.dwTime) as u64) / 1000
        } else {
            0
        }
    }
}
#[cfg(not(windows))]
fn idle_seconds() -> u64 {
    0
}

fn tick(app: &tauri::AppHandle) {
    let displays = monitor_signature(app);
    let state = app.state::<Mutex<Backend>>();
    let mut backend = state.lock().unwrap();
    let display_changed = backend.monitor_signature != displays;
    if display_changed {
        backend.monitor_signature = displays;
    }
    let settings = backend.store.state.settings.clone();
    let eye_changed = backend.eye.tick(
        settings.eye_break,
        settings.quiet,
        settings.eye_minutes,
        idle_seconds()
    );
    let due_count = backend.store.state.reminders
        .iter()
        .filter(
            |r|
                r.status == "pending" &&
                DateTime::parse_from_rfc3339(&r.due_at).is_ok_and(
                    |d| d.with_timezone(&Utc) <= Utc::now()
                )
        )
        .count();
    let mut due = Vec::new();
    if due_count > 0 {
        if
            let Err(e) = backend.store.update(|s| {
                due = model::activate_due(s)?;
                Ok(())
            })
        {
            backend.warning = format!("提醒保存失败：{e}。系统会继续重试。");
        } else {
            backend.warning.clear();
        }
    }
    let notify_eye =
        eye_changed && backend.eye.pending.is_some() && due.is_empty() && !settings.quiet;
    let eye_title = backend.eye.pending
        .as_ref()
        .and_then(|v| v["title"].as_str())
        .map(str::to_owned);
    let show =
        !due.is_empty() && !settings.quiet && !backend.hidden;
    drop(backend);
    if display_changed {
        let _ = restore(app);
    }
    if show {
        if let Some(window) = app.get_webview_window("pet") {
            let _ = window.show();
        }
    }
    if !settings.quiet && !due.is_empty() {
        let title = if due.len() > 1 {
            format!("{} 条会议提醒", due.len())
        } else {
            "小伙伴来提醒你啦".into()
        };
        let mut notification = app.notification().builder().title(title).body(due[0].title.clone());
        if settings.sound {
            notification = notification.sound("Default");
        }
        let _ = notification.show();
    }
    if notify_eye {
        if let Some(title) = eye_title {
            let mut notification = app.notification().builder().title("小伙伴喊你歇一会儿").body(title);
            if settings.sound {
                notification = notification.sound("Default");
            }
            let _ = notification.show();
        }
    }
    if eye_changed || due_count > 0 || display_changed {
        broadcast(app);
    }
}
// Keep the canvas offset and surface size fixed while moving. Re-layout only on release.
fn move_pet(app: &tauri::AppHandle, anchor: Point, scale: f64) -> Result<(), String> {
    let window = app.get_webview_window("pet").ok_or("桌宠窗口不存在")?;
    let a = area(app, Some(anchor));
    let anchor = Point { x: clamp(anchor.x, a.x, a.x + a.width - 144.0 * scale), y: clamp(anchor.y, a.y, a.y + a.height - 156.0 * scale) };
    let state = app.state::<Mutex<Backend>>();
    let mut next = state.lock().unwrap().layout.clone();
    let x = (anchor.x - next["offset"]["x"].as_f64().unwrap_or(0.0)).round();
    let y = (anchor.y - next["offset"]["y"].as_f64().unwrap_or(190.0)).round();
    window.set_position(tauri::LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
    next["anchor"] = json!(anchor);
    next["bounds"]["x"] = json!(x);
    next["bounds"]["y"] = json!(y);
    state.lock().unwrap().layout = next;
    Ok(())
}
fn heartbeat(app: &tauri::AppHandle) {
    if app.state::<Mutex<Backend>>().lock().unwrap().menu_open { return; }
    let Some(window) = app.get_webview_window("pet") else {
        return;
    };
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    let p = cursor(app, &window);
    let pos = window_point(&window);
    let state = app.state::<Mutex<Backend>>();
    let movement = {
        let backend = state.lock().unwrap();
        backend.drag
            .as_ref()
            .map(|drag| (drag.cursor, drag.anchor, drag.time, backend.store.state.settings.scale))
    };
    if let Some((start_cursor, anchor, started, scale)) = movement {
        if started.elapsed() > StdDuration::from_secs(30) {
            let _ = end_drag(app);
            return;
        }
        let next = Point {
            x: anchor.x + p.x - start_cursor.x,
            y: anchor.y + p.y - start_cursor.y,
        };
        let _ = move_pet(app, next, scale);
    } else {
        if interaction::tick(app, p) { return; }
        let _ = app.emit_to("pet", "pointer", json!({"x":p.x-pos.x,"y":p.y-pos.y}));
    }
}

#[tauri::command]
async fn petdesk_call(
    app: tauri::AppHandle,
    window: WebviewWindow,
    channel: String,
    input: Value
) -> Result<Value, String> {
    if !["pet", "panel", "toy"].contains(&window.label()) {
        return Err("不允许的请求来源".into());
    }
    if window.label() == "toy" && !["toy-place", "interaction-stop", "toy-init", "frontend-ready"].contains(&channel.as_str()) {
        return Err("不允许的请求来源".into());
    }
    let backend = app.state::<Mutex<Backend>>();
    match channel.as_str() {
        "open-maskdesk" if window.label() == "panel" || window.label() == "pet" => {
            maskdesk::launch()?;
            Ok(Value::Null)
        }
        "memory-info" | "memory-trim" if window.label() == "panel" => {
            let trim = channel == "memory-trim";
            tauri::async_runtime::spawn_blocking(move || memory::inspect(trim)).await.map_err(|e| e.to_string())?
        }
        #[cfg(debug_assertions)]
        "smoke-menu-popup" if !smoke_script().is_empty() => {
            if input == true {
                app.get_webview_window("pet").ok_or("Missing pet")?
                    .eval("document.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))")
                    .map_err(|e| e.to_string())?;
            }
            let b = backend.lock().unwrap();
            let log = fs::read_to_string(b.store.dir.join("app.log")).unwrap_or_default();
            Ok(json!({"open":b.menu_open,"opened":log.contains("context menu opened"),"closed":log.contains("context menu closed")}))
        }
        "pet-menu" if window.label() == "pet" => {
            let _ = end_drag(&app);
            backend.lock().unwrap().menu_open = true;
            let result = (|| {
                window.set_ignore_cursor_events(false)?;
                window.set_focusable(true)?;
                window.set_focus()?;
                #[cfg(all(debug_assertions, windows))]
                if !smoke_script().is_empty() {
                    let hwnd = window.hwnd()?.0 as isize;
                    std::thread::spawn(move || {
                        std::thread::sleep(StdDuration::from_millis(800));
                        #[link(name = "user32")]
                        unsafe extern "system" {
                            fn PostMessageW(hwnd: *mut std::ffi::c_void, msg: u32, w: usize, l: isize) -> i32;
                        }
                        // Dismiss only this test window's menu, without global keyboard input.
                        unsafe { PostMessageW(hwnd as *mut std::ffi::c_void, 0x001F, 0, 0); }
                    });
                }
                #[cfg(debug_assertions)]
                startup_stage("context menu opened");
                window.popup_menu(&app.state::<PetMenu>().0)
            })();
            #[cfg(debug_assertions)]
            startup_stage("context menu closed");
            let _ = window.set_focusable(false);
            backend.lock().unwrap().menu_open = false;
            // Force the next hit test to restore click-through for transparent pixels.
            backend.lock().unwrap().ignore_mouse = false;
            result.map_err(|e: tauri::Error| e.to_string())?;
            Ok(Value::Null)
        }
        #[cfg(debug_assertions)]
        "smoke-menu" if !smoke_script().is_empty() => {
            let menu = app.state::<PetMenu>();
            let action = input.as_str().ok_or("Missing action")?;
            if menu.0.get(action).is_none() { return Err("Menu item missing".into()); }
            menu_action(&app, action);
            Ok(Value::Null)
        }
        #[cfg(debug_assertions)]
        "smoke-move" if !smoke_script().is_empty() => {
            let pet = app.get_webview_window("pet").ok_or("Missing pet")?;
            let (before, scale) = { let b = backend.lock().unwrap(); (b.layout.clone(), b.store.state.settings.scale) };
            let size = pet.inner_size().map_err(|e| e.to_string())?;
            move_pet(&app, Point { x: before["anchor"]["x"].as_f64().unwrap() - 40.0, y: before["anchor"]["y"].as_f64().unwrap() - 40.0 }, scale)?;
            let after = backend.lock().unwrap().layout.clone();
            let stable = size == pet.inner_size().map_err(|e| e.to_string())? && before["offset"] == after["offset"];
            restore(&app)?;
            Ok(json!({"stable":stable,"moved":before["anchor"] != after["anchor"]}))
        }
        #[cfg(debug_assertions)]
        "smoke-toy-click" if !smoke_script().is_empty() => {
            let toy = app.get_webview_window("toy").ok_or("Missing toy window")?;
            let pos = window_point(&toy);
            let x = input["x"].as_f64().ok_or("Missing x")? - pos.x;
            let y = input["y"].as_f64().ok_or("Missing y")? - pos.y;
            toy.eval(&format!("document.dispatchEvent(new PointerEvent('pointerdown', {{button:0,clientX:{x},clientY:{y}}}))"))
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        #[cfg(debug_assertions)]
        "smoke-windows" if !smoke_script().is_empty() => Ok(json!({
            "panel":app.get_webview_window("panel").is_some(),
            "toy":app.get_webview_window("toy").is_some()
        })),
        "toy-init" => Ok(json!(backend.lock().unwrap().interaction.as_ref().map(|s| &s.mode))),
        "toy-place" if window.label() == "toy" => { interaction::place(&app, &window, &input)?; Ok(Value::Null) }
        "interaction-stop" => { interaction::stop(&app, true); Ok(Value::Null) }
        "interaction" => { interaction::start(&app, input.as_str().ok_or("互动模式无效")?)?; Ok(Value::Null) }
        "frontend-ready" => {
            startup_stage(&format!("frontend ready: {}", window.label()));
            if window.label() == "panel" {
                let mut b = backend.lock().unwrap();
                b.panel_ready = true;
                let open_import = std::mem::take(&mut b.pending_import);
                return Ok(json!({"openImport":open_import,"tab":b.tab}));
            }
            Ok(Value::Null)
        }
        #[cfg(debug_assertions)]
        "smoke-report" | "smoke-import" if !smoke_script().is_empty() => {
            let mut b = backend.lock().unwrap();
            if channel == "smoke-report" {
                fs::write(b.store.dir.join(format!("smoke-{}.json", window.label())),
                    serde_json::to_vec_pretty(&input).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
                return Ok(Value::Null);
            }
            let name = input["name"].as_str().unwrap_or("");
            if !["first", "second"].contains(&name) { return Err("Unknown smoke fixture".into()); }
            let encoded = input["image"].as_str().ok_or("Missing smoke image")?;
            if encoded.len() > 1024 * 1024 { return Err("Smoke image too large".into()); }
            let image = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded)
                .map_err(|e| e.to_string())?;
            let fixture = b.store.dir.join("fixtures").join(name);
            fs::create_dir_all(&fixture).map_err(|e| e.to_string())?;
            fs::write(fixture.join("spritesheet.webp"), image).map_err(|e| e.to_string())?;
            fs::write(fixture.join("pet.json"), json!({"displayName":format!("Smoke {name}"),"spriteVersionNumber":1,"spritesheetPath":"spritesheet.webp"}).to_string()).map_err(|e| e.to_string())?;
            let pet = pets::read_directory(&fixture)?;
            let token = uuid::Uuid::new_v4().to_string();
            let preview = pet.preview(&token);
            b.pending = Some((token, pet));
            Ok(preview)
        }
        "init" => {
            let visible = app.get_webview_window("pet")
                .and_then(|w| w.is_visible().ok()).unwrap_or(false);
            let b = backend.lock().unwrap();
            let mut value = b.payload(visible);
            value["tab"] = json!(b.tab);
            value["image"] = b.pet
                .as_ref()
                .map(|p| json!(p.image_url()))
                .unwrap_or(Value::Null);
            Ok(value)
        }
        "settings" => {
            interaction::stop(&app, true);
            let mut b = backend.lock().unwrap();
            let old = b.store.state.settings.clone();
            b.store.update(|s| {
                let Some(obj) = input.as_object() else {
                    return Err("设置格式无效".into());
                };
                for key in ["quiet", "sound", "reducedMotion", "eyeBreak"] {
                    if let Some(v) = obj.get(key) {
                        let flag = v.as_bool().ok_or("设置格式无效")?;
                        match key {
                            "quiet" => {
                                s.settings.quiet = flag;
                            }
                            "sound" => {
                                s.settings.sound = flag;
                            }
                            "reducedMotion" => {
                                s.settings.reduced_motion = flag;
                            }
                            _ => {
                                s.settings.eye_break = flag;
                            }
                        }
                    }
                }
                if let Some(v) = obj.get("scale") {
                    let scale = v.as_f64().ok_or("不支持的宠物尺寸")?;
                    if ![0.45, 0.6, 0.8, 1.0, 1.2].contains(&scale) {
                        return Err("不支持的宠物尺寸".into());
                    }
                    s.settings.scale = scale;
                }
                if let Some(v) = obj.get("eyeMinutes") {
                    let minutes = v.as_u64().ok_or("护眼提醒间隔为 5～180 分钟的整数")?;
                    if !(5..=180).contains(&minutes) {
                        return Err("护眼提醒间隔为 5～180 分钟的整数".into());
                    }
                    s.settings.eye_minutes = minutes as u32;
                }
                Ok(())
            })?;
            if
                old.eye_break != b.store.state.settings.eye_break ||
                old.eye_minutes != b.store.state.settings.eye_minutes
            {
                b.eye.reset(false);
            }
            drop(b);
            restore(&app)?;
            broadcast(&app);
            Ok(current_payload(&app))
        }
        "add-reminder" => {
            let r = model::make_reminder(&input)?;
            backend
                .lock()
                .unwrap()
                .store.update(|s| {
                    if s.reminders.len() >= 500 {
                        return Err("提醒数量已达上限，请先移除已完成记录".into());
                    }
                    s.reminders.push(r.clone());
                    Ok(())
                })?;
            broadcast(&app);
            tick(&app);
            Ok(json!(r))
        }
        "reminder-action" => {
            let action = input["action"].as_str().unwrap_or("");
            let id = input["id"].as_str().unwrap_or("");
            if !["done", "snooze", "remove", "stop-series"].contains(&action) {
                return Err("不支持的提醒操作".into());
            }
            backend
                .lock()
                .unwrap()
                .store.update(|s| {
                    let index = s.reminders
                        .iter()
                        .position(|r| r.id == id)
                        .ok_or("找不到这条提醒")?;
                    if action == "remove" {
                        s.reminders.remove(index);
                        return Ok(());
                    }
                    if action == "stop-series" {
                        if s.reminders[index].repeat.is_none() {
                            return Err("这不是固定会议".into());
                        }
                        let series = s.reminders[index].series_id.clone();
                        for r in &mut s.reminders {
                            if r.series_id == series {
                                if r.status == "pending" {
                                    r.status = "done".into();
                                }
                                r.repeat = None;
                                r.series_id = None;
                            }
                        }
                    } else if action == "done" {
                        s.reminders[index].status = "done".into();
                    } else {
                        s.reminders[index].status = "pending".into();
                        s.reminders[index].due_at = (
                            Utc::now() + Duration::minutes(5)
                        ).to_rfc3339();
                    }
                    Ok(())
                })?;
            broadcast(&app);
            Ok(current_payload(&app))
        }
        "clear-reminder-history" => {
            backend
                .lock()
                .unwrap()
                .store.update(|s| {
                    s.reminders.retain(|r| r.status != "done");
                    Ok(())
                })?;
            broadcast(&app);
            Ok(Value::Null)
        }
        "eye-break-action" => {
            let action = input["action"].as_str().unwrap_or("");
            if !["done", "snooze"].contains(&action) {
                return Err("不支持的护眼提醒操作".into());
            }
            backend
                .lock()
                .unwrap()
                .eye.reset(action == "snooze");
            broadcast(&app);
            Ok(Value::Null)
        }
        "preview-eye-break" => {
            let mut b = backend.lock().unwrap();
            if !b.store.state.settings.eye_break {
                return Err("请先开启护眼提醒".into());
            }
            b.eye.show();
            drop(b);
            broadcast(&app);
            Ok(Value::Null)
        }
        "show-panel" => {
            panel(&app, input.as_str().unwrap_or("home"));
            Ok(Value::Null)
        }
        "show-pet" => {
            interaction::stop(&app, true);
            show_pet(&app);
            Ok(Value::Null)
        }
        "hide-pet" => {
            interaction::stop(&app, true);
            backend.lock().unwrap().hidden = true;
            if let Some(w) = app.get_webview_window("pet") {
                let _ = w.hide();
            }
            broadcast(&app);
            Ok(Value::Null)
        }
        "play" => {
            let action = input.as_str().unwrap_or("");
            if !["idle", "waving", "jumping", "running", "review"].contains(&action) {
                return Err("未知动作".into());
            }
            let _ = app.emit_to("pet", "play", action);
            Ok(Value::Null)
        }
        "open-pet-website" => {
            app
                .opener()
                .open_url("https://codex-pets.net/", None::<&str>)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "import-pet" | "preview-pet-link" => {
            let generation = {
                let mut b = backend.lock().unwrap();
                b.import_generation += 1;
                b.pending = None;
                b.import_generation
            };
            let kind = input["kind"].as_str().unwrap_or("zip").to_owned();
            let raw = input["url"].as_str().unwrap_or("").to_owned();
            let is_link = channel == "preview-pet-link";
            let result = tauri::async_runtime
                ::spawn_blocking(
                    move || -> Result<Option<Pet>, String> {
                        if is_link {
                            return pets::read_shared(&raw).map(Some);
                        }
                        if kind != "folder" && kind != "zip" {
                            return Err("请选择 ZIP 或文件夹".into());
                        }
                        let choice = if kind == "folder" {
                            rfd::FileDialog
                                ::new()
                                .set_title("选择包含 pet.json 的宠物文件夹")
                                .pick_folder()
                        } else {
                            rfd::FileDialog
                                ::new()
                                .set_title("选择下载的宠物 ZIP 压缩包")
                                .add_filter("Codex 宠物压缩包", &["zip"])
                                .pick_file()
                        };
                        choice.map(|path| pets::read_local(&path, &kind)).transpose()
                    }
                ).await
                .map_err(|e| e.to_string())??;
            let mut b = backend.lock().unwrap();
            if b.import_generation != generation {
                return Err("已取消导入".into());
            }
            if let Some(pet) = result {
                let token = uuid::Uuid::new_v4().to_string();
                let preview = pet.preview(&token);
                b.pending = Some((token, pet));
                Ok(preview)
            } else {
                Ok(Value::Null)
            }
        }
        "cancel-import" => {
            let mut b = backend.lock().unwrap();
            b.import_generation += 1;
            b.pending = None;
            Ok(Value::Null)
        }
        "apply-pet" => {
            interaction::stop(&app, true);
            let mut b = backend.lock().unwrap();
            let (token, pet) = b.pending.take().ok_or("预览已失效，请重新读取宠物")?;
            if input["token"].as_str() != Some(token.as_str()) {
                b.pending = Some((token, pet));
                return Err("预览已失效，请重新读取宠物".into());
            }
            let loaded = pets::commit(&b.store.dir, &pet)?;
            let name = loaded.name.clone();
            b.pet = Some(loaded);
            b.hidden = false;
            drop(b);
            restore(&app)?;
            if let Some(w) = app.get_webview_window("pet") {
                let _ = w.reload();
                let _ = w.show();
            }
            broadcast(&app);
            Ok(json!({"name":name}))
        }
        "hit-test" => {
            if window.label() != "pet" {
                return Err("不允许的请求来源".into());
            }
            let ignore = !input.as_bool().ok_or("参数无效")?;
            let change = {
                let b = backend.lock().unwrap();
                !b.menu_open && b.drag.is_none() && ignore != b.ignore_mouse
            };
            if change {
                window.set_ignore_cursor_events(ignore).map_err(|e| e.to_string())?;
                backend.lock().unwrap().ignore_mouse = ignore;
            }
            Ok(Value::Null)
        }
        "drag-start" => {
            if window.label() != "pet" {
                return Err("不允许的请求来源".into());
            }
            interaction::stop(&app, false);
            let p = cursor(&app, &window);
            let start = window_point(&window);
            let mut b = backend.lock().unwrap();
            let begun = if b.drag.is_none() {
                let anchor = Point {
                    x: b.layout["anchor"]["x"].as_f64().unwrap_or(start.x + b.layout["offset"]["x"].as_f64().unwrap_or(0.0)),
                    y: b.layout["anchor"]["y"].as_f64().unwrap_or(start.y + b.layout["offset"]["y"].as_f64().unwrap_or(190.0)),
                };
                b.drag = Some(Drag { cursor: p, anchor, time: Instant::now() });
                true
            } else {
                false
            };
            drop(b);
            if begun {
                let _ = app.emit_to("pet", "motion", json!({"moving":true,"action":"idle"}));
                if let Err(error) = window.set_ignore_cursor_events(false) {
                    backend.lock().unwrap().drag = None;
                    return Err(error.to_string());
                }
                backend.lock().unwrap().ignore_mouse = false;
            }
            Ok(Value::Null)
        }
        "drag-end" => {
            if window.label() != "pet" {
                return Err("不允许的请求来源".into());
            }
            end_drag(&app)?;
            Ok(Value::Null)
        }
        "quit" => {
            app.exit(0);
            Ok(Value::Null)
        }
        _ => Err("未知请求".into()),
    }
}

fn menu_action(app: &tauri::AppHandle, action: &str) {
    match action {
        "maskdesk" => {
            if let Err(error) = maskdesk::launch() {
                app.state::<Mutex<Backend>>().lock().unwrap().warning = error;
                panel(app, "home");
                broadcast(app);
            }
        }
        "open" => panel(app, "home"),
        "reminders" => panel(app, "reminders"),
        "settings" | "memory" => panel(app, "settings"),
        "change-pet" => {
            let ready = {
                let state = app.state::<Mutex<Backend>>();
                let mut b = state.lock().unwrap();
                if !b.panel_ready { b.pending_import = true; }
                b.panel_ready
            };
            panel(app, "home");
            if ready { let _ = app.emit_to("panel", "open-import", Value::Null); }
        }
        "wand" | "ball" | "follow" => {
            if let Err(error) = interaction::start(app, action) {
                app.state::<Mutex<Backend>>().lock().unwrap().warning = error;
                panel(app, "home");
                broadcast(app);
            }
        }
        "waving" | "jumping" | "review" => {
            let _ = app.emit_to("pet", "play", action);
        }
        "show" => show_pet(app),
        "stop-play" => interaction::stop(app, true),
        "hide" => {
            interaction::stop(app, true);
            app.state::<Mutex<Backend>>().lock().unwrap().hidden = true;
            if let Some(w) = app.get_webview_window("pet") {
                let _ = w.hide();
            }
            broadcast(app);
        }
        "quiet" => {
            let state = app.state::<Mutex<Backend>>();
            let mut b = state.lock().unwrap();
            let _ = b.store.update(|s| {
                s.settings.quiet = !s.settings.quiet;
                Ok(())
            });
            drop(b);
            broadcast(app);
        }
        "quit" => app.exit(0),
        _ => {}
    }
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle();
    let data_dir = if cfg!(debug_assertions) {
        std::env::var_os("PETDESK_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join(".data"))
    } else {
        let portable = std::env
            ::current_exe()?
            .parent()
            .map(|p| p.join(".data"))
            .unwrap_or_else(|| PathBuf::from(".data"));
        if portable.exists() {
            portable
        } else if fs::create_dir_all(&portable).is_ok() {
            portable
        } else {
            handle.path().app_data_dir()?
        }
    };
    fs::create_dir_all(&data_dir)?;
    let _ = LOG_PATH.set(data_dir.join("app.log"));
    let store = Store::load(data_dir.clone())?;
    startup_stage("data loaded");
    let pet = pets
        ::initial(&data_dir)
        .or_else(|| {
            if cfg!(debug_assertions) {
                pets::read_directory(
                    &PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .parent()
                        .unwrap()
                        .join(".local-pets/current")
                ).ok()
            } else {
                None
            }
        });
    app.manage(
        Mutex::new(Backend {
            store,
            pet,
            pending: None,
            import_generation: 0,
            monitor_signature: monitor_signature(handle),
            eye: EyeBreak::new(),
            warning: String::new(),
            tab: "home".into(),
            panel_ready: false,
            pending_import: false,
            hidden: false,
            layout: Value::Null,
            ignore_mouse: true,
            menu_open: false,
            drag: None,
            interaction: None,
        })
    );
    startup_stage("backend ready");
    let pet_window = WebviewWindowBuilder::new(handle, "pet", WebviewUrl::App("pet.html".into()))
        .title("PetDesk")
        .inner_size(320.0, 292.0)
        .min_inner_size(1.0, 1.0)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .focusable(false)
        .data_directory(data_dir.join("webview"))
        .initialization_script(smoke_script())
        .visible(false)
        .build()?;
    startup_stage("pet window created");
    pet_window.set_ignore_cursor_events(true)?;
    let needs_panel = app.state::<Mutex<Backend>>().lock().unwrap().pet.is_none();
    if needs_panel { ensure_panel(handle)?; startup_stage("panel window created"); }
    restore(handle)?;
    startup_stage("layout restored");
    if app.state::<Mutex<Backend>>().lock().unwrap().pet.is_some() {
        let _ = pet_window.show();
    }
    let menu = MenuBuilder::new(handle)
        .text("open", "打开陪伴空间")
        .text("reminders", "添加会议提醒")
        .text("maskdesk", "本地数据脱敏")
        .text("settings", "偏好设置")
        .text("memory", "查看系统内存")
        .text("change-pet", "更换宠物")
        .separator()
        .text("wand", "逗猫棒")
        .text("ball", "放球取回")
        .text("follow", "跟随鼠标")
        .text("stop-play", "结束互动（Esc）")
        .separator()
        .text("waving", "挥挥手")
        .text("jumping", "蹦一下")
        .text("review", "陪我专注")
        .separator()
        .text("show", "显示桌宠")
        .text("hide", "暂时隐藏桌宠")
        .text("quiet", "切换免打扰")
        .separator()
        .text("quit", "退出 PetDesk")
        .build()?;
    app.manage(PetMenu(menu.clone()));
    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().ok_or("缺少程序图标")?.clone())
        .menu(&menu)
        .on_menu_event(|app, event| menu_action(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                panel(tray.app_handle(), "home");
            }
        })
        .build(handle)?;
    let _ = handle.global_shortcut().on_shortcut("Ctrl+Shift+P", |app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            panel(app, "home");
        }
    });
    let app_handle = handle.clone();
    std::thread::spawn(move || {
        let mut last_tick = Instant::now();
        loop {
            std::thread::sleep(StdDuration::from_millis(50));
            heartbeat(&app_handle);
            if last_tick.elapsed() >= StdDuration::from_secs(1) {
                tick(&app_handle);
                last_tick = Instant::now();
            }
        }
    });
    tick(handle);
    startup_stage("ready");
    Ok(())
}
fn main() {
    if std::env::args().any(|arg| arg == "--maskdesk") {
        maskdesk::run();
        return;
    }
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |error| {
        startup_stage(&format!("fatal: {error}"));
        default_hook(error);
    }));
    let builder = tauri::Builder::default();
    let builder = if smoke_script().is_empty() {
        builder.plugin(tauri_plugin_single_instance::init(|app, _, _| panel(app, "home")))
    } else { builder };
    builder
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![petdesk_call])
        .setup(setup)
        .on_window_event(|window, event| {
            if window.label() == "panel" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("PetDesk could not start");
}

#[cfg(test)]
mod window_layout_tests {
    use super::*;
    #[test]
    fn edge_placement_keeps_canvas_fixed_and_bubbles_on_screen() {
        let area = Area { x: -1920.0, y: 0.0, width: 1920.0, height: 1080.0 };
        for scale in [0.45, 0.6, 1.0, 1.2] {
            let center = layout(Point { x: -960.0, y: 400.0 }, scale, &area);
            for anchor in [Point { x: -1920.0, y: 0.0 }, Point { x: 0.0, y: 500.0 }, Point { x: -960.0, y: 1080.0 }] {
                let edge = layout(anchor, scale, &area);
                assert_eq!(center["offset"], edge["offset"]);
                assert_eq!(center["bounds"]["width"], edge["bounds"]["width"]);
                let bubble_x = edge["bounds"]["x"].as_f64().unwrap() + edge["bubbleLeft"].as_f64().unwrap();
                assert!(bubble_x >= area.x && bubble_x + 300.0 <= area.x + area.width);
            }
        }
    }
}
