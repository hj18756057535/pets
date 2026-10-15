use super::*;
use serde::{Deserialize, Serialize};

const LABELS: [&str; 2] = ["pet-2", "pet-3"];
#[derive(Clone, Serialize, Deserialize)]
struct Entry {
    label: String,
    directory: String,
    position: Option<Point>,
}
struct CompanionPet {
    entry: Entry,
    pet: Pet,
    position: Point,
    drag: Option<Drag>,
    ignore_mouse: bool,
    pointer: Option<Point>,
    last_hit: Instant,
}
pub struct Companions {
    dir: PathBuf,
    pets: Vec<CompanionPet>,
}
pub fn is_companion(label: &str) -> bool { LABELS.contains(&label) }
fn valid_entries(entries: &[Entry]) -> bool {
    entries.len() <= 2 && entries.iter().enumerate().all(|(i, e)| {
        is_companion(&e.label) && !entries[..i].iter().any(|p| p.label == e.label)
            && e.directory.starts_with("pet-import-") && e.directory.len() > 11
            && e.directory[11..].bytes().all(|c| c.is_ascii_hexdigit() || c == b'-')
            && e.position.is_none_or(|p| p.x.is_finite() && p.y.is_finite())
    })
}
impl Companions {
    pub fn load(dir: PathBuf) -> Self {
        let entries = match fs::read(dir.join("companion-pets.json")) {
            Ok(bytes) => serde_json::from_slice::<Vec<Entry>>(&bytes).ok().filter(|e| valid_entries(e)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(Vec::new()),
            Err(_) => None,
        };
        if entries.is_none() { startup_stage("invalid companion pet selection; original file preserved"); }
        let pets = entries.unwrap_or_default().into_iter().filter_map(|entry| {
            let pet = pets::read_directory(&dir.join(&entry.directory)).ok()?;
            Some(CompanionPet { position: entry.position.unwrap_or_default(), entry, pet,
                drag: None, ignore_mouse: true, pointer: None, last_hit: Instant::now() })
        }).collect();
        Self { dir, pets }
    }
    fn save(&self, entries: &[Entry]) -> Result<(), String> {
        if !valid_entries(entries) { return Err("最多同时显示三只宠物".into()); }
        let temp = self.dir.join("companion-pets.json.tmp");
        fs::write(&temp, serde_json::to_vec_pretty(entries).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        model::replace_file(&temp, &self.dir.join("companion-pets.json"))
    }
    fn entries(&self) -> Vec<Entry> { self.pets.iter().map(|p| p.entry.clone()).collect() }
}
pub fn summary(app: &tauri::AppHandle) -> Value {
    json!(app.state::<Mutex<Companions>>().lock().unwrap().pets.iter()
        .map(|p| json!({"id":p.entry.label,"name":p.pet.name})).collect::<Vec<_>>())
}
fn labels(app: &tauri::AppHandle) -> Vec<String> {
    app.state::<Mutex<Companions>>().lock().unwrap().pets.iter().map(|p| p.entry.label.clone()).collect()
}
fn settings(app: &tauri::AppHandle) -> (f64, bool, bool) {
    let state = app.state::<Mutex<Backend>>();
    let b = state.lock().unwrap();
    (b.store.state.settings.scale, b.store.state.settings.reduced_motion, !b.hidden)
}
pub fn broadcast_settings(app: &tauri::AppHandle) {
    let (scale, reduced, visible) = settings(app);
    for label in labels(app) {
        let _ = app.emit_to(&label, "companion-settings", json!({"scale":scale,"reduced":reduced,"visible":visible}));
    }
}
fn ensure(app: &tauri::AppHandle, label: &str) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(label) { return Ok(window); }
    let dir = app.state::<Mutex<Companions>>().lock().unwrap().dir.clone();
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::App("companion-pet.html".into()))
        .title("PetDesk · 陪伴宠物").inner_size(144.0, 156.0).min_inner_size(1.0, 1.0)
        .transparent(true).decorations(false).shadow(false).resizable(false)
        .skip_taskbar(true).always_on_top(true).focusable(false).visible(false)
        .data_directory(dir.join("webview")).initialization_script(smoke_script()).build().map_err(|e| e.to_string())?;
    window.set_ignore_cursor_events(true).map_err(|e| e.to_string())?;
    Ok(window)
}
pub fn restore_all(app: &tauri::AppHandle) -> Result<(), String> {
    let (scale, _, visible) = settings(app);
    for label in labels(app) {
        let window = ensure(app, &label)?;
        let stored = app.state::<Mutex<Companions>>().lock().unwrap().pets.iter()
            .find(|p| p.entry.label == label).and_then(|p| p.entry.position);
        let anchor = stored.unwrap_or_else(|| {
            let a = area(app, None);
            let slot = if label == "pet-2" { 2.0 } else { 3.0 };
            Point { x: a.x + a.width - slot * (144.0 * scale + 24.0), y: a.y + a.height - 156.0 * scale - 24.0 }
        });
        let a = area(app, Some(anchor));
        let point = Point { x: clamp(anchor.x, a.x, a.x+a.width-144.0*scale), y: clamp(anchor.y, a.y, a.y+a.height-156.0*scale) };
        set_window(&window, point.x, point.y, (144.0*scale).ceil(), (156.0*scale).ceil())?;
        if let Some(p) = app.state::<Mutex<Companions>>().lock().unwrap().pets.iter_mut().find(|p| p.entry.label == label) {
            p.position = point; p.pointer = None;
        }
        memory::set_visible(&window, visible).map_err(|e| e.to_string())?;
    }
    broadcast_settings(app);
    Ok(())
}
pub fn set_visible(app: &tauri::AppHandle, visible: bool) {
    for label in labels(app) {
        if !visible { let _ = end_drag(app, &label); }
        if let Some(window) = app.get_webview_window(&label) { let _ = memory::set_visible(&window, visible); }
    }
    broadcast_settings(app);
}
pub fn apply(app: &tauri::AppHandle, label: &str, pet: &Pet) -> Result<(), String> {
    if !is_companion(label) { return Err("宠物位置无效，最多同时显示三只".into()); }
    let state = app.state::<Mutex<Companions>>();
    // Create the hidden window before committing, so a runtime failure does not
    // replace a saved selection. All slots use the same browser environment.
    let existed = app.get_webview_window(label).is_some();
    let window = ensure(app, label)?;
    let stored = (|| -> Result<(), String> {
        let mut group = state.lock().unwrap();
        let (directory, loaded) = pets::store_asset(&group.dir, pet)?;
        let existing = group.pets.iter().position(|p| p.entry.label == label);
        let position = existing.map(|i| group.pets[i].position);
        let entry = Entry { label: label.into(), directory, position };
        let mut entries = group.entries();
        if let Some(i) = existing { entries[i] = entry.clone(); } else { entries.push(entry.clone()); }
        group.save(&entries)?;
        let next = CompanionPet { entry, pet: loaded, position: position.unwrap_or_default(), drag: None,
            ignore_mouse: true, pointer: None, last_hit: Instant::now() };
        if let Some(i) = existing { group.pets[i] = next; } else { group.pets.push(next); }
        Ok(())
    })();
    if let Err(error) = stored {
        if !existed { let _ = window.destroy(); }
        return Err(error);
    }
    window.set_ignore_cursor_events(true).map_err(|e| e.to_string())?;
    restore_all(app)?;
    // A new WebView may still be on about:blank while its first navigation is
    // pending. Reloading it here would cancel navigation to the actual pet page.
    if existed { window.reload().map_err(|e| e.to_string())?; }
    Ok(())
}
pub async fn remove(app: &tauri::AppHandle, label: &str) -> Result<(), String> {
    if !is_companion(label) { return Err("只能移出陪伴宠物；主宠请使用替换".into()); }
    let state = app.state::<Mutex<Companions>>();
    {
        let mut group = state.lock().unwrap();
        let entries: Vec<_> = group.entries().into_iter().filter(|e| e.label != label).collect();
        group.save(&entries)?;
        group.pets.retain(|p| p.entry.label != label);
    }
    if let Some(window) = app.get_webview_window(label) { window.destroy().map_err(|e| e.to_string())?; }
    // Wait outside the UI thread and all mutexes before offering this slot again.
    let app = app.clone(); let label = label.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        for _ in 0..100 {
            if app.get_webview_window(&label).is_none() { return Ok(()); }
            std::thread::sleep(StdDuration::from_millis(20));
        }
        Err("宠物窗口正在关闭，请稍后重试".to_string())
    }).await.map_err(|e|e.to_string())?
}
pub fn end_drag(app: &tauri::AppHandle, label: &str) -> Result<(), String> {
    let state = app.state::<Mutex<Companions>>();
    let mut group = state.lock().unwrap();
    let Some(index) = group.pets.iter().position(|p| p.entry.label == label) else { return Ok(()); };
    if group.pets[index].drag.take().is_none() { return Ok(()); }
    let mut entries = group.entries();
    entries[index].position = Some(group.pets[index].position);
    let saved = group.save(&entries);
    if saved.is_ok() { group.pets[index].entry = entries[index].clone(); }
    drop(group);
    let _ = app.emit_to(label, "drag-ended", Value::Null);
    saved
}
pub fn heartbeat(app: &tauri::AppHandle) {
    let (scale, _, visible) = settings(app);
    if !visible { return; }
    for label in labels(app) {
        let Some(window) = app.get_webview_window(&label) else { continue; };
        let pointer = cursor(app, &window);
        let (movement, position) = {
            let state = app.state::<Mutex<Companions>>();
            let group = state.lock().unwrap();
            let Some(p) = group.pets.iter().find(|p| p.entry.label == label) else { continue; };
            (p.drag.as_ref().map(|d| (d.cursor, d.anchor, d.time)), p.position)
        };
        if let Some((start, anchor, time)) = movement {
            if time.elapsed() > StdDuration::from_secs(30) { let _ = end_drag(app, &label); continue; }
            let a = area(app, Some(pointer));
            let next = Point { x: clamp(anchor.x + pointer.x-start.x, a.x, a.x+a.width-144.0*scale),
                y: clamp(anchor.y + pointer.y-start.y, a.y, a.y+a.height-156.0*scale) };
            if window.set_position(tauri::LogicalPosition::new(next.x.round(), next.y.round())).is_ok() {
                if let Some(p) = app.state::<Mutex<Companions>>().lock().unwrap().pets.iter_mut().find(|p| p.entry.label == label) { p.position = next; }
            }
        } else {
            let point = Point { x: pointer.x-position.x, y: pointer.y-position.y };
            let send = {
                let state = app.state::<Mutex<Companions>>();
                let mut group = state.lock().unwrap();
                let Some(p) = group.pets.iter_mut().find(|p| p.entry.label == label) else { continue; };
                let changed = p.pointer.is_none_or(|old| old.x != point.x || old.y != point.y) || p.last_hit.elapsed() >= StdDuration::from_millis(150);
                if changed { p.pointer = Some(point); p.last_hit = Instant::now(); }
                changed
            };
            if send { let _ = app.emit_to(&label, "pointer", point); }
        }
    }
}
pub fn call(app: &tauri::AppHandle, window: &WebviewWindow, channel: &str, input: Value) -> Result<Value, String> {
    let label = window.label();
    #[cfg(debug_assertions)]
    if channel == "smoke-report" && !smoke_script().is_empty() {
        let dir = app.state::<Mutex<Companions>>().lock().unwrap().dir.clone();
        fs::write(dir.join(format!("smoke-{label}.json")), serde_json::to_vec_pretty(&input).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        return Ok(Value::Null);
    }
    if channel == "show-panel" { panel(app, "home"); return Ok(Value::Null); }
    if channel == "frontend-ready" { startup_stage(&format!("frontend ready: {label}")); return Ok(Value::Null); }
    if channel == "drag-end" { end_drag(app, label)?; return Ok(Value::Null); }
    let (scale, reduced, visible) = settings(app);
    let point = cursor(app, window);
    let state = app.state::<Mutex<Companions>>();
    let mut group = state.lock().unwrap();
    let p = group.pets.iter_mut().find(|p| p.entry.label == label).ok_or("宠物已移出")?;
    match channel {
        "init" => Ok(json!({"name":p.pet.name,"image":p.pet.image_url(),"scale":scale,"reduced":reduced,"visible":visible})),
        "drag-start" => {
            p.drag = Some(Drag { cursor: point, anchor: p.position, time: Instant::now() });
            p.ignore_mouse = false;
            drop(group);
            window.set_ignore_cursor_events(false).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "hit-test" => {
            let ignore = !input.as_bool().ok_or("参数无效")?;
            let changed = p.drag.is_none() && ignore != p.ignore_mouse;
            if changed { p.ignore_mouse = ignore; }
            drop(group);
            if changed { window.set_ignore_cursor_events(ignore).map_err(|e| e.to_string())?; }
            Ok(Value::Null)
        }
        _ => Err("不允许的请求来源".into()),
    }
}

#[cfg(debug_assertions)]
pub fn smoke_state(app: &tauri::AppHandle) -> Value {
    let state = app.state::<Mutex<Companions>>();
    let group = state.lock().unwrap();
    let restored = Companions::load(group.dir.clone());
    json!({"pets":group.pets.iter().map(|p| json!({"id":p.entry.label,"position":p.position,"saved":p.entry.position,
        "frontend":fs::read(group.dir.join(format!("smoke-{}.json",p.entry.label))).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok())})).collect::<Vec<_>>(),
        "restored":restored.entries()})
}
#[cfg(debug_assertions)]
pub fn smoke_drag(app: &tauri::AppHandle, label: &str) -> Result<(), String> {
    let window = app.get_webview_window(label).ok_or("Missing companion")?;
    call(app, &window, "drag-start", Value::Null)?;
    if let Some(p) = app.state::<Mutex<Companions>>().lock().unwrap().pets.iter_mut().find(|p| p.entry.label == label) {
        if let Some(drag) = p.drag.as_mut() { drag.anchor.x -= 35.0; }
    }
    heartbeat(app);
    end_drag(app,label)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selection_and_positions_survive_restart_without_changing_main_pet() {
        let dir = std::env::temp_dir().join(format!("petdesk-companions-{}",uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        // Metadata-reader fixture; real WebP decoding is covered in window smoke tests.
        let mut image = vec![0u8;30];
        image[..4].copy_from_slice(b"RIFF"); image[8..12].copy_from_slice(b"WEBP");
        image[12..16].copy_from_slice(b"VP8X"); image[16..20].copy_from_slice(&10u32.to_le_bytes());
        image[24..27].copy_from_slice(&[255,5,0]); image[27..30].copy_from_slice(&[79,7,0]);
        let pet = Pet { name:"Companion".into(), description:String::new(), version:1, image:image.into(),source:"fixture".into() };
        pets::commit(&dir,&pet).unwrap();
        let original = fs::read(dir.join("selected-pet.json")).unwrap();
        let (directory, _) = pets::store_asset(&dir,&pet).unwrap();
        let group = Companions::load(dir.clone());
        let entries = vec![Entry {label:"pet-2".into(),directory:directory.clone(),position:Some(Point{x:42.0,y:86.0})},
            Entry {label:"pet-3".into(),directory,position:Some(Point{x:-250.0,y:300.0})}];
        group.save(&entries).unwrap();
        let reloaded = Companions::load(dir.clone());
        assert_eq!(reloaded.pets.len(),2);
        assert_eq!(reloaded.pets[0].position.x,42.0);
        assert_eq!(reloaded.pets[1].position.x,-250.0);
        reloaded.save(&entries[..1]).unwrap();
        assert_eq!(Companions::load(dir.clone()).pets.len(),1);
        assert_eq!(fs::read(dir.join("selected-pet.json")).unwrap(),original);
        assert!(std::sync::Arc::ptr_eq(&reloaded.pets[0].pet.image,&reloaded.pets[1].pet.image));
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn slots_reject_duplicates_traversal_and_fourth_pet() {
        let entry = |label: &str| Entry { label: label.into(), directory: "pet-import-123-abcd".into(), position: None };
        assert!(valid_entries(&[entry("pet-2"), entry("pet-3")]));
        assert!(!valid_entries(&[entry("pet-2"), entry("pet-2")]));
        assert!(!valid_entries(&[entry("pet-4")]));
        let mut bad = entry("pet-2"); bad.directory = "pet-import-../../outside".into();
        assert!(!valid_entries(&[bad]));
    }
}
