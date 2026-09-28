export class Sprite {
  constructor(canvas, imageUrl) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d', { willReadFrequently: true });
    canvas.width = 192; canvas.height = 208;
    this.action = 'idle'; this.frame = 0; this.reduced = false;
    this.rows = { idle: 0, 'running-right': 1, 'running-left': 2, waving: 3, jumping: 4, failed: 5, waiting: 6, running: 7, review: 8 };
    this.ready = new Promise((resolve, reject) => {
      this.finishLoading = resolve;
      this.image = new Image();
      this.image.onload = () => {
        if (this.destroyed) { resolve(this); return; }
        const probe = document.createElement('canvas'); probe.width = 192; probe.height = 208;
        const ctx = probe.getContext('2d', { willReadFrequently: true });
        this.frameCanvas = probe; this.frameContext = ctx;
        this.frames = Array.from({ length: 9 }, (_, row) => {
          const occupied = [];
          for (let col = 0; col < 8; col++) {
            // V2 uses row 0 column 6 for a look pose, not for the idle loop.
            if (row === 0 && this.image.height === 2288 && col >= 6) continue;
            ctx.clearRect(0, 0, 192, 208); ctx.drawImage(this.image, col * 192, row * 208, 192, 208, 0, 0, 192, 208);
            const pixels = ctx.getImageData(0, 0, 192, 208).data;
            let count = 0;
            for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 24) count++;
            if (count > 30) occupied.push(col);
          }
          return occupied.length ? occupied : [0];
        });
        this.draw(); this.timer = setInterval(() => this.advance(), 150); resolve(this);
      };
      this.image.onerror = () => reject(new Error('宠物图片无法解码，请重新导入有效宠物包'));
      this.image.src = imageUrl;
    });
  }
  play(action, duration = 0) {
    if (!(action in this.rows)) action = 'idle';
    if (this.action !== action) { this.action = action; this.frame = 0; }
    this.until = duration ? Date.now() + duration : 0;
    if (this.frames) this.draw();
  }
  advance() {
    if (this.until && Date.now() >= this.until) this.play('idle');
    if (this.reduced || this.paused || (document.hidden && !this.keepAnimating)) return;
    this.frame = (this.frame + 1) % this.frames[this.rows[this.action]].length;
    this.draw();
  }
  draw() {
    if (this.destroyed) return;
    const row = this.rows[this.action]; const col = this.frames[row][this.reduced ? 0 : this.frame] ?? 0;
    // Reuse one isolated frame instead of retaining every frame in the atlas.
    // The 1:1 crop still prevents filtering from sampling adjacent atlas cells.
    this.frameContext.clearRect(0, 0, 192, 208);
    this.frameContext.drawImage(this.image, col * 192, row * 208, 192, 208, 0, 0, 192, 208);
    this.context.globalCompositeOperation = 'copy';
    this.context.drawImage(this.frameCanvas, 0, 0);
    this.context.globalCompositeOperation = 'source-over';
  }
  hit(x, y) {
    const box = this.canvas.getBoundingClientRect();
    if (!box.width || x < box.left || y < box.top || x >= box.right || y >= box.bottom) return false;
    return this.context.getImageData(Math.floor((x - box.left) / box.width * 192), Math.floor((y - box.top) / box.height * 208), 1, 1).data[3] > 24;
  }
  destroy() {
    this.destroyed = true; clearInterval(this.timer);
    this.image.onload = this.image.onerror = null;
    this.image.src = '';
    if (this.frameCanvas) this.frameCanvas.width = this.frameCanvas.height = 0;
    this.frameCanvas = this.frameContext = this.frames = null;
    this.finishLoading?.(this); this.finishLoading = null;
  }
}
