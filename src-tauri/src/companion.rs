use chrono::{Datelike, Local, NaiveDate, Timelike};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use crate::model::{Reminder, SavedState};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Companion {
    pub last_check_in: Option<NaiveDate>,
    pub streak: u32,
    pub total: u32,
    pub mood_enabled: bool,
    pub mood_minutes: u32,
    pub holiday_enabled: bool,
    pub last_holiday: Option<NaiveDate>,
}
impl Default for Companion {
    fn default() -> Self {
        Self { last_check_in: None, streak: 0, total: 0, mood_enabled: true,
            mood_minutes: 20, holiday_enabled: true, last_holiday: None }
    }
}
impl Companion {
    pub fn check_in(&mut self, today: NaiveDate) -> Result<bool, String> {
        if self.last_check_in == Some(today) { return Ok(false); }
        if self.last_check_in.is_some_and(|d| d > today) {
            return Err("本机日期早于上次签到，请检查系统日期".into());
        }
        self.streak = if self.last_check_in == today.pred_opt() { self.streak.saturating_add(1) } else { 1 };
        self.total = self.total.saturating_add(1);
        self.last_check_in = Some(today);
        Ok(true)
    }
}

pub const HOLIDAYS: [(u32, u32, &str); 7] = [
    (1, 1, "元旦"), (2, 14, "情人节"), (3, 8, "妇女节"),
    (5, 1, "劳动节"), (6, 1, "儿童节"), (10, 1, "国庆节"), (12, 25, "圣诞节"),
];
pub fn holidays() -> Value {
    json!(HOLIDAYS.iter().map(|(month, day, title)| json!({"month":month,"day":day,"title":title})).collect::<Vec<_>>())
}
pub fn holiday_due(state: &SavedState, today: NaiveDate, hour: u32) -> Option<&'static str> {
    if !state.companion.holiday_enabled || hour < 9 || state.companion.last_holiday == Some(today) { return None; }
    HOLIDAYS.iter().find(|(m,d,_)| *m == today.month() && *d == today.day()).map(|(_,_,name)| *name)
}
pub fn enqueue_holiday(state: &mut SavedState) {
    let now = Local::now();
    if let Some(title) = holiday_due(state, now.date_naive(), now.hour()) {
        let time = now.to_rfc3339();
        state.reminders.push(Reminder { id: uuid::Uuid::new_v4().to_string(),
            title: format!("{title}快乐！小伙伴陪你过节。"), meeting_at: time.clone(),
            due_at: time.clone(), status: "pending".into(), created_at: time,
            repeat: None, series_id: None });
        state.companion.last_holiday = Some(now.date_naive());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn day(s: &str) -> NaiveDate { s.parse().unwrap() }
    #[test]
    fn streak_is_idempotent_and_crosses_year_boundary() {
        let mut c = Companion::default();
        assert!(c.check_in(day("2026-12-31")).unwrap());
        assert!(!c.check_in(day("2026-12-31")).unwrap());
        c.check_in(day("2027-01-01")).unwrap();
        assert_eq!((c.streak,c.total), (2,2));
        c.check_in(day("2027-01-03")).unwrap();
        assert_eq!((c.streak,c.total), (1,3));
        assert!(c.check_in(day("2027-01-02")).is_err());
    }
    #[test]
    fn holiday_delivery_respects_time_toggle_and_duplicate_marker() {
        let mut s = SavedState::default();
        let d = day("2027-01-01");
        assert_eq!(holiday_due(&s,d,9),Some("元旦"));
        assert_eq!(holiday_due(&s,d,8),None);
        s.companion.holiday_enabled = false;
        assert_eq!(holiday_due(&s,d,9),None);
        s.companion.holiday_enabled = true;
        s.companion.last_holiday = Some(d);
        assert_eq!(holiday_due(&s,d,12),None);
    }
}
