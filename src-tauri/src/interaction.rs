use super::*;

#[derive(Clone)]
pub struct Interaction {
    pub mode: String,
    pub home: Point,
    pub target: Point,
    pub started: Instant,
    pub last: Instant,
    pub near_since: Option<Instant>,
    pub phase: String,
    pub catches: u32,
}

pub fn wand_phase(near_seconds: f64) -> &'static str {
    match near_seconds.rem_euclid(3.2) {
        t if t < 0.4 => "waiting",
        t if t < 1.0 => "jumping",
        t if t < 1.8 => "waving",
        _ => "idle",
    }
}

pub fn step(from: Point, to: Point, distance: f64) -> (Point, bool) {
    let dx = to.x - from.x;
    let dy = to.y - from.y;
    let length = dx.hypot(dy);
    if length <= distance.max(0.0) || length < 0.5 { return (to, true); }
    let ratio = distance.max(0.0) / length;
    (Point { x: from.x + dx * ratio, y: from.y + dy * ratio }, false)
}

pub fn stop(app: &tauri::AppHandle, restore_home: bool) {
    let active = app.state::<Mutex<Backend>>().lock().unwrap().interaction.take().is_some();
    if let Some(toy) = app.get_webview_window("toy") { let _ = toy.hide(); }
    if !active { return; }
    if restore_home { let _ = restore(app); }
    let _ = app.emit_to("pet", "motion", json!({"moving":false,"action":"idle"}));
    broadcast(app);
}

pub fn start(app: &tauri::AppHandle, mode: &str) -> Result<(), String> {
    if !["wand", "ball", "follow", "stop"].contains(&mode) { return Err("未知互动模式".into()); }
    stop(app, true);
    if mode == "stop" { return Ok(()); }
    let state = app.state::<Mutex<Backend>>();
    if state.lock().unwrap().pet.is_none() { return Err("请先导入一位小伙伴".into()); }
    let _ = end_drag(app);
    show_pet(app);
    let window = app.get_webview_window("pet").ok_or("桌宠窗口不存在")?;
    let p = cursor(app, &window);
    let mut b = state.lock().unwrap();
    let home = Point { x: b.layout["anchor"]["x"].as_f64().unwrap_or(0.0), y: b.layout["anchor"]["y"].as_f64().unwrap_or(0.0) };
    b.interaction = Some(Interaction { mode: if mode == "ball" { "place" } else { mode }.into(), home, target: p, started: Instant::now(), last: Instant::now(), near_since: None, phase: String::new(), catches: 0 });
    drop(b);
    if let Some(panel) = app.get_webview_window("panel") { let _ = panel.hide(); }
    if mode == "wand" || mode == "ball" {
        let toy = match ensure_toy(app) {
            Ok(toy) => toy,
            Err(error) => { stop(app, true); return Err(error); }
        };
        if mode == "ball" {
            let a = area(app, Some(p));
            set_window(&toy, a.x, a.y, a.width, a.height)?;
            toy.set_ignore_cursor_events(false).map_err(|e| e.to_string())?;
            toy.set_focusable(true).map_err(|e| e.to_string())?;
            let _ = app.emit_to("toy", "toy-mode", "place");
            toy.show().map_err(|e| e.to_string())?;
            let _ = toy.set_focus();
        } else if mode == "wand" {
            set_window(&toy, p.x + 12.0, p.y + 12.0, 96.0, 96.0)?;
            toy.set_ignore_cursor_events(true).map_err(|e| e.to_string())?;
            let _ = app.emit_to("toy", "toy-mode", "wand");
            let _ = toy.show();
        }
    }
    broadcast(app);
    Ok(())
}

pub fn place(app: &tauri::AppHandle, window: &WebviewWindow, input: &Value) -> Result<(), String> {
    let x = input["x"].as_f64().filter(|v| v.is_finite()).ok_or("球的位置无效")?;
    let y = input["y"].as_f64().filter(|v| v.is_finite()).ok_or("球的位置无效")?;
    let pos = window_point(window);
    let a = area(app, Some(pos));
    let state = app.state::<Mutex<Backend>>();
    let mut b = state.lock().unwrap();
    let scale = b.store.state.settings.scale;
    let session = b.interaction.as_mut().ok_or("请先选择放球")?;
    if session.mode != "place" { return Err("当前不在放球模式".into()); }
    // Keep the mouth and the toy reachable at every edge of the work area.
    session.target = Point { x: clamp(pos.x + x - 72.0 * scale, a.x, a.x + a.width - 144.0 * scale), y: clamp(pos.y + y - 110.0 * scale, a.y, a.y + a.height - 156.0 * scale) };
    let target = session.target;
    session.mode = "fetch".into();
    session.last = Instant::now();
    drop(b);
    window.set_ignore_cursor_events(true).map_err(|e| e.to_string())?;
    window.set_focusable(false).map_err(|e| e.to_string())?;
    set_window(window, target.x + 72.0 * scale - 16.0, target.y + 110.0 * scale - 16.0, 32.0, 32.0)?;
    let _ = app.emit_to("toy", "toy-mode", "ball");
    broadcast(app);
    Ok(())
}

