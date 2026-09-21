const lines = [
  '屏幕不会跑，先让眼睛下个班。',
  '再盯下去，像素都要认识你了。',
  '眼睛申请带薪休息，请老板批准。',
  '起来走两步，别让椅子以为你俩焊上了。',
  '窗外有免费超清画质，去看看？',
  '先离开屏幕，我替你盯着进度条。',
  '你的眼睛不是永动机，歇会儿再营业。',
  '工作可以等等，眨眼不要排期。'
];

// Counts local computer activity, never reads screen contents or camera data.
class EyeBreak {
  constructor(now = performance.now()) { this.index = -1; this.reset(now); }
  reset(now = performance.now()) { this.last = now; this.elapsed = 0; this.pending = null; this.snoozeMs = 0; }
  show() {
    if (this.pending) return false;
    this.index = (this.index + 1) % lines.length;
    this.pending = { title: lines[this.index], hint: '离开屏幕，看看远处，也活动一下。' };
    return true;
  }
  action(action, now = performance.now()) {
    if (!['done', 'snooze'].includes(action)) throw new Error('不支持的护眼提醒操作');
    this.reset(now);
    if (action === 'snooze') this.snoozeMs = 5 * 60000;
  }
  tick({ enabled, minutes, quiet, idleSeconds }, now = performance.now()) {
    const delta = Math.max(0, now - this.last); this.last = now;
    if (!enabled || idleSeconds >= 120 || delta > 10000) {
      const changed = !!this.pending; this.reset(now); return changed;
    }
    if (quiet || idleSeconds >= 60 || this.pending) return false;
    this.elapsed += delta;
    if (this.elapsed >= (this.snoozeMs || minutes * 60000)) return this.show();
    return false;
  }
}
module.exports = { EyeBreak, lines };
