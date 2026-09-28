use chrono::{ DateTime, Datelike, Duration, Local, NaiveTime, TimeZone, Utc };
use serde::{ Deserialize, Serialize };
use std::{ collections::HashSet, fs, io::Write, path::PathBuf };
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dock {
    pub side: String,
    pub display_id: String,
    pub y: f64,
    pub center_ratio: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub quiet: bool,
    pub sound: bool,
    pub reduced_motion: bool,
    pub scale: f64,
    pub eye_break: bool,
    pub eye_minutes: u32,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            quiet: false,
            sound: false,
            reduced_motion: false,
            scale: 0.6,
            eye_break: true,
            eye_minutes: 30,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Repeat {
    pub days: Vec<u32>,
    pub hour: u32,
    pub minute: u32,
    pub lead_minutes: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    pub id: String,
    pub title: String,
    pub meeting_at: String,
    pub due_at: String,
    pub status: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repeat: Option<Repeat>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub series_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedState {
    pub version: u32,
    pub settings: Settings,
    pub position: Option<Point>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pet_position: Option<Point>,
    pub dock: Option<Dock>,
    pub reminders: Vec<Reminder>,
}
impl Default for SavedState {
    fn default() -> Self {
        Self {
            version: 1,
            settings: Settings::default(),
            position: None,
            pet_position: None,
            dock: None,
            reminders: Vec::new(),
        }
    }
}

fn date(value: &str) -> Result<DateTime<Utc>, String> {
    DateTime::parse_from_rfc3339(value)
        .map(|d| d.with_timezone(&Utc))
        .map_err(|_| "提醒时间格式无效".into())
}
fn validate(state: &SavedState) -> Result<(), String> {
    if state.version != 1 || state.reminders.len() > 500 {
        return Err("不支持的本地数据格式".into());
    }
    if
        ![0.45, 0.6, 0.8, 1.0, 1.2].contains(&state.settings.scale) ||
        !(5..=180).contains(&state.settings.eye_minutes)
    {
        return Err("设置数据无效".into());
    }
    let mut ids = HashSet::new();
    for r in &state.reminders {
        if
            !ids.insert(&r.id) ||
            r.title.trim().is_empty() ||
            r.title.chars().count() > 100 ||
            !["pending", "active", "done"].contains(&r.status.as_str())
        {
            return Err("提醒数据损坏".into());
        }
        date(&r.meeting_at)?;
        date(&r.due_at)?;
        if let Some(rule) = &r.repeat {
            if
                rule.days.is_empty() ||
                rule.days.iter().any(|d| *d > 6) ||
                rule.hour > 23 ||
                rule.minute > 59 ||
                rule.lead_minutes > 1440
            {
                return Err("固定会议规则无效".into());
            }
        }
    }
    Ok(())
}

pub struct Store {
    pub dir: PathBuf,
    pub state: SavedState,
    pub warning: String,
}
impl Store {
    pub fn load(dir: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let file = dir.join("state.json");
        let mut store = Self { dir, state: SavedState::default(), warning: String::new() };
        if file.exists() {
            match
                fs
                    ::read(&file)
                    .map_err(|e| e.to_string())
                    .and_then(|bytes|
                        serde_json::from_slice::<SavedState>(&bytes).map_err(|e| e.to_string())
                    )
                    .and_then(|s| {
                        validate(&s)?;
                        Ok(s)
                    })
            {
                Ok(s) => {
                    store.state = s;
                }
                Err(_) => {
                    let backup_name = format!(
                        "state.corrupt-{}.json",
                        Utc::now().timestamp_millis()
                    );
                    fs
                        ::copy(&file, store.dir.join(backup_name))
                        .map_err(|e| format!("无法保留损坏数据：{e}"))?;
                    let backup = fs
                        ::read(store.dir.join("state.json.bak"))
                        .ok()
                        .and_then(|b| serde_json::from_slice::<SavedState>(&b).ok())
                        .filter(|s| validate(s).is_ok());
                    if let Some(s) = backup {
                        store.state = s;
                        store.warning =
                            "本地数据异常，已从备份恢复。原文件已保留，请检查会议列表。".into();
                    } else {
                        store.warning =
                            "本地数据无法读取，原文件已保留。请重新检查并设置会议提醒。".into();
                    }
                }
            }
        }
        // Older versions could persist a collapsed edge tab. Always restore a floating pet.
        if store.state.dock.is_some() {
            store.update(|state| { state.dock = None; Ok(()) })?;
        }
        Ok(store)
    }
    pub fn update<F>(&mut self, change: F) -> Result<(), String>
        where F: FnOnce(&mut SavedState) -> Result<(), String>
    {
        let mut next = self.state.clone();
        change(&mut next)?;
        validate(&next)?;
        let file = self.dir.join("state.json");
        let temp = self.dir.join("state.json.tmp");
        let data = serde_json::to_vec_pretty(&next).map_err(|e| e.to_string())?;
        let mut output = fs::OpenOptions
            ::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        output.write_all(&data).map_err(|e| e.to_string())?;
        output.sync_all().map_err(|e| e.to_string())?;
        drop(output);
        if file.exists() {
            let valid_old = fs
                ::read(&file)
                .ok()
                .and_then(|b| serde_json::from_slice::<SavedState>(&b).ok())
                .is_some_and(|s| validate(&s).is_ok());
            if valid_old {
                fs::copy(&file, self.dir.join("state.json.bak")).map_err(|e| e.to_string())?;
            }
        }
        replace_file(&temp, &file)?;
        self.state = next;
        Ok(())
    }
}

#[cfg(windows)]
pub(crate) fn replace_file(temp: &std::path::Path, file: &std::path::Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW,
        MOVEFILE_REPLACE_EXISTING,
        MOVEFILE_WRITE_THROUGH,
    };
    let from: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = file.as_os_str().encode_wide().chain(Some(0)).collect();
    let ok = unsafe {
        MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)
    };
    if ok == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}