pub fn tick(app: &tauri::AppHandle, pointer: Point) -> bool {
    let state = app.state::<Mutex<Backend>>();
    let (session, from, scale) = {
        let b = state.lock().unwrap();
        let Some(session) = b.interaction.clone() else { return false; };
        (session, Point { x: b.layout["anchor"]["x"].as_f64().unwrap_or(0.0), y: b.layout["anchor"]["y"].as_f64().unwrap_or(0.0) }, b.store.state.settings.scale)
    };
    #[cfg(windows)]
    let escape = unsafe { windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(0x1B) < 0 };
    #[cfg(not(windows))]
    let escape = false;
    if escape || session.started.elapsed() > StdDuration::from_secs(300) { stop(app, true); return true; }
    if session.mode == "place" { return true; }
    let chasing = session.mode == "wand" || session.mode == "follow";
    let goal = if session.mode == "wand" { Point { x: pointer.x + 54.0 - 72.0 * scale, y: pointer.y + 62.0 - 78.0 * scale } }
        else if chasing { Point { x: pointer.x - 72.0 * scale, y: pointer.y - 78.0 * scale } }
        else if session.mode == "return" { session.home } else { session.target };
    let a = area(app, Some(if chasing { pointer } else { goal }));
    let goal = Point { x: clamp(goal.x, a.x, a.x + a.width - 144.0 * scale), y: clamp(goal.y, a.y, a.y + a.height - 156.0 * scale) };
    let distance = (goal.x - from.x).hypot(goal.y - from.y);
    let close = chasing && distance < if session.mode == "wand" { 24.0 } else { 45.0 };
    let (next, arrived) = if close { (from, true) } else { step(from, goal, 240.0 * session.last.elapsed().as_secs_f64().min(0.1)) };
    if move_pet(app, next, scale).is_err() { stop(app, true); return true; }
    let action = if close { if session.mode == "wand" { wand_phase(session.near_since.map(|t| t.elapsed().as_secs_f64()).unwrap_or(0.0)) } else { "idle" } }
        else if next.x < from.x { "running-left" } else { "running-right" };
    let _ = app.emit_to("pet", "motion", json!({"moving":true,"action":action}));
    if let Some(toy) = app.get_webview_window("toy") {
        let point = if session.mode == "wand" { Some(Point { x: pointer.x + 12.0, y: pointer.y + 12.0 }) }
            else if session.mode == "return" { Some(Point { x: next.x + 72.0 * scale - 16.0, y: next.y + 110.0 * scale - 16.0 }) } else { None };
        if let Some(point) = point { let _ = toy.set_position(tauri::LogicalPosition::new(point.x, point.y)); }
    }
    if arrived && session.mode == "return" { stop(app, true); return true; }
    let mut b = state.lock().unwrap();
    let mut changed = false;
    let reduced = b.store.state.settings.reduced_motion;
    let mut feedback = None;
    if let Some(current) = b.interaction.as_mut() {
        current.last = Instant::now();
        if current.mode == "wand" {
            if close { current.near_since.get_or_insert_with(Instant::now); } else { current.near_since = None; }
            if action != current.phase {
                if action == "waving" { current.catches += 1; }
                feedback = Some(json!({"phase":action,"catches":current.catches,"reduced":reduced}));
                current.phase = action.into();
            }
        }
        if arrived && current.mode == "fetch" { current.mode = "return".into(); changed = true; }
    }
    drop(b);
    if let Some(value) = feedback { let _ = app.emit_to("toy", "toy-feedback", value); }
    if changed { broadcast(app); }
    false // Keep hit-testing alive so dragging can interrupt play.
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wand_has_windup_pounce_reward_and_rest() {
        assert_eq!(wand_phase(0.0), "waiting");
        assert_eq!(wand_phase(0.6), "jumping");
        assert_eq!(wand_phase(1.2), "waving");
        assert_eq!(wand_phase(2.0), "idle");
        assert_eq!(wand_phase(3.3), "waiting");
    }
    #[test]
    fn movement_is_bounded_and_returns_exactly_home() {
        let home = Point { x: -200.0, y: 100.0 };
        let ball = Point { x: 300.0, y: 250.0 };
        let (next, arrived) = step(home, ball, 12.0);
        assert!(!arrived);
        assert!(((next.x-home.x).hypot(next.y-home.y)-12.0).abs() < 0.001);
        let (returned, arrived) = step(next, home, 15.0);
        assert!(arrived);
        assert_eq!((returned.x, returned.y), (home.x, home.y));
    }
}
