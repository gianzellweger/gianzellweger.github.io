// history.js
// Renders the move list in the side panel.
// Tracks move pairs (white + black) and appends incrementally.

export default class History {
  constructor(listElId) {
    this._el  = document.getElementById(listElId);
    this._log = []; // { san, isWhite }
    this.clear();
  }

  clear() {
    this._log = [];
    if (this._el) this._el.innerHTML = '<span style="color:#1e1e1e">No moves yet</span>';
  }

  push(san, isWhiteMove) {
    this._log.push({ san, isWhite: isWhiteMove });
    if (this._log.length === 1) this._el.innerHTML = '';

    if (isWhiteMove) {
      const n  = this._log.filter(m => m.isWhite).length;
      const div = document.createElement('div');
      div.className = 'mp';
      div.id        = 'mp' + n;
      div.innerHTML =
        '<span class="mn">' + n + '.</span>' +
        '<span class="mw">' + san + '</span>' +
        '<span class="mb">\u2026</span>';
      this._el.appendChild(div);
    } else {
      const wCount = this._log.filter(m => m.isWhite).length;
      const pair   = document.getElementById('mp' + wCount);
      if (pair) {
        pair.querySelector('.mb').textContent = san;
      } else {
        // Black opened (shouldn't normally happen in this game, but handle gracefully)
        const div = document.createElement('div');
        div.className = 'mp';
        div.innerHTML =
          '<span class="mn">…</span>' +
          '<span class="mw"></span>' +
          '<span class="mb">' + san + '</span>';
        this._el.appendChild(div);
      }
    }

    this._el.scrollTop = this._el.scrollHeight;
  }
}