#[cfg(not(windows))]
pub(crate) fn replace_file(temp: &std::path::Path, file: &std::path::Path) -> Result<(), String> {
    fs::rename(temp, file).map_err(|e| e.to_string())
}

pub fn make_reminder(input: &serde_json::Value) -> Result<Reminder, String> {
    let title = input
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if title.is_empty() || title.chars().count() > 100 {
        return Err("请输入 1～100 字的会议名称".into());
    }
    let meeting = date(
        input
            .get("meetingAt")
            .and_then(|v| v.as_str())
            .unwrap_or("")
    )?;
    let now = Utc::now();
    if meeting <= now {
        return Err("请选择未来的会议时间".into());
    }
    let lead = input
        .get("leadMinutes")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    if !(0..=1440).contains(&lead) {
        return Err("提前提醒时间应为 0～1440 分钟".into());
    }
    let id = Uuid::new_v4().to_string();
    let mut reminder = Reminder {
        id: id.clone(),
        title: title.into(),
        meeting_at: meeting.to_rfc3339(),
        due_at: std::cmp::max(now, meeting - Duration::minutes(lead)).to_rfc3339(),
        status: "pending".into(),
        created_at: now.to_rfc3339(),
        repeat: None,
        series_id: None,
    };
    if let Some(days) = input.get("repeatDays").filter(|v| !v.is_null()) {
        let Some(items) = days.as_array() else {
            return Err("固定会议规则无效".into());
        };
        let mut days: Vec<u32> = items
            .iter()
            .map(|v|
                v
                    .as_u64()
                    .filter(|n| *n <= 6)
                    .map(|n| n as u32)
                    .ok_or("固定会议规则无效".to_string())
            )
            .collect::<Result<_, _>>()?;
        days.sort_unstable();
        days.dedup();
        let local = meeting.with_timezone(&Local);
        if days.is_empty() || !days.contains(&local.weekday().num_days_from_sunday()) {
            return Err("首次会议日期需要属于所选的重复星期".into());
        }
        reminder.repeat = Some(Repeat {
            days,
            hour: local.hour(),
            minute: local.minute(),
            lead_minutes: lead as u32,
        });
        reminder.series_id = Some(id);
    }
    Ok(reminder)
}

use chrono::Timelike;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn legacy_state_defaults_and_settings_validation() {
        let state: SavedState = serde_json::from_value(json!({
            "version":1,"settings":{"quiet":true},"position":null,"dock":null,"reminders":[]
        })).unwrap();
        validate(&state).unwrap();
        assert!(state.settings.quiet);
        assert_eq!(state.settings.scale, 0.6);
        assert!(state.settings.eye_break);
    }

    #[test]
    fn save_reopen_and_recover_backup() {
        let dir = std::env::temp_dir().join(format!("petdesk-store-test-{}", Uuid::new_v4()));
        let mut store = Store::load(dir.clone()).unwrap();
        store.update(|s| { s.settings.scale = 0.45; Ok(()) }).unwrap();
        store.update(|s| { s.settings.quiet = true; Ok(()) }).unwrap();
        assert!(Store::load(dir.clone()).unwrap().state.settings.quiet);
        assert!(store.update(|s| { s.settings.scale = 999.0; Ok(()) }).is_err());
        assert_eq!(store.state.settings.scale, 0.45);
        fs::write(dir.join("state.json"), b"broken").unwrap();
        let recovered = Store::load(dir.clone()).unwrap();
        assert_eq!(recovered.state.settings.scale, 0.45);
        assert!(!recovered.warning.is_empty());
        assert!(fs::read_dir(&dir).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().starts_with("state.corrupt-")));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn recurring_reminder_activates_once_and_schedules_future() {
        let now = Utc::now();
        let mut state = SavedState::default();
        let mut reminder = make_reminder(&json!({"title":"repeat", "meetingAt":(now + Duration::hours(1)).to_rfc3339(),"repeatDays":[0,1,2,3,4,5,6],"leadMinutes":0})).unwrap();
        reminder.meeting_at = (now - Duration::days(14)).to_rfc3339();
        reminder.due_at = reminder.meeting_at.clone();
        state.reminders.push(reminder);
        assert_eq!(activate_due(&mut state).unwrap().len(), 1);
        assert_eq!(state.reminders.len(), 2);
        assert!(date(&state.reminders[1].due_at).unwrap() > now);
        assert!(activate_due(&mut state).unwrap().is_empty());
    }
}

