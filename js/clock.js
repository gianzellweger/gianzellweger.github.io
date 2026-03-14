// clock.js
// Manages two chess clocks (white and black).
// Call tick() at fixed intervals; read wTime / bTime for display.

export default class Clock {
  /**
   * @param {number} seconds  Starting time in seconds. 0 = unlimited.
   * @param {function} onTick   Called every 100 ms with { wTime, bTime, active }
   * @param {function} onFlag   Called with 'w' or 'b' when a clock hits zero.
   */
  constructor(seconds, onTick, onFlag) {
    this._total   = seconds;
    this._onTick  = onTick;
    this._onFlag  = onFlag;
    this._iv      = null;
    this._active  = null; // 'w' | 'b' | null

    this.wTime    = seconds || Infinity;
    this.bTime    = seconds || Infinity;
    this.unlimited = (seconds === 0);
  }

  start(color) {
    this.stop();
    if (this.unlimited) { this._active = color; this._onTick(this._snapshot()); return; }
    this._active = color;
    this._onTick(this._snapshot());
    this._iv = setInterval(() => {
      if (this._active === 'w') this.wTime = Math.max(0, this.wTime - 0.1);
      else                      this.bTime = Math.max(0, this.bTime - 0.1);
      this._onTick(this._snapshot());
      const t = this._active === 'w' ? this.wTime : this.bTime;
      if (t === 0) { this.stop(); this._onFlag(this._active); }
    }, 100);
  }

  stop() {
    if (this._iv) { clearInterval(this._iv); this._iv = null; }
    this._active = null;
  }

  active() { return this._active; }

  _snapshot() {
    return { wTime: this.wTime, bTime: this.bTime, active: this._active, unlimited: this.unlimited };
  }

  /** Format seconds as M:SS, always flooring so 300.0 → "5:00" not "4:60". */
  static fmt(seconds) {
    if (!isFinite(seconds)) return '∞';
    const total = Math.floor(seconds);
    const m     = Math.floor(total / 60);
    const s     = total % 60;
    return m + ':' + String(s).padStart(2, '0');
  }
}