pub fn activate_due(state: &mut SavedState) -> Result<Vec<Reminder>, String> {
    let now = Utc::now();
    let mut due = Vec::new();
    let mut next = Vec::new();
    let mut pending_series: std::collections::HashMap<String, usize> = state.reminders
        .iter()
        .filter(|r| r.status == "pending")
        .filter_map(|r| r.series_id.clone())
        .fold(std::collections::HashMap::new(), |mut counts, id| {
            *counts.entry(id).or_default() += 1;
            counts
        });
    for r in &mut state.reminders {
        if r.status != "pending" || date(&r.due_at)? > now {
            continue;
        }
        r.status = "active".into();
        due.push(r.clone());
        if let Some(id) = &r.series_id {
            if let Some(count) = pending_series.get_mut(id) {
                *count -= 1;
            }
        }
        if let Some(rule) = &r.repeat {
            if
                pending_series
                    .get(r.series_id.as_deref().unwrap_or("__none__"))
                    .copied()
                    .unwrap_or(0) == 0
            {
                let after = std::cmp::max(
                    now + Duration::minutes(rule.lead_minutes as i64),
                    date(&r.meeting_at)?
                );
                let local_after = after.with_timezone(&Local);
                for offset in 0..9 {
                    let day = local_after.date_naive() + Duration::days(offset);
                    if !rule.days.contains(&day.weekday().num_days_from_sunday()) {
                        continue;
                    }
                    let time = NaiveTime::from_hms_opt(rule.hour, rule.minute, 0).ok_or(
                        "固定会议规则无效"
                    )?;
                    let candidate = Local.from_local_datetime(&day.and_time(time)).earliest();
                    if let Some(meeting) = candidate.filter(|d| *d > local_after) {
                        let mut future = r.clone();
                        future.id = Uuid::new_v4().to_string();
                        future.status = "pending".into();
                        future.meeting_at = meeting.with_timezone(&Utc).to_rfc3339();
                        future.due_at = (
                            meeting.with_timezone(&Utc) -
                            Duration::minutes(rule.lead_minutes as i64)
                        ).to_rfc3339();
                        future.created_at = now.to_rfc3339();
                        next.push(future);
                        break;
                    }
                }
            }
        }
    }
    if state.reminders.len() + next.len() > 500 {
        return Err("提醒记录已满，请清除已结束记录".into());
    }
    state.reminders.extend(next);
    Ok(due)
}

const EYE_LINES: [&str; 8] = [
    "屏幕不会跑，先让眼睛下个班。",
    "再盯下去，像素都要认识你了。",
    "眼睛申请带薪休息，请老板批准。",
    "起来走两步，别让椅子以为你俩焊上了。",
    "窗外有免费超清画质，去看看？",
    "先离开屏幕，我替你盯着进度条。",
    "你的眼睛不是永动机，歇会儿再营业。",
    "工作可以等等，眨眼不要排期。",
];
pub struct EyeBreak {
    pub pending: Option<serde_json::Value>,
    pub index: usize,
    pub elapsed: std::time::Duration,
    pub last: std::time::Instant,
    pub snooze: bool,
}
impl EyeBreak {
    pub fn new() -> Self {
        Self {
            pending: None,
            index: EYE_LINES.len() - 1,
            elapsed: std::time::Duration::ZERO,
            last: std::time::Instant::now(),
            snooze: false,
        }
    }
    pub fn reset(&mut self, snooze: bool) {
        self.pending = None;
        self.elapsed = std::time::Duration::ZERO;
        self.last = std::time::Instant::now();
        self.snooze = snooze;
    }
    pub fn show(&mut self) -> bool {
        if self.pending.is_some() {
            return false;
        }
        self.index = (self.index + 1) % EYE_LINES.len();
        self.pending = Some(
            serde_json::json!({"title": EYE_LINES[self.index], "hint": "离开屏幕，看看远处，也活动一下。"})
        );
        true
    }
    pub fn tick(&mut self, enabled: bool, quiet: bool, minutes: u32, idle_seconds: u64) -> bool {
        let now = std::time::Instant::now();
        let delta = now.duration_since(self.last);
        self.last = now;
        if !enabled || idle_seconds >= 120 || delta > std::time::Duration::from_secs(10) {
            let changed = self.pending.is_some();
            self.reset(false);
            return changed;
        }
        if quiet || idle_seconds >= 60 || self.pending.is_some() {
            return false;
        }
        self.elapsed += delta;
        if
            self.elapsed >=
            std::time::Duration::from_secs(if self.snooze { 300 } else { (minutes as u64) * 60 })
        {
            return self.show();
        }
        false
    }
}
